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
// Wave 2b — AgeContext / DrandContext imports removed; the dead
// envelope-decrypt paths in loadResolutionSubject are no longer
// passed contexts.
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
// Wave 4d — universal payout-vector path is dispatched through the registry
// for BOTH t1 observation (adapter.observeResolution) and scoring
// (scoreOutcomeVector internally routes through adapter.score). The legacy
// `observeResolutionForCall` direct import is gone — the adapter is now
// load-bearing, not a parallel implementation.
import { getAdapterForMarket, voidBandFloat } from "./markets.js";
import {
  legacySubmissionToCommitment,
  parseStoredCommitment,
} from "./submission-normalizers.js";
import { serializeOutcome, type Outcome as UniversalOutcome } from "./markets-core.js";
import { AdapterNotFoundError } from "./markets.js";
import type { FheProvider } from "./fhe/provider.js";
import {
  canonicalResolvedOutcomeBytes as canonicalResolvedOutcomeBytesLocal,
  FheUnavailableError,
} from "./fhe/provider.js";
import {
  enqueueScoreJob,
  recordScoreFailure,
  recordScoreSuccess,
} from "./fhe/score-jobs.js";
import {
  enqueueDecryptRequest,
  listPendingDecryptRequests,
  persistDecryptShare,
  persistScoreRelease,
  setRequestStatus,
  listActiveKeyHolders,
} from "./fhe/decrypt-requests.js";
import {
  aggregateShares,
  validateQuorum,
  verifyShare,
  type PartialDecryptRequest,
  type PartialDecryptShare,
  type ThresholdHolder,
} from "./fhe/threshold.js";
import { createHash } from "node:crypto";

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
  /**
   * Z2 — FHE provider for the `fhe_direct` branch. When present, the
   * resolver dispatches encrypted scoring through this provider before
   * the legacy `loadResolutionSubject` path. When null/undefined (flag
   * off, no provider loaded), the resolver behaves byte-identically to
   * pre-Z2 master: fhe_direct rows would never have been accepted at
   * submission time anyway, so the branch is effectively dead code.
   */
  fheProvider?: FheProvider | null;
  /**
   * Z3 — threshold-decrypt quorum pool. When present, the resolver
   * enqueues a decrypt request immediately after recordScoreSuccess
   * (atomic with the score commit) and drives quorum collection +
   * release on subsequent ticks via runFheThresholdReleasePhase().
   *
   * Holders are loaded from `fhe_key_holders` by ID; the pool object
   * carries the in-process signing keys (mock-quorum) OR the off-process
   * HTTP/RPC adapters (real Zama KMS). The interface is the same.
   *
   * When null/undefined, the resolver still scores in encrypted mode
   * (Z2 behavior) but never releases the score — the call stays at
   * status='resolved' with call_score=NULL and the decrypt request
   * sits in 'pending_shares' until quorum lands. This is the Z2-only
   * configuration and stays operationally usable for ops smoke tests.
   */
  quorumPool?: { holders(): ReadonlyArray<ThresholdHolder> } | null;
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
  private readonly fheProvider: FheProvider | null;
  private readonly quorumPool: {
    holders(): ReadonlyArray<ThresholdHolder>;
  } | null;

  constructor(deps: ResolverDeps) {
    this.db = deps.db;
    this.oracle = deps.oracle;
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? (() => undefined);
    this.onResolved = deps.onResolved ?? (() => undefined);
    // Wave 2b — ageContext + drandContext init removed.
    this.fheProvider = deps.fheProvider ?? null;
    this.quorumPool = deps.quorumPool ?? null;
  }

  async tick(): Promise<ResolverTickResult> {
    const t0 = await this.runT0Phase();
    const t1 = await this.runT1Phase();
    // Z3 — drive the threshold-release phase last, after t1 has had a
    // chance to enqueue new decrypt requests this tick. Releases are
    // additive: they fill in t1_resolutions.call_score for calls that
    // already reached status='resolved' at score-time.
    await this.runFheThresholdReleasePhase();
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

        // ── Z2 fhe_direct branch ─────────────────────────────────────────
        //
        // Encrypted-prediction rows never call loadResolutionSubject. The
        // daemon has NO key to recover the prediction; the prediction stays
        // encrypted, and we score it homomorphically against the public
        // adapter outcome instead.
        //
        // Path:
        //   1. Look up the per-call ciphertext from fhe_call_ciphertexts
        //      (NOT submissions.predicted_outcome_json — that column is
        //      null for fhe_direct rows by Z1's contract).
        //   2. Dispatch the public outcome via the adapter (same code path
        //      the legacy v2 branch uses) so the resolved payout vector is
        //      adapter-produced, not resolver-improvised.
        //   3. provider.scoreEncrypted(...) returns {encrypted_score,
        //      transcript_hash}.
        //   4. Record onto fhe_score_jobs + t1_resolutions.
        //      score_ciphertext_hash. The call stays at status='resolved'
        //      (universal terminal state) but call_score stays NULL; Z3's
        //      threshold release fills it in after quorum decrypt.
        //
        // Failure posture (plan §5 cold-start): provider/sidecar errors
        // throw FheUnavailableError; we record the failure on the job row
        // and leave the call at pending_t1. The next resolver tick retries.
        // We do NOT downgrade to plaintext scoring — that's the whole
        // point of operator-blind privacy.
        if (ctx.privacy_mode === "fhe_direct") {
          const fheBranchResult = await this.runFheDirectScoring({
            ctx,
            t0row,
            obs,
          });
          if (fheBranchResult === "pending") {
            // Sidecar transient / circuit lookup miss / etc. Leave the
            // call pending_t1; next tick retries. No state transition.
            this.log({
              kind: "still_pending",
              call_id: ctx.call_id,
              phase: "t1",
              reason: "fhe_direct:sidecar_unavailable",
            });
            continue;
          }
          if (fheBranchResult === "skipped") {
            // Provider not loaded — daemon was started without an FHE
            // provider but somehow has a fhe_direct row. Submission gate
            // should have refused at Z1, but if a row slipped through
            // (e.g. flag toggled mid-run) we keep it pending rather than
            // crashing the tick.
            this.log({
              kind: "still_pending",
              call_id: ctx.call_id,
              phase: "t1",
              reason: "fhe_direct:no_provider",
            });
            continue;
          }
          // fhe_direct resolved — the call is in 'resolved' status with an
          // encrypted score recorded. Increment the counter, fire onResolved,
          // and skip the legacy plaintext path entirely.
          resolved++;
          this.log({
            kind: "anchored_t1",
            call_id: ctx.call_id,
            feed: obs.feed,
            p1: obs.price,
            // Z2 has no plaintext verdict outcome to log — use the universal
            // outcome's kind via the recorded resolved_outcome_json instead.
            // For now stamp "win"/"loss" placeholder; the resolved_outcome_json
            // on t1_resolutions carries the truth.
            outcome: "win",
          });
          try {
            await this.onResolved(ctx.call_id);
          } catch (err) {
            this.log({
              kind: "still_pending",
              call_id: ctx.call_id,
              phase: "t1",
              reason: `notify_failed:${err instanceof Error ? err.message : String(err)}`,
            });
          }
          continue;
        }
        // ── end Z2 fhe_direct branch ─────────────────────────────────────

        // P2 Phase C-2: load resolution subject. For committed rows
        // this prefers the agent's voluntary reveal, falls back to
        // daemon age decrypt past fallback_after, then drand decrypt
        // past the bound round. Returns "not_yet_revealable" if the
        // call is committed but no path is open yet — skip + retry
        // next tick. Legacy_plaintext rows hydrate from submissions
        // on first access and behave like agent reveals from then on.
        const subjectResult = await loadResolutionSubject(this.db, ctx.call_id, {
          // Wave 2b — ageCtx + drandCtx removed; the envelope-decrypt
          // fallback paths inside loadResolutionSubject are dead.
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
        let v2: Awaited<ReturnType<Resolver["computeV2OutcomePath"]>> = null;
        if (process.env.MURMUR_V2_RESOLVER_DISABLED !== "1") {
          try {
            v2 = await this.computeV2OutcomePath({
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

  // ── Z2 — fhe_direct encrypted-scoring path ──
  //
  // Sibling to the legacy plaintext path. Computes an encrypted score
  // from (encrypted prediction + public adapter outcome) and persists:
  //   - fhe_score_jobs row in status='scored_pending_decrypt'
  //   - t1_resolutions row with NULL call_score + score_ciphertext_hash
  //     pointing at the job
  //   - submissions.status flipped to 'resolved' (universal terminal)
  //
  // Returns:
  //   "scored"  — encrypted score persisted; resolver counts as resolved
  //   "pending" — sidecar/provider transient failure; resolver keeps the
  //               call at pending_t1 for next-tick retry
  //   "skipped" — no provider loaded (shouldn't happen at runtime; defensive)
  //
  // NEVER throws. All provider errors are caught and recorded onto the
  // job row so the operator can see WHY the score failed without
  // grepping daemon logs.
  private async runFheDirectScoring(args: {
    ctx: NonNullable<ReturnType<typeof submissionsRepo.loadResolverContext>>;
    t0row: { p0: string };
    obs: OracleObservation;
  }): Promise<"scored" | "pending" | "skipped"> {
    if (!this.fheProvider) {
      return "skipped";
    }
    const provider = this.fheProvider;
    const nowIso = this.nowIso();

    // 1. Load the ciphertext + circuit binding.
    const ctRow = this.db
      .prepare(
        `SELECT keyset_id, circuit_id, ciphertext_format, ciphertext_blob,
                ciphertext_hash, vector_len, payout_denominator
         FROM fhe_call_ciphertexts
         WHERE call_id = ?`,
      )
      .get(args.ctx.call_id) as
      | {
          keyset_id: string;
          circuit_id: string;
          ciphertext_format: string;
          ciphertext_blob: Buffer;
          ciphertext_hash: string;
          vector_len: number;
          payout_denominator: string;
        }
      | undefined;
    if (!ctRow) {
      // Submission gate failure — fhe_direct row without a ciphertext
      // shouldn't exist. Treat as a hard programmer error rather than a
      // recoverable failure; record onto job for the operator.
      enqueueScoreJob({
        db: this.db,
        call_id: args.ctx.call_id,
        provider: provider.name,
        circuit_id: "(unknown)",
        now: nowIso,
      });
      recordScoreFailure({
        db: this.db,
        call_id: args.ctx.call_id,
        error: "fhe_call_ciphertexts row missing for fhe_direct call",
        now: nowIso,
      });
      return "pending";
    }

    // 2. Look up the circuit by id, derive the handle the provider needs.
    const circuitRow = this.db
      .prepare(
        `SELECT circuit_id, name, vector_max_len, provider, handle
         FROM fhe_circuits WHERE circuit_id = ?`,
      )
      .get(ctRow.circuit_id) as
      | {
          circuit_id: string;
          name: "half_l1_distance_binary" | "half_l1_distance_n";
          vector_max_len: number;
          provider: "mock" | "zama_local";
          handle: string;
        }
      | undefined;
    if (!circuitRow) {
      enqueueScoreJob({
        db: this.db,
        call_id: args.ctx.call_id,
        provider: provider.name,
        circuit_id: ctRow.circuit_id,
        now: nowIso,
      });
      recordScoreFailure({
        db: this.db,
        call_id: args.ctx.call_id,
        error: `fhe_circuits row missing for circuit_id=${ctRow.circuit_id}`,
        now: nowIso,
      });
      return "pending";
    }

    // 3. Dispatch the public outcome through the adapter. We reuse the
    // v2 computeV2OutcomePath helper because the encrypted scoring
    // input is the SAME public outcome vector the legacy v2 path
    // already computes — the only thing changing is what we DO with
    // it. If the adapter says "pending"/"disputed" or returns null,
    // bail; we cannot score without a resolved outcome.
    //
    // The committed v2 path takes a `subject` argument with the
    // plaintext side. For fhe_direct rows the side is encrypted, but
    // the universal outcome lookup doesn't actually consume `subject.side`
    // — only the adapter does, and the native-price adapter uses it
    // for the outcome direction. We mock a synthetic subject built from
    // the ctx's market_id / horizon, and request only the OUTCOME
    // (resolved payout vector), discarding the v2 score computation.
    const marketId = args.ctx.market_id;
    if (!marketId) {
      enqueueScoreJob({
        db: this.db,
        call_id: args.ctx.call_id,
        provider: provider.name,
        circuit_id: ctRow.circuit_id,
        now: nowIso,
      });
      recordScoreFailure({
        db: this.db,
        call_id: args.ctx.call_id,
        error: "fhe_direct call missing market_id (cannot dispatch adapter)",
        now: nowIso,
      });
      return "pending";
    }
    const marketRow = marketsRepo.get(this.db, marketId);
    if (!marketRow) {
      enqueueScoreJob({
        db: this.db,
        call_id: args.ctx.call_id,
        provider: provider.name,
        circuit_id: ctRow.circuit_id,
        now: nowIso,
      });
      recordScoreFailure({
        db: this.db,
        call_id: args.ctx.call_id,
        error: `markets row missing for market_id=${marketId}`,
        now: nowIso,
      });
      return "pending";
    }

    let adapter;
    try {
      adapter = getAdapterForMarket(marketRow);
    } catch (err) {
      enqueueScoreJob({
        db: this.db,
        call_id: args.ctx.call_id,
        provider: provider.name,
        circuit_id: ctRow.circuit_id,
        now: nowIso,
      });
      recordScoreFailure({
        db: this.db,
        call_id: args.ctx.call_id,
        error: `getAdapterForMarket failed: ${err instanceof Error ? err.message : String(err)}`,
        now: nowIso,
      });
      return "pending";
    }

    // For fhe_direct rows, ctx.side is BUY/SELL but it's a fixed default
    // from the submissions row (Z1 records it as 'BUY' on the encrypted
    // path because the schema still has the column NOT NULL). The
    // adapter needs the canonical resolved payout vector, which for
    // native-price binary markets uses side to decide which bucket
    // "wins". Z1 binds side into the commit preimage so the agent's
    // claimed side is non-repudiable; we use ctx.side here. For
    // markets whose outcome is side-independent (categorical), this is
    // a no-op.
    const voidBand =
      args.ctx.market_config_version !== null
        ? voidBandFloat(marketRow)
        : voidBandFloat(marketRow);
    const marketRef = {
      protocol: adapter.name,
      sourceId: marketId,
      configVersion: marketRow.market_config_version ?? 1,
    };
    let observed: UniversalOutcome | "pending" | "disputed";
    try {
      observed = await adapter.observeResolution(marketRef, {
        // Codex P11 review Critical B fix — spread the parsed
        // markets.config_json so adapter-private fields (e.g.
        // Polymarket's conditionId) arrive in the observation
        // context. Native-price adapter's config_json is empty and
        // its narrower ignores unknown keys, so this is a safe
        // additive change.
        ...parseMarketConfigJson(marketRow.config_json),
        t0_p0: args.t0row.p0,
        t1_p1: args.obs.price,
        t1_iso: args.obs.feed_timestamp,
        t1_feed: args.obs.feed,
        t1_source_id: args.obs.source_id,
        void_band: voidBand,
        side: args.ctx.side,
        market_id: marketId,
      });
    } catch (err) {
      enqueueScoreJob({
        db: this.db,
        call_id: args.ctx.call_id,
        provider: provider.name,
        circuit_id: ctRow.circuit_id,
        now: nowIso,
      });
      recordScoreFailure({
        db: this.db,
        call_id: args.ctx.call_id,
        error: `adapter.observeResolution threw: ${err instanceof Error ? err.message : String(err)}`,
        now: nowIso,
      });
      return "pending";
    }
    if (observed === "pending" || observed === "disputed") {
      // Not a failure — just not resolvable this tick. Don't poison
      // the job row; just leave the call at pending_t1.
      return "pending";
    }
    const resolvedOutcome: UniversalOutcome = observed;

    // 4. Enqueue the job and dispatch to the provider.
    enqueueScoreJob({
      db: this.db,
      call_id: args.ctx.call_id,
      provider: provider.name,
      circuit_id: ctRow.circuit_id,
      now: nowIso,
    });

    let scoreResult;
    try {
      scoreResult = await provider.scoreEncrypted({
        circuit: {
          circuit_id: circuitRow.circuit_id,
          name: circuitRow.name,
          handle: circuitRow.handle,
          vector_max_len: circuitRow.vector_max_len,
          provider: circuitRow.provider,
        },
        encrypted_predicted_outcome: ctRow.ciphertext_blob,
        resolved_outcome_numerators: resolvedOutcome.payoutNumerators,
        resolved_outcome_denominator: resolvedOutcome.payoutDenominator,
        // Codex Z2 fixes #6 + #7 — pass keyset, ciphertext format,
        // and call_id so the provider can produce a transcript hash
        // that binds the full identity of the score computation.
        keyset_id: ctRow.keyset_id,
        ciphertext_format: ctRow.ciphertext_format,
        call_id: args.ctx.call_id,
      });
    } catch (err) {
      // FheUnavailableError → transient retry. Any other throw is also
      // recorded but resolver still treats as transient — we explicitly
      // do NOT downgrade to plaintext on a programmer error either.
      const msg = err instanceof Error ? err.message : String(err);
      recordScoreFailure({
        db: this.db,
        call_id: args.ctx.call_id,
        error:
          err instanceof FheUnavailableError
            ? `sidecar unavailable: ${msg}`
            : `scoreEncrypted threw: ${msg}`,
        now: nowIso,
      });
      return "pending";
    }

    // 5. Persist success.
    const score_ciphertext_hash = createHash("sha256")
      .update(scoreResult.encrypted_score)
      .digest("hex");
    const resolvedOutcomeJson = JSON.stringify(serializeOutcome(resolvedOutcome));
    const payoutVectorJson = JSON.stringify(
      resolvedOutcome.payoutNumerators.map((n) => n.toString()),
    );
    // Z3 — canonical resolved-outcome hash binds the decrypt request
    // to the same plaintext payout vector the score was computed
    // against. Holders independently recompute this from the score-job
    // row and refuse to sign if it drifted (see mock-quorum.ts).
    // canonicalResolvedOutcomeBytes mirrors the TS/Rust contract in
    // fhe/provider.ts, so the hash is byte-stable across both sides.
    const canonicalResolvedBytes = canonicalResolvedOutcomeBytesLocal(
      resolvedOutcome.payoutNumerators,
      resolvedOutcome.payoutDenominator,
    );
    const resolvedOutcomeHash = createHash("sha256")
      .update(canonicalResolvedBytes)
      .digest("hex");

    const tx = this.db.transaction(() => {
      recordScoreSuccess({
        db: this.db,
        call_id: args.ctx.call_id,
        encrypted_score: scoreResult.encrypted_score,
        score_ciphertext_hash,
        transcript_hash: scoreResult.transcript_hash,
        now: nowIso,
      });
      resolutionsRepo.setResolution(this.db, {
        call_id: args.ctx.call_id,
        t1: args.obs.feed_timestamp,
        p1: args.obs.price,
        t1_feed: args.obs.feed,
        // signed_return is a plaintext-only artifact (legacy scoring).
        // For fhe_direct rows the universal outcome carries the truth;
        // legacy view queries that read signed_return get "0" — same
        // posture as the oracle_unavailable terminal path.
        signed_return: "0",
        // outcome column is a legacy CHECK enum; the universal outcome
        // sits in resolved_outcome_json. We stamp 'win' as a placeholder
        // here because the column is NOT NULL with a CHECK; consumers
        // that care about the truth read resolved_outcome_json.
        // Choosing 'win' deliberately so leaderboard COUNT(*) FILTER
        // queries don't double-count fhe_direct rows as void.
        outcome: "win",
        // call_score stays NULL — Z3 fills this in after quorum decrypt.
        call_score: null,
        resolved_at: nowIso,
        resolved_outcome_json: resolvedOutcomeJson,
        payout_vector_json: payoutVectorJson,
        score_ciphertext_hash,
        fhe_circuit_id: ctRow.circuit_id,
      });
      // Codex Z3 review FAIL #8 fix — DO NOT flip submissions.status to
      // "resolved" yet. For fhe_direct calls, "resolved" means the
      // bounded score is publicly available, which requires the
      // quorum release (next paragraph below + the release tx in
      // runFheThresholdReleasePhase). Until quorum lands, status stays
      // pending_t1 — sub-state distinguished by fhe_score_jobs.status
      // ('scored_pending_decrypt'). The release tx flips it to
      // 'resolved' atomically with the score write.
      // Z3 — atomic with the score commit: enqueue the decrypt request
      // so the next tick's threshold-release phase has work to do. The
      // helper is idempotent on (call_id, score_ciphertext_hash), so a
      // resolver retry that re-runs scoreEncrypted with the same
      // ciphertext just refreshes nothing.
      enqueueDecryptRequest({
        db: this.db,
        request_id: `dreq_${randomUUID()}`,
        call_id: args.ctx.call_id,
        score_ciphertext_hash,
        transcript_hash: scoreResult.transcript_hash,
        resolved_outcome_hash: resolvedOutcomeHash,
        keyset_id: ctRow.keyset_id,
        now: nowIso,
      });
      usageRepo.emit(
        this.db,
        this.makeUsage(args.ctx.agent_id, "resolution_completed", {
          call_id: args.ctx.call_id,
          // Operator can see "this call resolved with an encrypted score";
          // the bounded plaintext score still lives behind Z3's quorum.
          outcome: "fhe_direct_scored_pending_decrypt",
          score_ciphertext_hash,
        }),
      );
    });
    tx();
    return "scored";
  }

  // ── Z3 — threshold-release phase ──
  //
  // Runs after t1 each tick. For every fhe_decrypt_requests row in
  // 'pending_shares' that has a registered quorumPool, the resolver:
  //
  //   1. Asks every active holder for a partial decrypt
  //      (producePartialDecrypt). Holders independently verify the
  //      request matches DB state and refuse to sign on drift —
  //      that's caught here as a thrown error and counted as a
  //      missing share (NOT a global failure; the call stays pending
  //      until enough other holders sign).
  //   2. Persists each accepted share to fhe_decrypt_shares.
  //   3. After collection, runs validateQuorum + per-share verifyShare.
  //      A quorum-valid share set unblocks aggregate.
  //   4. aggregateShares returns the bounded score; the resolver
  //      writes it onto t1_resolutions.call_score AND
  //      fhe_score_releases (audit trail). The fhe_decrypt_requests
  //      row flips to 'released'.
  //
  // The phase NEVER throws. Per-call failures are logged via
  // this.log() and the request stays at 'pending_shares' for the
  // next tick. The age-identity env (MURMUR_DAEMON_AGE_IDENTITY) is
  // deliberately NOT consulted anywhere in this path: math is the
  // trust root.
  private async runFheThresholdReleasePhase(): Promise<void> {
    if (!this.quorumPool) return; // Z2-only config: nothing to do.
    const pool = this.quorumPool;
    const pending = listPendingDecryptRequests(this.db);
    if (pending.length === 0) return;

    // Cache the enabled-holder list once per tick. The pool emits
    // ThresholdHolder objects (with the live signing key); the DB
    // table carries the public_identity for verifyShare. Match by
    // holder_id.
    const dbHolders = listActiveKeyHolders(this.db);
    const dbByHolderId = new Map(dbHolders.map((h) => [h.holder_id, h]));

    for (const req of pending) {
      try {
        await this.tryReleaseDecryptRequest(req, pool.holders(), dbByHolderId);
      } catch (err) {
        // tryReleaseDecryptRequest already logs per-call; this catch
        // is the bulkhead so one bad request can't kill the whole
        // tick.
        this.log({
          kind: "still_pending",
          call_id: req.call_id,
          phase: "t1",
          reason: `fhe_threshold:tick_error:${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  }

  private async tryReleaseDecryptRequest(
    req: {
      request_id: string;
      call_id: string;
      score_ciphertext_hash: string;
      transcript_hash: string;
      resolved_outcome_hash: string;
      keyset_id: string;
    },
    holders: ReadonlyArray<ThresholdHolder>,
    dbByHolderId: Map<string, ReturnType<typeof listActiveKeyHolders>[number]>,
  ): Promise<void> {
    // Score-ciphertext bytes live on the score-job row; we need them
    // in the request body so each holder can verify the hash. The
    // call_id → ciphertext path is the same one the score-time tx
    // wrote to.
    const ctRow = this.db
      .prepare(
        `SELECT score_ciphertext FROM fhe_score_jobs
         WHERE call_id = ? AND status = 'scored_pending_decrypt'`,
      )
      .get(req.call_id) as { score_ciphertext: Buffer } | undefined;
    if (!ctRow) {
      this.log({
        kind: "still_pending",
        call_id: req.call_id,
        phase: "t1",
        reason: "fhe_threshold:no_scored_ciphertext",
      });
      return;
    }

    const nowIso = this.nowIso();
    const partialReq: PartialDecryptRequest = {
      request_id: req.request_id,
      call_id: req.call_id,
      keyset_id: req.keyset_id,
      score_ciphertext: new Uint8Array(ctRow.score_ciphertext),
      score_ciphertext_hash: req.score_ciphertext_hash,
      transcript_hash: req.transcript_hash,
      resolved_outcome_hash: req.resolved_outcome_hash,
    };

    // 1. Collect shares from every active holder. Per-holder errors
    // are non-fatal (refusal to sign is a feature, not a bug — see
    // the splice-attack defense in mock-quorum.ts).
    const collected: PartialDecryptShare[] = [];
    for (const h of holders) {
      if (!h.record.enabled) continue;
      try {
        const share = await h.producePartialDecrypt(partialReq);
        // Persist before verifying — the audit trail wants the raw
        // submission so a third party reading the transcript can
        // diagnose a bad-share holder out of band.
        persistDecryptShare({
          db: this.db,
          share_id: `dshr_${randomUUID()}`,
          request_id: req.request_id,
          holder_id: share.holder_id,
          partial_decrypt: share.partial_decrypt,
          share_signature: share.share_signature,
          now: nowIso,
        });
        collected.push(share);
      } catch (err) {
        this.log({
          kind: "still_pending",
          call_id: req.call_id,
          phase: "t1",
          reason: `fhe_threshold:holder_${h.record.holder_id}_refused:${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    // 2. Verify per-share signatures using the DB-stored public
    // identity (NOT the holder's claimed public identity from the
    // pool — the DB is the source of truth for "who can sign for
    // this holder_id"). A share whose signature doesn't verify is
    // dropped silently from the quorum count.
    //
    // Codex Z3 review FAIL #2 fix — also overwrite the share's
    // `category` with the DB-truth value before passing to
    // validateQuorum(). The previous code trusted the caller-supplied
    // category, which let a malicious holder claim category='partner'
    // when its DB row said category='agent', bypassing the
    // ≥2-non-agent + ≥2-non-murmur policy. The DB is the source of
    // truth for "what category is this holder_id".
    const verified = collected
      .filter((s) => {
        const dbHolder = dbByHolderId.get(s.holder_id);
        if (!dbHolder) return false;
        return verifyShare(s, dbHolder.public_identity, req.transcript_hash);
      })
      .map((s) => {
        const dbHolder = dbByHolderId.get(s.holder_id);
        // Type-safe non-null — the filter above just proved presence.
        return {
          ...s,
          category: dbHolder!.category,
        };
      });

    // 3. Quorum check.
    const quorum = validateQuorum(verified);
    if (!quorum.ok) {
      this.log({
        kind: "still_pending",
        call_id: req.call_id,
        phase: "t1",
        reason: `fhe_threshold:quorum_unmet:${quorum.reason}`,
      });
      return;
    }

    // 4. Aggregate + release atomically.
    const aggregated = aggregateShares(verified);
    const quorumSigsJson = JSON.stringify(
      verified.map((s) => ({
        holder_id: s.holder_id,
        public_identity: dbByHolderId.get(s.holder_id)?.public_identity ?? null,
        share_signature: s.share_signature,
        category: s.category,
      })),
    );

    const releaseTx = this.db.transaction(() => {
      // Stamp the call_score onto the resolution row.
      this.db
        .prepare(
          `UPDATE t1_resolutions
           SET call_score = ?
           WHERE call_id = ?`,
        )
        .run(aggregated.score, req.call_id);
      setRequestStatus(this.db, req.request_id, "released", nowIso);
      persistScoreRelease({
        db: this.db,
        request_id: req.request_id,
        call_id: req.call_id,
        released_score: aggregated.score,
        quorum_signatures: quorumSigsJson,
        now: nowIso,
      });
      // Codex Z3 review FAIL #8 fix — flip submissions.status to
      // "resolved" HERE (atomic with the release) instead of at score
      // time. For fhe_direct, "resolved" means the bounded score is
      // released and the leaderboard can read it; that only happens
      // after quorum, never before.
      submissionsRepo.setStatus(this.db, req.call_id, "resolved");
    });
    releaseTx();

    this.log({
      kind: "anchored_t1",
      call_id: req.call_id,
      // Placeholder fields for the legacy log shape — the actual
      // event the operator cares about is the threshold release,
      // surfaced via /v1/calls/:id/fhe-transcript.
      feed: "kraken" as OracleFeed,
      p1: aggregated.score.toFixed(9),
      outcome: "win",
    });
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
  private async computeV2OutcomePath(args: {
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
  }): Promise<{
    commitment: ReturnType<typeof legacySubmissionToCommitment>;
    outcome: UniversalOutcome;
    score: ReturnType<typeof scoreOutcomeVector>;
    adapter_id: string;
  } | null> {
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

    // Wave 4d — dispatch t1 observation through the adapter via the registry.
    // Lift the resolver-scoped values into the adapter's observation context.
    // The adapter (native-price today) narrows the context structurally; a
    // malformed context maps to "pending" so the resolver falls through to its
    // still-pending path rather than crashing the tick.
    const voidBand =
      args.subjectVoidBand !== undefined
        ? args.subjectVoidBand
        : voidBandFloat(marketRow);
    const marketRef = {
      protocol: adapter.name,
      sourceId: marketId,
      configVersion:
        marketRow.market_config_version ??
        args.subject.market_config_version ??
        1,
    };
    let observed: UniversalOutcome | "pending" | "disputed";
    try {
      observed = await adapter.observeResolution(marketRef, {
        // Codex P11 review Critical B fix (legacy plaintext path) —
        // mirror the fhe_direct branch above. Spread markets.config_json
        // so Polymarket gets conditionId from the markets row.
        ...parseMarketConfigJson(marketRow.config_json),
        t0_p0: args.t0row.p0,
        t1_p1: args.obs.price,
        t1_iso: args.obs.feed_timestamp,
        t1_feed: args.obs.feed,
        t1_source_id: args.obs.source_id,
        void_band: voidBand,
        side: args.subject.side,
        market_id: marketId,
      });
    } catch {
      return null;
    }
    if (observed === "pending" || observed === "disputed") {
      // Adapter declined to resolve this tick — fall through to legacy-only
      // path; the resolver's outer loop will surface a still_pending log.
      return null;
    }
    const outcome: UniversalOutcome = observed;

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
      // Wave 4d — dispatch scoring via the registry-resolved adapter so the
      // call_score number is produced by adapter.score(commitment, outcome).
      // Void / kind-mismatch reconciliation stays inside scoreOutcomeVector.
      score = scoreOutcomeVector(commitment, outcome, adapter);
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
