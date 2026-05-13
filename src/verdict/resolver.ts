import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  HORIZONS_HOURS,
  OracleFeed,
  Outcome,
  T0Policy,
  UsageEvent,
} from "./schema.js";
import {
  anchorsRepo,
  marketsRepo,
  resolutionsRepo,
  submissionsRepo,
  usageRepo,
} from "./db.js";
// Wave 3b — loadResolutionSubject import dropped. The legacy plaintext +
// committed-mode resolver branch that called it was deleted; FHE-direct
// rows never went through that path (they have no plaintext to load).
import {
  OracleClient,
  OracleError,
  type OracleObservation,
} from "../integrations/oracle.js";
import { observeOracle } from "../integrations/oracles/registry.js";
import {
  AdapterError,
  type OracleObservation as AdapterObservation,
} from "../integrations/oracles/types.js";
import { derivePolicyFromMarket, feedToOracleId } from "./oracle-routing.js";

// ─── Env knobs ──────────────────────────────────────────────────────────────
//
// MURMUR_V2_RESOLVER_DISABLED — kill switch for the additive v2 dual-write
// path (computeV2OutcomePath). When set to "1", the resolver skips the v2
// computation entirely and writes only the legacy resolution receipt /
// columns. Intended for emergency rollback if production data exposes a
// bad adapter / commitment shape AFTER deploy. Default: v2 path runs but
// is wrapped in try/catch — a throw in v2 is logged and the legacy
// transaction still proceeds (BLOCKER #1 isolation guarantee).

// ─── Public types ────────────────────────────────────────────────────────────

export interface ResolverDeps {
  db: Database.Database;
  oracle: OracleClient;
  now?: () => Date;
  /** Test hook so we can drive logs assertively; default no-op. */
  log?: (line: ResolverLogEvent) => void;
  /** Called for every call that becomes terminal (resolved, oracle_unavailable). */
  onResolved?: (call_id: string) => void | Promise<void>;
  // Wave 2b — ageContext + drandContext removed alongside the
  // committed-mode envelope decrypt path. FHE-direct rows never
  // needed them; legacy plaintext rows have nothing to decrypt.
}

export type ResolverLogEvent =
  | { kind: "anchored_t0"; call_id: string; feed: OracleFeed; p0: string }
  | { kind: "anchored_t1"; call_id: string; feed: OracleFeed; p1: string; outcome: Outcome }
  | { kind: "oracle_unavailable"; call_id: string; phase: "t0" | "t1" }
  | { kind: "still_pending"; call_id: string; phase: "t0" | "t1"; reason: string }
  | { kind: "tick_summary"; anchored: number; resolved: number; oracle_unavailable: number };

export interface ResolverTickResult {
  anchored: number;
  resolved: number;
  oracle_unavailable: number;
}

// ─── Resolver ────────────────────────────────────────────────────────────────

export class Resolver {
  private readonly db: Database.Database;
  private readonly oracle: OracleClient;
  private readonly now: () => Date;
  private readonly log: (line: ResolverLogEvent) => void;
  private readonly onResolved: NonNullable<ResolverDeps["onResolved"]>;
  // Wave 2b — ageContext + drandContext fields removed.

  constructor(deps: ResolverDeps) {
    this.db = deps.db;
    this.oracle = deps.oracle;
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? (() => undefined);
    this.onResolved = deps.onResolved ?? (() => undefined);
    // Wave 2b — ageContext + drandContext init removed.
  }

  async tick(): Promise<ResolverTickResult> {
    const t0 = await this.runT0Phase();
    const t1 = await this.runT1Phase();
    const summary = {
      anchored: t0.anchored,
      resolved: t1.resolved,
      oracle_unavailable: t0.oracle_unavailable + t1.oracle_unavailable,
    };
    this.log({ kind: "tick_summary", ...summary });
    return summary;
  }

  // ── t0 anchoring ──

