import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  AssetId,
  HORIZONS_HOURS,
  HorizonHours,
  OracleFeed,
  Outcome,
  Side,
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
import { loadResolutionSubject } from "./resolution-subject.js";
import type { AgeContext } from "./age-envelope.js";
import type { DrandContext } from "./drand-envelope.js";
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
import { feedToOracleId } from "./oracle-routing.js";
import {
  computeSignedReturn,
  outcomeFromSignedReturn,
  scoreCall,
  scoreOutcomeVector,
} from "./scoring.js";
// Phase 5 — adapter dispatch + universal commitment normalizer.
import { getAdapterForMarket, voidBandFloat } from "./markets.js";
import { observeResolutionForCall } from "./market-maker/native-price.js";
import {
  legacySubmissionToCommitment,
  parseStoredCommitment,
} from "./submission-normalizers.js";
import { serializeOutcome, type Outcome as UniversalOutcome } from "./markets-core.js";
import { AdapterNotFoundError } from "./markets.js";

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
  /**
   * P2 committed-mode subject loader contexts. When the resolver hits a
   * committed-mode call past horizon, it tries (in order):
   *   1. agent reveal already in call_reveals
   *   2. age envelope decrypt past fallback_after (needs ageContext.identity)
   *   3. drand timelock decrypt past round (needs drandContext)
   * Without these, committed calls past horizon stay deferred until
   * an agent reveals voluntarily.
   */
  ageContext?: AgeContext;
  drandContext?: DrandContext;
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
  private readonly ageContext: AgeContext | undefined;
  private readonly drandContext: DrandContext | undefined;

  constructor(deps: ResolverDeps) {
    this.db = deps.db;
    this.oracle = deps.oracle;
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? (() => undefined);
    this.onResolved = deps.onResolved ?? (() => undefined);
    this.ageContext = deps.ageContext;
    this.drandContext = deps.drandContext;
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
      const outcome = await this.tryAnchor({
        call_id: ctx.call_id,
        mustBeAfterIso: ctx.accepted_at,
        elapsedSec: this.elapsedSecSince(ctx.accepted_at),
        policy: this.policyFromCtx(ctx),
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
      const t0row = anchorsRepo.getT0(this.db, ctx.call_id);
      if (!t0row) continue;

      // Phase 2c: prefer the canonical horizon_seconds (no precision loss
      // for sub-hour markets). horizon_hours is retained as a back-compat
      // surface but the t1 anchor uses seconds directly.
      const t1Iso = isoFromUnixMs(
        Date.parse(t0row.t0) + ctx.horizon_seconds * 1000,
      );
      const elapsedSinceT1 = this.elapsedSecSince(t1Iso);
      if (elapsedSinceT1 < 0) continue; // not yet

      const policy = this.policyFromCtx(ctx);
      const outcome = await this.tryAnchor({
        call_id: ctx.call_id,
        mustBeAfterIso: t1Iso,
        elapsedSec: elapsedSinceT1,
        policy,
        phase: "t1",
      });

      if (outcome.kind === "anchored") {
        const obs = outcome.observation;
        // P2 Phase C-2: load resolution subject. For committed rows
        // this prefers the agent's voluntary reveal, falls back to
        // daemon age decrypt past fallback_after, then drand decrypt
        // past the bound round. Returns "not_yet_revealable" if the
        // call is committed but no path is open yet — skip + retry
        // next tick. Legacy_plaintext rows hydrate from submissions
        // on first access and behave like agent reveals from then on.
        const subjectResult = await loadResolutionSubject(this.db, ctx.call_id, {
          ...(this.ageContext ? { ageCtx: this.ageContext } : {}),
          ...(this.drandContext ? { drandCtx: this.drandContext } : {}),
          now: this.now,
        });
        if (!subjectResult.ok) {
          this.log({
            kind: "still_pending",
            call_id: ctx.call_id,
            phase: "t1",
            reason: `subject:${subjectResult.reason}`,
          });
          continue;
        }
        const subject = subjectResult.subject;
        // Use the resolved plaintext (agent-revealed, daemon-decrypted,
        // drand-decrypted, or legacy-hydrated) as the truth for scoring.
        // For legacy_plaintext rows this is identical to ctx.* — just
        // routed through call_reveals so every code path reads from one
        // place going forward.
        const r = computeSignedReturn(subject.side, t0row.p0, obs.price);
        // P4 Item 4 (Codex audit): outcome boundary comes from the
        // subject's stamped void_band, not the global VOID_BAND. A
        // post-acceptance bumpConfig must NOT rewrite this call's
        // outcome. Falls back to global VOID_BAND for legacy rows
        // without enrichment.
        const subjectVoidBand =
          subject.void_band !== null ? Number(subject.void_band) : undefined;
        const verdictOutcome = outcomeFromSignedReturn(r, subjectVoidBand);
        const score = scoreCall({
          asset_id: subject.asset_id as AssetId,
          horizon_hours: subject.horizon_hours as HorizonHours,
          // Phase 2e: prefer canonical horizon_seconds from the resolver
          // context (preserves sub-hour precision). horizon_hours stays on
          // the call for back-compat with the legacy fallback path.
          horizon_seconds: ctx.horizon_seconds,
          confidence: subject.confidence,
          signed_return: r,
          outcome: verdictOutcome,
        });

        // Phase 5 — universal payout-vector path. Dispatched alongside the
        // legacy code above so the leaderboard/verify/receipt paths all
        // continue to read the same legacy columns byte-identically. The
        // universal shape is ADDITIVE — written to t1_resolutions.{
        // resolved_outcome_json, payout_vector_json } and a sibling v2
        // receipt with kind='resolution_v2'.
        //
        // Adapter dispatch:
        //   1. Look up the call's market row → adapter.
        //   2. Lift the legacy resolver-scoped values (t0 anchor, t1 obs,
        //      void_band, side, market_id) into a NativePriceObservationContext.
        //   3. Adapter computes the universal Outcome.
        //   4. Build the universal Commitment from submissions.commitment_json
        //      (Phase 4 v2 submit) OR derive on-the-fly from the legacy
        //      submission row (legacySubmissionToCommitment).
        //   5. scoreOutcomeVector reconciles the void buckets.
        //
        // Legacy compatibility check: scoreOutcomeVector returns null
        // call_score iff the legacy verdictOutcome is 'void'. Asserting
        // this would catch any future divergence at the adapter cutover.
        // BLOCKER #1 isolation: the v2 dual-write path MUST NEVER abort the
        // legacy resolution transaction. Wrap the whole compute in try/catch
        // and honor the MURMUR_V2_RESOLVER_DISABLED kill switch so an
        // operator can hot-disable v2 without redeploy if a bad adapter or
        // malformed commitment lands in production.
        let v2: ReturnType<Resolver["computeV2OutcomePath"]> = null;
        if (process.env.MURMUR_V2_RESOLVER_DISABLED !== "1") {
          try {
            v2 = this.computeV2OutcomePath({
              ctx,
              subject,
              t0row,
              obs,
              subjectVoidBand,
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(
              `[resolver] v2 path failed for call ${ctx.call_id}: ${msg}`,
            );
            v2 = null;
          }
        }

        const resolved_at = this.nowIso();

        // Wave 4b — committed-mode commit_hash + reveal binding sanity
        // checks before resolution lands. Receipts no longer chain the
        // attestation but the commit/reveal pair is still the canonical
        // committed-mode evidence; refuse to resolve if either is missing.
        if (subject.source !== "legacy_plaintext") {
          const subRow = this.db
            .prepare("SELECT commit_hash FROM submissions WHERE call_id = ?")
            .get(ctx.call_id) as { commit_hash: string | null } | undefined;
          if (!subRow?.commit_hash) {
            this.log({
              kind: "still_pending",
              call_id: ctx.call_id,
              phase: "t1",
              reason: "committed-mode row missing commit_hash",
            });
            continue;
          }
          if (!subject.agent_wallet || !subject.chain_id) {
            this.log({
              kind: "still_pending",
              call_id: ctx.call_id,
              phase: "t1",
              reason: "committed-mode reveal without wallet binding",
            });
            continue;
          }
        }

        const tx = this.db.transaction(() => {
          resolutionsRepo.setResolution(this.db, {
            call_id: ctx.call_id,
            t1: obs.feed_timestamp,
            p1: obs.price,
            t1_feed: obs.feed,
            signed_return: r.toFixed(8),
            outcome: verdictOutcome,
            call_score: score.call_score,
            resolved_at,
            // Phase 5 — additive universal columns. NULL when the v2 path
            // was unavailable (shouldn't happen for native-price markets;
            // future markets without an adapter would land here).
            ...(v2
              ? {
                  resolved_outcome_json: JSON.stringify(
                    serializeOutcome(v2.outcome),
                  ),
                  payout_vector_json: JSON.stringify(
                    v2.outcome.payoutNumerators.map((n) => n.toString()),
                  ),
                }
              : {}),
          });
          submissionsRepo.setStatus(this.db, ctx.call_id, "resolved");
          usageRepo.emit(
            this.db,
            this.makeUsage(ctx.agent_id, "resolution_completed", {
              call_id: ctx.call_id,
              outcome: verdictOutcome,
              call_score: score.call_score,
            }),
          );
        });
        tx();

        resolved++;
        this.log({
          kind: "anchored_t1",
          call_id: ctx.call_id,
          feed: obs.feed,
          p1: obs.price,
          outcome: verdictOutcome,
        });
        try {
          await this.onResolved(ctx.call_id);
        } catch (err) {
          // Notification failures must not block the resolver.
          this.log({
            kind: "still_pending",
            call_id: ctx.call_id,
            phase: "t1",
            reason: `notify_failed:${err instanceof Error ? err.message : String(err)}`,
          });
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
  private computeV2OutcomePath(args: {
    ctx: NonNullable<ReturnType<typeof submissionsRepo.loadResolverContext>>;
    subject: {
      side: Side;
      asset_id: string;
      horizon_hours: number;
      confidence: number;
      void_band: string | number | null;
      market_id: string | null;
      market_config_version?: number | null;
    };
    t0row: { p0: string };
    obs: OracleObservation;
    subjectVoidBand: number | undefined;
  }): {
    commitment: ReturnType<typeof legacySubmissionToCommitment>;
    outcome: UniversalOutcome;
    score: ReturnType<typeof scoreOutcomeVector>;
    adapter_id: string;
  } | null {
    // Resolve the market row to dispatch the adapter. Legacy rows without
    // market_id (pre-MIGRATION_009) fall through; the adapter dispatch
    // requires a market row to honor markets.adapter_id (Phase 11+).
    //
    // FIX 1c — defensive: missing market row, missing/unknown adapter,
    // unparseable commitment_json all return null instead of throwing.
    // The outer try/catch in the resolver tick (FIX 1a) is a backstop
    // for unexpected programmer errors; the well-known partial-state
    // cases land here as a quiet `null` so a single bad call can't
    // poison the tick.
    const marketId = args.subject.market_id ?? args.ctx.market_id ?? null;
    if (!marketId) return null;
    const marketRow = marketsRepo.get(this.db, marketId);
    if (!marketRow) return null;

    let adapter;
    try {
      adapter = getAdapterForMarket(marketRow);
    } catch (err) {
      if (err instanceof AdapterNotFoundError) {
        return null;
      }
      throw err;
    }

    // Lift the resolver-scoped values into the adapter's observation context.
    // This is the seam Phase 3's NativePriceAdapter shell prepped for —
    // observeResolutionForCall is the adapter-private function that produces
    // the universal Outcome from native-price's t0/t1 anchors.
    const voidBand =
      args.subjectVoidBand !== undefined
        ? args.subjectVoidBand
        : voidBandFloat(marketRow);
    const outcome = observeResolutionForCall({
      t0_p0: args.t0row.p0,
      t1_p1: args.obs.price,
      t1_iso: args.obs.feed_timestamp,
      t1_feed: args.obs.feed,
      t1_source_id: args.obs.source_id,
      void_band: voidBand,
      side: args.subject.side,
      market_id: marketId,
    });

    // Build the universal Commitment. Prefer the stored canonical
    // commitment_json (Phase 4 submit path); fall back to deriving from
    // the legacy submission fields (v1 calls / pre-Phase-4 rows).
    const subRow = this.db
      .prepare(
        "SELECT commitment_json FROM submissions WHERE call_id = ?",
      )
      .get(args.ctx.call_id) as { commitment_json: string | null } | undefined;
    const stored = parseStoredCommitment(subRow?.commitment_json ?? null);
    let commitment;
    if (stored) {
      commitment = stored;
    } else {
      // Legacy fallback. Wrap in try/catch so a malformed legacy row
      // (e.g. Phase E-cleaned committed row with no stored commitment_json
      // and nulled-out plaintext columns) returns null instead of throwing
      // through the outer resolver loop.
      try {
        commitment = legacySubmissionToCommitment({
          side: args.subject.side,
          confidence: args.subject.confidence,
          asset_id: args.subject.asset_id,
          horizon_hours: args.subject.horizon_hours,
          // The Commitment.horizon.iso is render-only — scoreOutcomeVector
          // never reads it. Use accepted_at + horizon_seconds as a stable
          // canonical value (matches what Phase 4 v2 submit stamps).
          expected_resolves_at_iso: this.computeExpectedResolvesAt(args.ctx),
          market_id: marketId,
          market_config_version: args.subject.market_config_version ?? null,
        });
      } catch {
        return null;
      }
    }

    let score;
    try {
      score = scoreOutcomeVector(commitment, outcome);
    } catch {
      return null;
    }
    return {
      commitment,
      outcome,
      score,
      adapter_id: adapter.name,
    };
  }

  /** Helper for legacySubmissionToCommitment fallback path. The actual
   *  expected_resolves_at_iso is canonical (accepted_at + horizon_seconds);
   *  the value is render-only on the Commitment so any stable derivation
   *  works for Phase 5's void-mapping verification. */
  private computeExpectedResolvesAt(
    ctx: NonNullable<ReturnType<typeof submissionsRepo.loadResolverContext>>,
  ): string {
    const acceptedMs = Date.parse(ctx.accepted_at);
    const t1Ms = acceptedMs + ctx.horizon_seconds * 1000;
    return new Date(t1Ms).toISOString().replace(/\.\d+Z$/, "Z");
  }

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
    const committedSubject =
      ctx.privacy_mode === "committed"
        ? await loadResolutionSubject(this.db, ctx.call_id, {
            ...(this.ageContext ? { ageCtx: this.ageContext } : {}),
            ...(this.drandContext ? { drandCtx: this.drandContext } : {}),
            now: this.now,
          })
        : null;
    if (committedSubject && !committedSubject.ok) {
      this.log({
        kind: "still_pending",
        call_id: ctx.call_id,
        phase,
        reason: `subject:${committedSubject.reason}:oracle_unavailable`,
      });
      return false;
    }
    const subject = committedSubject?.subject ?? null;
    if (ctx.privacy_mode === "committed") {
      if (
        !ctx.commit_hash ||
        !subject?.agent_wallet ||
        !subject.chain_id ||
        !subject.reveal_hash_valid
      ) {
        this.log({
          kind: "still_pending",
          call_id: ctx.call_id,
          phase,
          reason: "committed oracle_unavailable missing valid reveal binding",
        });
        return false;
      }
    }
    // Wave 4b — receipt building is gone; the resolution row alone now
    // carries the terminal oracle_unavailable state. For t0-phase failures
    // we still stamp placeholder t0/p0/t0_feed values so downstream view
    // queries get non-null columns (the row's `outcome` is the semantic
    // truth). Subject availability still gates the committed-mode path:
    // committed calls require a valid reveal binding before we mark
    // terminal, since the dispute / replay surface still needs the wallet
    // attribution intact.
    const placeholderTime = ctx.accepted_at;
    const placeholderPrice = "0";
    const placeholderFeed: OracleFeed = "chainlink:base:ETH-USD";
    const t0Iso = t0row?.t0 ?? placeholderTime;
    const p0 = t0row?.p0 ?? placeholderPrice;
    const t0Feed = (t0row?.feed ?? placeholderFeed) as OracleFeed;
    void subject;
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

  private policyFromCtx(
    ctx: NonNullable<ReturnType<typeof submissionsRepo.loadResolverContext>>,
  ): T0Policy {
    // Phase 2d: ctx.fallback_feed / fallback_max_staleness_sec are nullable.
    // T0Policy uses the optional shape — both fields go missing together
    // for sub-hour Pyth-only markets.
    const hasFeed = ctx.fallback_feed !== null;
    const hasStaleness = ctx.fallback_max_staleness_sec !== null;
    if (hasFeed !== hasStaleness) {
      throw new Error(
        `oracle_policies row for call ${ctx.call_id} has half-configured fallback (fallback_feed=${hasFeed ? "set" : "null"}, fallback_max_staleness_sec=${hasStaleness ? "set" : "null"}); both must be set or both NULL`,
      );
    }
    return {
      primary_feed: ctx.primary_feed as T0Policy["primary_feed"],
      primary_max_staleness_sec: ctx.primary_max_staleness_sec,
      t0_grace_seconds: ctx.t0_grace_seconds,
      t0_extended_grace_seconds: ctx.t0_extended_grace_seconds,
      ...(ctx.fallback_feed !== null && ctx.fallback_max_staleness_sec !== null
        ? {
            fallback_feed: ctx.fallback_feed as NonNullable<
              T0Policy["fallback_feed"]
            >,
            fallback_max_staleness_sec: ctx.fallback_max_staleness_sec,
          }
        : {}),
    };
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
