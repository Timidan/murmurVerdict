import type Database from "better-sqlite3";

import {
  AssetId,
  HorizonHours,
  Outcome,
  Side,
} from "./schema.js";
import { marketsRepo } from "./repos/market-registry-repo.js";
import { resolutionsRepo } from "./repos/resolution-repo.js";
import { submissionsRepo } from "./repos/sealed-call-submissions-repo.js";
import { usageRepo } from "./repos/usage-events-repo.js";
import type { OracleObservation } from "../integrations/oracle.js";
import {
  computeSignedReturn,
  outcomeFromSignedReturn,
  scoreCall,
} from "./scoring.js";
import {
  getAdapterForMarket,
  legacyHorizonHoursForMarket,
  voidBandFloat,
} from "./markets.js";
import { parseStoredCommitment } from "./sealed-call-commitment.js";
import {
  type Commitment,
  type Outcome as UniversalOutcome,
} from "./markets-core.js";
import {
  parseMarketConfigJson,
} from "./market-adapter-config.js";
import type {
  ResolutionLifecycleLog,
  ResolverContext,
} from "./resolution-lifecycle-types.js";
import { markOracleUnavailable } from "./resolution-oracle-unavailable.js";
import { resolutionOutcomeEvidenceJson } from "./resolution-outcome-evidence.js";
import { makeResolutionUsage } from "./resolution-usage.js";
import { nowIso } from "./time.js";

export async function resolveRevealedNativePrice(input: {
  db: Database.Database;
  ctx: ResolverContext;
  t0row: { p0: string };
  obs: OracleObservation;
  now: () => Date;
  log: ResolutionLifecycleLog;
}): Promise<
  | { kind: "resolved"; outcome: Outcome }
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
  const side = sideFromNativePriceCommitment(commitment);
  if (!side) {
    input.log({
      kind: "still_pending",
      call_id: input.ctx.call_id,
      phase: "t1",
      reason: "sealed_fhenix:commitment_not_native_price_one_hot",
    });
    const written = await markOracleUnavailable({ ...input, phase: "t1" });
    return written ? { kind: "oracle_unavailable" } : { kind: "skipped_terminal" };
  }

  let adapter;
  try {
    adapter = getAdapterForMarket(marketRow);
  } catch (err) {
    input.log({
      kind: "still_pending",
      call_id: input.ctx.call_id,
      phase: "t1",
      reason: `sealed_fhenix:adapter_missing:${err instanceof Error ? err.message : String(err)}`,
    });
    return { kind: "pending" };
  }
  if (adapter.name !== "native-price") {
    input.log({
      kind: "still_pending",
      call_id: input.ctx.call_id,
      phase: "t1",
      reason: `sealed_fhenix:unsupported_adapter:${adapter.name}`,
    });
    const written = await markOracleUnavailable({ ...input, phase: "t1" });
    return written ? { kind: "oracle_unavailable" } : { kind: "skipped_terminal" };
  }

  const voidBand = voidBandFloat(marketRow);
  const marketRef = {
    protocol: adapter.name,
    sourceId: marketId,
    configVersion: marketRow.market_config_version ?? 1,
  };
  let observed: UniversalOutcome | "pending" | "disputed";
  try {
    observed = await adapter.observeResolution(marketRef, {
      ...parseMarketConfigJson(marketRow.config_json),
      t0_p0: input.t0row.p0,
      t1_p1: input.obs.price,
      t1_iso: input.obs.feed_timestamp,
      t1_feed: input.obs.feed,
      t1_source_id: input.obs.source_id,
      void_band: voidBand,
      side,
      market_id: marketId,
    });
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

  const signedReturn = computeSignedReturn(side, input.t0row.p0, input.obs.price);
  const outcome = outcomeFromSignedReturn(signedReturn, voidBand);
  const horizonHours = legacyHorizonHoursForMarket(marketRow) as HorizonHours;
  const score = scoreCall({
    asset_id: marketRow.asset_id as AssetId,
    horizon_hours: horizonHours,
    horizon_seconds: marketRow.horizon_seconds,
    confidence: commitment.confidence,
    signed_return: signedReturn,
    outcome,
  });
  const outcomeEvidence = resolutionOutcomeEvidenceJson(observed);
  const resolvedAt = nowIso(input.now());
  const tx = input.db.transaction(() => {
    const written = resolutionsRepo.setResolution(input.db, {
      call_id: input.ctx.call_id,
      t1: input.obs.feed_timestamp,
      p1: input.obs.price,
      t1_feed: input.obs.feed,
      signed_return: String(signedReturn),
      outcome,
      call_score: score.call_score,
      resolved_at: resolvedAt,
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
      }, input.now),
    );
    return true;
  });
  const written = tx();
  if (!written) return { kind: "skipped_terminal" };
  return { kind: "resolved", outcome };
}

function sideFromNativePriceCommitment(commitment: Commitment): Side | null {
  const predicted = commitment.predictedOutcome;
  if (
    predicted.kind !== "binary" ||
    predicted.payoutNumerators.length !== 2 ||
    predicted.payoutDenominator <= 0n
  ) {
    return null;
  }
  const [up, down] = predicted.payoutNumerators;
  if (up === predicted.payoutDenominator && down === 0n) return "BUY";
  if (up === 0n && down === predicted.payoutDenominator) return "SELL";
  return null;
}