  private async runT0Phase(): Promise<{
    anchored: number;
    oracle_unavailable: number;
  }> {
    const candidates = [
      ...submissionsRepo.listPending(this.db, "accepted"),
      ...submissionsRepo.listPending(this.db, "pending_t0"),
    ];
    let anchored = 0;
    let oracleUnavailable = 0;
    for (const c of candidates) {
      const ctx = submissionsRepo.loadResolverContext(this.db, c.call_id);
      if (!ctx) continue;
      // Wave 3b BLOCKER fix — policyFromCtx now walks the markets registry
      // on every tick. A retired/deleted market or a half-configured
      // policy would previously throw out of the per-call loop and crash
      // the entire pass. Bound the throw to this call: log + route to
      // oracle_unavailable so the rest of the tick keeps making progress.
      let policy: T0Policy | null;
      try {
        policy = this.policyFromCtx(ctx);
      } catch (err) {
        this.log({
          kind: "still_pending",
          call_id: ctx.call_id,
          phase: "t0",
          reason: `policy_derivation_failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
        if (await this.markOracleUnavailable(ctx, "t0")) {
          oracleUnavailable++;
        }
        continue;
      }
      // Wave 4a — adapter-resolved markets (Polymarket Gamma + future
      // event-feed adapters) return null policy. They don't anchor
      // against a price feed at t0; the t1 path's adapter.observeResolution
      // dispatch is the only resolution surface. Skip the t0 anchor step
      // and move the call straight into pending_t1 so the t1 loop picks it
      // up next tick.
      if (policy === null) {
        if (ctx.status === "accepted") {
          submissionsRepo.setStatus(this.db, ctx.call_id, "pending_t1");
        }
        this.log({
          kind: "still_pending",
          call_id: ctx.call_id,
          phase: "t0",
          reason: "adapter_resolved_market:no_t0_anchor",
        });
        continue;
      }
      const outcome = await this.tryAnchor({
        call_id: ctx.call_id,
        mustBeAfterIso: ctx.accepted_at,
        elapsedSec: this.elapsedSecSince(ctx.accepted_at),
        policy,
        phase: "t0",
      });
      if (outcome.kind === "anchored") {
        anchorsRepo.setT0(this.db, {
          call_id: ctx.call_id,
          t0: outcome.observation.feed_timestamp,
          p0: outcome.observation.price,
          feed: outcome.observation.feed,
          source_id: outcome.observation.source_id,
          anchored_at: this.nowIso(),
        });
        submissionsRepo.setStatus(this.db, ctx.call_id, "pending_t1");
        anchored++;
        this.log({
          kind: "anchored_t0",
          call_id: ctx.call_id,
          feed: outcome.observation.feed,
          p0: outcome.observation.price,
        });
      } else if (outcome.kind === "oracle_unavailable") {
        if (await this.markOracleUnavailable(ctx, "t0")) {
          oracleUnavailable++;
        }
      } else {
        if (ctx.status === "accepted") {
          submissionsRepo.setStatus(this.db, ctx.call_id, "pending_t0");
        }
        this.log({
          kind: "still_pending",
          call_id: ctx.call_id,
          phase: "t0",
          reason: outcome.reason,
        });
      }
    }
    return { anchored, oracle_unavailable: oracleUnavailable };
  }

  // ── t1 resolution ──

  private async runT1Phase(): Promise<{
    resolved: number;
    oracle_unavailable: number;
  }> {
    const candidates = submissionsRepo.listPending(this.db, "pending_t1");
    let resolved = 0;
    let oracleUnavailable = 0;
    for (const c of candidates) {
      const ctx = submissionsRepo.loadResolverContext(this.db, c.call_id);
      if (!ctx) continue;

      // Wave 4a — adapter-resolved markets (Polymarket Gamma + future
      // event-feed adapters) never anchored at t0; runT0Phase moved them
      // to pending_t1 without a t0_anchors row. Here we route them
      // straight to the FHE-direct adapter-dispatch path, bypassing the
      // price-feed-anchored t1 observation. The Polymarket/Kalshi
      // adapter's `observeResolution` returns the final outcome
      // (or "pending"/"disputed") whenever it's available; the
      // resolver re-checks each tick until it lands.
      const t0row = anchorsRepo.getT0(this.db, ctx.call_id);
      let policy: T0Policy | null;
      try {
        policy = this.policyFromCtx(ctx);
      } catch (err) {
        this.log({
          kind: "still_pending",
          call_id: ctx.call_id,
          phase: "t1",
          reason: `policy_derivation_failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
        if (await this.markOracleUnavailable(ctx, "t1")) {
          oracleUnavailable++;
        }
        continue;
      }

      if (policy === null) {
        // Adapter-resolved branch remains registered, but the in-process
        // FHE threshold scoring/release pipeline has been removed. Until a
        // real external committee/provider is wired, these rows stay pending.
        this.log({
          kind: "still_pending",
          call_id: ctx.call_id,
          phase: "t1",
          reason: "adapter_resolved_scoring_deferred",
        });
        continue;
      }

      if (!t0row) continue;

      // Phase 2c: prefer the canonical horizon_seconds (no precision loss
      // for sub-hour markets). horizon_hours is retained as a back-compat
      // surface but the t1 anchor uses seconds directly.
      const t1Iso = isoFromUnixMs(
        Date.parse(t0row.t0) + ctx.horizon_seconds * 1000,
      );
      const elapsedSinceT1 = this.elapsedSecSince(t1Iso);
      if (elapsedSinceT1 < 0) continue; // not yet

      const outcome = await this.tryAnchor({
        call_id: ctx.call_id,
        mustBeAfterIso: t1Iso,
        elapsedSec: elapsedSinceT1,
        policy,
        phase: "t1",
      });

      if (outcome.kind === "anchored") {
        const obs = outcome.observation;

        // ── fhe_direct branch ───────────────────────────────────────────
        //
        // The in-process score/decrypt pipeline has been removed. There is
        // no honest local threshold release without external holder orgs, so
        // FHE-direct rows stay pending_t1 instead of pretending the operator
        // can release a score through a daemon-local mock committee.
        if (ctx.privacy_mode === "fhe_direct") {
          // FHE-direct remains accepted only when configured, but the mock
          // threshold score/release pipeline was removed. There is no honest
          // local release path, so keep the row pending_t1.
          this.log({
            kind: "still_pending",
            call_id: ctx.call_id,
            phase: "t1",
            reason: "fhe_direct:scoring_deferred_no_committee",
          });
          continue;
        }
        // ── end fhe_direct branch ───────────────────────────────────────

        // Wave 3b — the legacy plaintext + committed-mode resolution path
        // was deleted. Waves 2a/2b made FHE-direct the only accepted
        // submit mode, and MIGRATION_031 dropped the 4 plaintext columns
        // (side / asset_id / horizon_hours / confidence) the legacy
        // resolver relied on. Any pending row reaching this branch is
        // either a stale dev-DB record from before Wave 2b or a row
        // whose privacy_mode somehow drifted; either way we don't
        // attempt to resolve it. Mark terminal so it doesn't pin the
        // resolver tick forever, and log the reason for forensic
        // visibility.
        this.log({
          kind: "still_pending",
          call_id: ctx.call_id,
          phase: "t1",
          reason: `legacy_non_fhe_row_skipped:privacy_mode=${ctx.privacy_mode ?? "null"}`,
        });
        if (await this.markOracleUnavailable(ctx, "t1")) {
          oracleUnavailable++;
          try {
            await this.onResolved(ctx.call_id);
          } catch {
            // swallow — terminal state already persisted
          }
        }
      } else if (outcome.kind === "oracle_unavailable") {
        if (await this.markOracleUnavailable(ctx, "t1")) {
          oracleUnavailable++;
          try {
            await this.onResolved(ctx.call_id);
          } catch {
            // swallow — terminal state already persisted
          }
        }
      } else {
        this.log({
          kind: "still_pending",
          call_id: ctx.call_id,
          phase: "t1",
          reason: outcome.reason,
        });
      }
    }
    return { resolved, oracle_unavailable: oracleUnavailable };
  }

  // ── Phase 5 — adapter-dispatched universal payout-vector path ──
  //
  // Lifts the legacy resolver-scoped values (t0 anchor, t1 obs, void_band,
  // side, market_id) into a NativePriceObservationContext, dispatches to the
  // market's adapter, builds the universal Commitment, and reconciles the
  // void buckets via scoreOutcomeVector.
  //
  // Returns null when the v2 path can't be computed:
  //   - market row not found (legacy submission predates MIGRATION_009 and
  //     market_id is null)
  //   - subject is committed-mode without legacy plaintext fields and no
  //     parsed commitment_json
  // In null cases the resolver falls back to legacy-only behavior (no
  // resolved_outcome_json, no v2 receipt). Today every active call has a
  // market_id post-MIGRATION_009 backfill, so this null path is exercised
  // only in regression scenarios.
  // Wave 3b — computeV2OutcomePath + computeExpectedResolvesAt were the
  // legacy plaintext path's dual-write into the universal payout shape.
  // Wave 2b deleted legacy submit + Wave 3b deleted the legacy resolver
  // branch, so both helpers are now unreachable. The FHE-direct
  // resolution path (runFheDirectScoring) does its own adapter dispatch
  // against the encrypted prediction.

  // ── core anchoring step (used for both t0 and t1) ──

  private async tryAnchor(args: {
    call_id: string;
    mustBeAfterIso: string;
    elapsedSec: number;
    policy: T0Policy;
    phase: "t0" | "t1";
  }): Promise<
    | { kind: "anchored"; observation: OracleObservation }
    | { kind: "oracle_unavailable" }
    | { kind: "pending"; reason: string }
  > {
    if (args.elapsedSec > args.policy.t0_extended_grace_seconds) {
      return { kind: "oracle_unavailable" };
    }
    // Phase 2d: T0Policy fallback fields are optional. For sub-hour Pyth-only
    // markets we have no second oracle to walk to — keep retrying primary
    // until t0_extended_grace_seconds expires, then mark oracle_unavailable.
    // Past primary grace WITH a configured fallback, switch to fallback.
    const wantFallback = args.elapsedSec > args.policy.t0_grace_seconds;
    const fallbackConfigured =
      args.policy.fallback_feed !== undefined &&
      args.policy.fallback_max_staleness_sec !== undefined;
    const useFallback = wantFallback && fallbackConfigured;
    const feed = useFallback
      ? args.policy.fallback_feed!
      : args.policy.primary_feed;
    const maxStaleness = useFallback
      ? args.policy.fallback_max_staleness_sec!
      : args.policy.primary_max_staleness_sec;
    let obs: OracleObservation;
    try {
      obs = await this.observeFeed(feed);
    } catch (err) {
      if (err instanceof OracleError || err instanceof AdapterError) {
        const kind = err instanceof OracleError ? err.cause_kind : err.cause_kind;
        return { kind: "pending", reason: `oracle_error:${kind}` };
      }
      throw err;
    }
    const feedMs = Date.parse(obs.feed_timestamp);
    const afterMs = Date.parse(args.mustBeAfterIso);
    if (feedMs < afterMs) {
      return { kind: "pending", reason: "feed_not_yet_advanced" };
    }
    if (obs.source_age_seconds > maxStaleness) {
      return {
        kind: "pending",
        reason: `feed_stale:${obs.source_age_seconds}s>${maxStaleness}s`,
      };
    }
    return { kind: "anchored", observation: obs };
  }

  // ── terminal oracle_unavailable ──

  private async markOracleUnavailable(
    ctx: NonNullable<ReturnType<typeof submissionsRepo.loadResolverContext>>,
    phase: "t0" | "t1",
  ): Promise<boolean> {
    const resolved_at = this.nowIso();
    const t0row = anchorsRepo.getT0(this.db, ctx.call_id);
    // Wave 2b — committed-mode subject load + reveal-binding check
    // removed. FHE-direct rows never had this branch; legacy plaintext
    // rows can mark terminal without a reveal proof.
    // Wave 4b — receipt building is gone; the resolution row alone now
    // carries the terminal oracle_unavailable state. For t0-phase failures
    // we still stamp placeholder t0/p0/t0_feed values so downstream view
    // queries get non-null columns (the row's `outcome` is the semantic
    // truth).
    const placeholderTime = ctx.accepted_at;
    const placeholderPrice = "0";
    const placeholderFeed: OracleFeed = "chainlink:base:ETH-USD";
    const t0Iso = t0row?.t0 ?? placeholderTime;
    const p0 = t0row?.p0 ?? placeholderPrice;
    const t0Feed = (t0row?.feed ?? placeholderFeed) as OracleFeed;
    void t0Iso;
    void p0;

    const tx = this.db.transaction(() => {
      resolutionsRepo.setResolution(this.db, {
        call_id: ctx.call_id,
        t1: resolved_at,
        p1: placeholderPrice,
        t1_feed: t0Feed,
        signed_return: "0",
        outcome: "oracle_unavailable",
        call_score: null,
        resolved_at,
      });
      submissionsRepo.setStatus(this.db, ctx.call_id, "resolved");
      usageRepo.emit(
        this.db,
        this.makeUsage(ctx.agent_id, "resolution_completed", {
          call_id: ctx.call_id,
          outcome: "oracle_unavailable",
          phase,
        }),
      );
    });
    tx();
    this.log({ kind: "oracle_unavailable", call_id: ctx.call_id, phase });
    return true;
  }

  // ── oracle observation routing (P3 Phase 2) ──
  //
  // The legacy OracleClient hard-codes Chainlink Base ETH/USD + Pyth Hermes.
  // The new adapter registry (src/integrations/oracles/) is data-driven —
  // any registered oracle row dispatches to its named adapter. For the four
  // listed ETH markets (eth.1h/4h/24h/7d) both paths produce equivalent
  // observations, so the resolver routes through the registry first and
  // falls back to OracleClient only if the registry refuses (unknown feed,
  // not-listed oracle row, missing adapter config). When BTC/SOL/BNB markets
  // flip to listed, the registry path is the only one that knows about them
  // — the legacy fallback simply errors and the call stays pending until
  // the schema work in Phase 2b lands.
  private async observeFeed(feed: OracleFeed): Promise<OracleObservation> {
    // Phase 2b: every legal OracleFeed has a bidirectional map entry, so
    // oracle_id is always defined. The legacy OracleClient fallback only
    // triggers on an AdapterError (registry-level misconfiguration like
    // draft oracle row or missing config) — at which point the legacy
    // client knows ETH feeds and errors otherwise; non-ETH calls land
    // pending and the operator gets a chance to fix the registry.
    const oracle_id = feedToOracleId(feed);
    try {
      const obs = await observeOracle(this.db, oracle_id);
      return adapterToLegacyObservation(obs, feed);
    } catch (err) {
      if (!(err instanceof AdapterError)) {
        throw err;
      }
    }
    return this.oracle.getLatestPrice(feed);
  }

  // ── helpers ──

  private elapsedSecSince(iso: string): number {
    return (this.now().getTime() - Date.parse(iso)) / 1000;
  }

  private nowIso(): string {
    return this.now().toISOString().replace(/\.\d+Z$/, "Z");
  }

  /**
   * Wave 3 — the oracle_policies table is gone (MIGRATION_031). The
   * resolver re-derives a call's T0Policy from its market_id on every
   * read by walking the markets registry via derivePolicyFromMarket().
   *
   * Wave 4a — derivePolicyFromMarket can return null for adapter-resolved
   * markets (Polymarket Gamma + future event-feed adapters). The T0/T1
   * anchoring loops short-circuit on null: those markets resolve via
   * adapter.observeResolution(...) on every tick rather than anchoring
   * against a price feed at t0+horizon.
   *
   * The trade-off vs the old per-call snapshot:
   *   - A market frozen between submit and the resolver tick swaps the
   *     policy under us. With receipts/disputes gone (Wave 1/3a) there
   *     is no off-chain attestation pinned to the original policy.
   *   - The markets registry is still the source of truth for
   *     "which feeds anchor this market today"; a v0.3 dispute path
   *     that needs snapshotted policies would re-introduce a typed
   *     per-call audit log rather than the SQL join.
   */
  private policyFromCtx(
    ctx: NonNullable<ReturnType<typeof submissionsRepo.loadResolverContext>>,
  ): T0Policy | null {
    if (!ctx.market_id) {
      throw new Error(
        `call ${ctx.call_id} has no market_id; cannot derive oracle policy`,
      );
    }
    const market = marketsRepo.get(this.db, ctx.market_id);
    if (!market) {
      throw new Error(
        `call ${ctx.call_id} references unknown market_id ${ctx.market_id}`,
      );
    }
    return derivePolicyFromMarket(this.db, market);
  }

  private makeUsage(
    agent_id: string,
    kind: UsageEvent["kind"],
    attributes: Record<string, unknown>,
  ): UsageEvent {
    return {
      event_id: randomUUID(),
      agent_id,
      kind,
      ts: this.nowIso(),
      attributes,
    };
  }
}

function isoFromUnixMs(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");
}

/**
 * Parse `markets.config_json` to a plain object that the resolver can
 * spread into the adapter's ObservationContext. Codex P11 review
 * Critical B — adapter-private fields (e.g. Polymarket's `conditionId`)
 * live on `markets.config_json` and never reached `observeResolution`
 * before this helper threaded them through. Native-price markets ship
 * empty config_json so the spread is a no-op for them.
 *
 * Fail-soft: malformed JSON, non-object payloads, or DB-side TEXT/NULL
 * all collapse to `{}` rather than throwing. The resolver tick MUST
 * NOT abort because one market's config_json was malformed.
 */
function parseMarketConfigJson(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string" || raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // intentional swallow — see header comment
  }
  return {};
}

// (feedToOracleId is imported at the top of the file from oracle-routing.js
//  AND re-exported below for back-compat with smoke tests that imported it
//  from resolver.)
export { feedToOracleId } from "./oracle-routing.js";

// Adapter observations carry `oracle_id` + `asset_id`; the resolver still
// expects the legacy shape (`feed`). Re-shape without losing fields the
// resolver actually consumes.
export function adapterToLegacyObservation(
  obs: AdapterObservation,
  feed: OracleFeed,
): OracleObservation {
  return {
    feed,
    price: obs.price,
    feed_timestamp: obs.feed_timestamp,
    observed_at: obs.observed_at,
    source_id: obs.source_id,
    source_age_seconds: obs.source_age_seconds,
  };
}

// Keep import surface stable for test harness.
export const _exposed = { HORIZONS_HOURS };
