import type Database from "better-sqlite3";

import {
  Outcome,
} from "./schema.js";
import { marketsRepo } from "./repos/market-registry-repo.js";
import { resolutionsRepo } from "./repos/resolution-repo.js";
import { submissionsRepo } from "./repos/sealed-call-submissions-repo.js";
import { usageRepo } from "./repos/usage-events-repo.js";
import {
  scoreOutcomeVector,
} from "./scoring.js";
import {
  getAdapterForMarket,
} from "./markets.js";
import { parseStoredCommitment } from "./sealed-call-commitment.js";
import { type Outcome as UniversalOutcome } from "./markets-core.js";
import {
  buildAdapterObservationContext,
} from "./market-adapter-config.js";
import type {
  ResolutionLifecycleLog,
  ResolverContext,
} from "./resolution-lifecycle-types.js";
import { markOracleUnavailable } from "./resolution-oracle-unavailable.js";
import { resolutionOutcomeEvidenceJson } from "./resolution-outcome-evidence.js";
import { makeResolutionUsage } from "./resolution-usage.js";
import { isoFromMs, nowIso } from "./time.js";

export async function resolveRevealedAdapter(input: {
  db: Database.Database;
  ctx: ResolverContext;
  now: () => Date;
  log: ResolutionLifecycleLog;
}): Promise<
  | { kind: "resolved"; adapter: string; outcome: Outcome; call_score: number | null }
  | { kind: "oracle_unavailable" }
  | { kind: "pending" }
  | { kind: "skipped_terminal" }
> {
  const marketId = input.ctx.market_id;
  if (!marketId) {
    input.log({
      kind: "still_pending",
      call_id: input.ctx.call_id,
      phase: "t1",
      reason: "sealed_fhenix:missing_market_id",
    });
    const written = await markOracleUnavailable({ ...input, phase: "t1" });
    return written ? { kind: "oracle_unavailable" } : { kind: "skipped_terminal" };
  }
  const marketRow = marketsRepo.get(input.db, marketId);
  if (!marketRow) {
    input.log({
      kind: "still_pending",
      call_id: input.ctx.call_id,
      phase: "t1",
      reason: `sealed_fhenix:unknown_market:${marketId}`,
    });
    const written = await markOracleUnavailable({ ...input, phase: "t1" });
    return written ? { kind: "oracle_unavailable" } : { kind: "skipped_terminal" };
  }
  const commitment = parseStoredCommitment(input.ctx.commitment_json);
  if (!commitment) {
    input.log({
      kind: "still_pending",
      call_id: input.ctx.call_id,
      phase: "t1",
      reason: "sealed_fhenix:missing_revealed_commitment_json",
    });
    const written = await markOracleUnavailable({ ...input, phase: "t1" });
    return written ? { kind: "oracle_unavailable" } : { kind: "skipped_terminal" };
  }

  let adapter;
  try {
    adapter = getAdapterForMarket(marketRow);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // A RETIRED market's adapter is gone for good (MIGRATION_061 retires the
    // native-price/financial-direction rows whose adapter this codebase no
    // longer registers), so its calls can never be scored — terminalize them
    // in the null-score bucket instead of re-queueing forever. A missing
    // adapter on a still-listed market is treated as transient (e.g. adapter
    // registration lost a boot race) and stays retryable.
    if (marketRow.status === "retired") {
      input.log({
        kind: "still_pending",
        call_id: input.ctx.call_id,
        phase: "t1",
        reason: `sealed_fhenix:adapter_retired:${detail}`,
      });
      const written = await markOracleUnavailable({ ...input, phase: "t1" });
      return written ? { kind: "oracle_unavailable" } : { kind: "skipped_terminal" };
    }
    input.log({
      kind: "still_pending",
      call_id: input.ctx.call_id,
      phase: "t1",
      reason: `sealed_fhenix:adapter_missing:${detail}`,
    });
    return { kind: "pending" };
  }
  if (
    commitment.marketRef.protocol !== adapter.name ||
    commitment.marketRef.sourceId.toLowerCase() !== marketId.toLowerCase()
  ) {
    input.log({
      kind: "still_pending",
      call_id: input.ctx.call_id,
      phase: "t1",
      reason: "sealed_fhenix:revealed_commitment_market_mismatch",
    });
    const written = await markOracleUnavailable({ ...input, phase: "t1" });
    return written ? { kind: "oracle_unavailable" } : { kind: "skipped_terminal" };
  }

  let observed: UniversalOutcome | "pending" | "disputed";
  try {
    observed = await adapter.observeResolution(
      commitment.marketRef,
      buildAdapterObservationContext(marketRow),
    );
  } catch (err) {
    input.log({
      kind: "still_pending",
      call_id: input.ctx.call_id,
      phase: "t1",
      reason: `sealed_fhenix:adapter_observe_failed:${err instanceof Error ? err.message : String(err)}`,
    });
    return { kind: "pending" };
  }
  if (observed === "pending" || observed === "disputed") {
    return { kind: "pending" };
  }

  const score = scoreOutcomeVector(commitment, observed, adapter);
  const outcome = legacyOutcomeFromVectorScore(score);
  if (outcome === null) {
    input.log({
      kind: "still_pending",
      call_id: input.ctx.call_id,
      phase: "t1",
      reason: "sealed_fhenix:resolved_outcome_not_scoreable",
    });
    const written = await markOracleUnavailable({ ...input, phase: "t1" });
    return written ? { kind: "oracle_unavailable" } : { kind: "skipped_terminal" };
  }

  const outcomeEvidence = resolutionOutcomeEvidenceJson(observed);
  const resolvedAtIso = isoFromMs(observed.resolvedAt * 1000);
  const now = nowIso(input.now());
  const tx = input.db.transaction(() => {
    const written = resolutionsRepo.setResolution(input.db, {
      call_id: input.ctx.call_id,
      t1: resolvedAtIso,
      // Murmur observes no prices: p1 / t1_feed / signed_return are legacy
      // price-anchor evidence columns and are always NULL (migration 055 made
      // them nullable). The score lives in its own column; the adapter
      // identity + observation are carried by outcomeEvidence + usage event.
      p1: null,
      t1_feed: null,
      signed_return: null,
      outcome,
      call_score: score.call_score,
      resolved_at: now,
      ...outcomeEvidence,
    });
    if (!written) return false;
    submissionsRepo.setStatus(input.db, input.ctx.call_id, "resolved");
    usageRepo.emit(
      input.db,
      makeResolutionUsage(input.ctx.agent_id, "resolution_completed", {
        call_id: input.ctx.call_id,
        outcome,
        call_score: score.call_score,
        adapter_id: adapter.name,
      }, input.now),
    );
    return true;
  });
  const writtenAdapter = tx();
  if (!writtenAdapter) return { kind: "skipped_terminal" };
  return {
    kind: "resolved",
    adapter: adapter.name,
    outcome,
    call_score: score.call_score,
  };
}

function legacyOutcomeFromVectorScore(
  score: ReturnType<typeof scoreOutcomeVector>,
): Outcome | null {
  if (score.call_score === null) {
    return score.void ? "void" : null;
  }
  return score.call_score > 0.5 ? "win" : "loss";
}
