import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  AssetId,
  HORIZONS_HOURS,
  HorizonHours,
  OracleFeed,
  OracleFeedSchema,
  Outcome,
  ResolutionReceiptPayloadSchema,
  SCHEMA_VERSION,
  SCORING_VERSION,
  Side,
  T0Policy,
  UsageEvent,
} from "./schema.js";
import {
  agentsRepo,
  anchorsRepo,
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
import { buildResolutionReceipt } from "../receipts/verdictReceipt.js";
import {
  computeSignedReturn,
  outcomeFromSignedReturn,
  scoreCall,
} from "./scoring.js";

// ─── Public types ────────────────────────────────────────────────────────────

export interface ResolverDeps {
  db: Database.Database;
  oracle: OracleClient;
  pinReceipt?: (canonical_json: string) => Promise<string | null>;
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
  private readonly pinReceipt: ((s: string) => Promise<string | null>) | null;
  private readonly now: () => Date;
  private readonly log: (line: ResolverLogEvent) => void;
  private readonly onResolved: NonNullable<ResolverDeps["onResolved"]>;
  private readonly ageContext: AgeContext | undefined;
  private readonly drandContext: DrandContext | undefined;

  constructor(deps: ResolverDeps) {
    this.db = deps.db;
    this.oracle = deps.oracle;
    this.pinReceipt = deps.pinReceipt ?? null;
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

      const t1Iso = isoFromUnixMs(
        Date.parse(t0row.t0) + ctx.horizon_hours * 3600 * 1000,
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
        const verdictOutcome = outcomeFromSignedReturn(r);
        const score = scoreCall({
          asset_id: subject.asset_id as AssetId,
          horizon_hours: subject.horizon_hours as HorizonHours,
          confidence: subject.confidence,
          signed_return: r,
          outcome: verdictOutcome,
        });

        const resolved_at = this.nowIso();
        // Look up the issuing agent so legacy receipts can carry the
        // current wallet binding when available. Committed v2 receipts use
        // the wallet embedded in the verified reveal preimage instead; an
        // admin wallet rotation after submit must not rewrite history.
        const issuingAgent = agentsRepo.byId(this.db, ctx.agent_id);

        // Branch: v2 receipt for committed calls (carries reveal block);
        // v1 receipt for legacy_plaintext.
        let resolutionPayload: ReturnType<typeof ResolutionReceiptPayloadSchema.parse>;
        if (subject.source === "legacy_plaintext") {
          resolutionPayload = ResolutionReceiptPayloadSchema.parse({
            schema_version: 1,
            scoring_version: SCORING_VERSION,
            call_id: ctx.call_id,
            acceptance_receipt_hash: ctx.acceptance_receipt_hash,
            t0: t0row.t0,
            p0: t0row.p0,
            t0_feed: OracleFeedSchema.parse(t0row.feed),
            t1: obs.feed_timestamp,
            p1: obs.price,
            t1_feed: obs.feed,
            signed_return: r.toFixed(8),
            outcome: verdictOutcome,
            call_score: score.call_score,
            resolved_at,
            ...(issuingAgent?.wallet_address ? { agent_wallet: issuingAgent.wallet_address } : {}),
            ...(issuingAgent?.chain_id ? { chain_id: issuingAgent.chain_id } : {}),
          });
        } else {
          // committed → v2 with reveal block.
          // Skip emission if commit_hash is missing (shouldn't happen
          // for committed rows, defensive null-guard).
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
          resolutionPayload = ResolutionReceiptPayloadSchema.parse({
            schema_version: 2,
            scoring_version: SCORING_VERSION,
            receipt_kind: "resolution",
            call_id: ctx.call_id,
            acceptance_receipt_hash: ctx.acceptance_receipt_hash,
            commit_hash: subRow.commit_hash,
            t0: t0row.t0,
            p0: t0row.p0,
            t0_feed: OracleFeedSchema.parse(t0row.feed),
            t1: obs.feed_timestamp,
            p1: obs.price,
            t1_feed: obs.feed,
            signed_return: r.toFixed(8),
            outcome: verdictOutcome,
            call_score: score.call_score,
            resolved_at,
            agent_wallet: subject.agent_wallet,
            chain_id: subject.chain_id,
            reveal: {
              revealed_via: subject.source,
              revealed_at: subject.revealed_at,
              reveal_hash_valid: subject.reveal_hash_valid,
              commit_preimage_schema:
                subject.commit_preimage_schema ?? "murmur-verdict-v0.2-commit@1",
              plaintext_subject: {
                side: subject.side,
                asset_id: subject.asset_id as AssetId,
                horizon_hours: subject.horizon_hours as HorizonHours,
                confidence: subject.confidence,
              },
            },
          });
        }
        const receipt = buildResolutionReceipt(resolutionPayload);
        let cid: string | null = null;
        if (this.pinReceipt) {
          try {
            cid = (await this.pinReceipt(receipt.canonical_json)) ?? null;
          } catch {
            cid = null;
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
          });
          resolutionsRepo.recordResolutionReceipt(this.db, {
            receipt_hash: receipt.receipt_hash,
            call_id: ctx.call_id,
            canonical_json: receipt.canonical_json,
            filecoin_cid: cid ?? undefined,
            previous_hash: ctx.acceptance_receipt_hash as `0x${string}`,
            created_at: resolved_at,
            kind: "resolution",
          });
          submissionsRepo.setStatus(this.db, ctx.call_id, "resolved");
          usageRepo.emit(
            this.db,
            this.makeUsage(ctx.agent_id, "resolution_completed", {
              call_id: ctx.call_id,
              outcome: verdictOutcome,
              call_score: score.call_score,
              receipt_hash: receipt.receipt_hash,
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
    const useFallback = args.elapsedSec > args.policy.t0_grace_seconds;
    const feed = useFallback ? args.policy.fallback_feed : args.policy.primary_feed;
    const maxStaleness = useFallback
      ? args.policy.fallback_max_staleness_sec
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
    // Build a degenerate resolution receipt so the chain is preserved even when
    // we never anchored. For t0-phase failures, t0/p0/t0_feed are best-effort
    // placeholders; the receipt outcome is what carries semantic weight.
    const placeholderTime = ctx.accepted_at;
    const placeholderPrice = "0";
    const placeholderFeed: OracleFeed = "chainlink:base:ETH-USD";
    const t0Iso = t0row?.t0 ?? placeholderTime;
    const p0 = t0row?.p0 ?? placeholderPrice;
    const t0Feed = (t0row?.feed ?? placeholderFeed) as OracleFeed;

    const resolutionPayload = ResolutionReceiptPayloadSchema.parse(
      subject
        ? {
            schema_version: 2,
            scoring_version: SCORING_VERSION,
            receipt_kind: "resolution",
            call_id: ctx.call_id,
            acceptance_receipt_hash: ctx.acceptance_receipt_hash,
            commit_hash: ctx.commit_hash,
            t0: t0Iso,
            p0,
            t0_feed: t0Feed,
            t1: resolved_at,
            p1: placeholderPrice,
            t1_feed: t0Feed,
            signed_return: "0",
            outcome: "oracle_unavailable",
            call_score: null,
            resolved_at,
            agent_wallet: subject.agent_wallet,
            chain_id: subject.chain_id,
            reveal: {
              revealed_via: subject.source,
              revealed_at: subject.revealed_at,
              reveal_hash_valid: subject.reveal_hash_valid,
              commit_preimage_schema:
                subject.commit_preimage_schema ?? "murmur-verdict-v0.2-commit@1",
              plaintext_subject: {
                side: subject.side,
                asset_id: subject.asset_id as AssetId,
                horizon_hours: subject.horizon_hours as HorizonHours,
                confidence: subject.confidence,
              },
            },
          }
        : {
            schema_version: SCHEMA_VERSION,
            scoring_version: SCORING_VERSION,
            call_id: ctx.call_id,
            acceptance_receipt_hash: ctx.acceptance_receipt_hash,
            t0: t0Iso,
            p0,
            t0_feed: t0Feed,
            t1: resolved_at,
            p1: placeholderPrice,
            t1_feed: t0Feed,
            signed_return: "0",
            outcome: "oracle_unavailable",
            call_score: null,
            resolved_at,
          },
    );
    const receipt = buildResolutionReceipt(resolutionPayload);
    let cid: string | null = null;
    if (this.pinReceipt) {
      try {
        cid = (await this.pinReceipt(receipt.canonical_json)) ?? null;
      } catch {
        cid = null;
      }
    }
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
      resolutionsRepo.recordResolutionReceipt(this.db, {
        receipt_hash: receipt.receipt_hash,
        call_id: ctx.call_id,
        canonical_json: receipt.canonical_json,
        filecoin_cid: cid ?? undefined,
        previous_hash: ctx.acceptance_receipt_hash as `0x${string}`,
        created_at: resolved_at,
        kind: "resolution",
      });
      submissionsRepo.setStatus(this.db, ctx.call_id, "resolved");
      usageRepo.emit(
        this.db,
        this.makeUsage(ctx.agent_id, "resolution_completed", {
          call_id: ctx.call_id,
          outcome: "oracle_unavailable",
          phase,
          receipt_hash: receipt.receipt_hash,
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
    return {
      primary_feed: ctx.primary_feed as T0Policy["primary_feed"],
      fallback_feed: ctx.fallback_feed as T0Policy["fallback_feed"],
      primary_max_staleness_sec: ctx.primary_max_staleness_sec,
      fallback_max_staleness_sec: ctx.fallback_max_staleness_sec,
      t0_grace_seconds: ctx.t0_grace_seconds,
      t0_extended_grace_seconds: ctx.t0_extended_grace_seconds,
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
