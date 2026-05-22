import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  AssetId,
  HorizonHours,
  OracleFeed,
  Outcome,
  Side,
  type UsageEvent,
} from "./schema.js";
import {
  anchorsRepo,
  marketsRepo,
  resolutionsRepo,
  submissionsRepo,
  usageRepo,
} from "./db.js";
import type { OracleObservation } from "../integrations/oracle.js";
import {
  computeSignedReturn,
  outcomeFromSignedReturn,
  scoreCall,
  scoreOutcomeVector,
} from "./scoring.js";
import {
  getAdapterForMarket,
  legacyHorizonHoursForMarket,
  voidBandFloat,
} from "./markets.js";
import { parseStoredCommitment } from "./submission-normalizers.js";
import {
  serializeOutcome,
  type Commitment,
  type Outcome as UniversalOutcome,
} from "./markets-core.js";
import {
  buildAdapterObservationContext,
  parseMarketConfigJson,
} from "./market-adapter-config.js";
import { isoFromMs, nowIso } from "./time.js";

type ResolverContext = NonNullable<ReturnType<typeof submissionsRepo.loadResolverContext>>;

export type ResolutionLifecycleLogEvent =
  | { kind: "oracle_unavailable"; call_id: string; phase: "t0" | "t1" }
  | { kind: "still_pending"; call_id: string; phase: "t0" | "t1"; reason: string };

type Log = (line: ResolutionLifecycleLogEvent) => void;

export async function resolveRevealedNativePrice(input: {
  db: Database.Database;
  ctx: ResolverContext;
  t0row: { p0: string };
  obs: OracleObservation;
  now: () => Date;
  log: Log;
}): Promise<
  | { kind: "resolved"; outcome: Outcome }
  | { kind: "oracle_unavailable" }
  | { kind: "pending" }
> {
  const marketId = input.ctx.market_id;
  if (!marketId) {
    input.log({
      kind: "still_pending",
      call_id: input.ctx.call_id,
      phase: "t1",
      reason: "sealed_fhenix:missing_market_id",
    });
    await markOracleUnavailable({ ...input, phase: "t1" });
    return { kind: "oracle_unavailable" };
  }
  const marketRow = marketsRepo.get(input.db, marketId);
  if (!marketRow) {
    input.log({
      kind: "still_pending",
      call_id: input.ctx.call_id,
      phase: "t1",
      reason: `sealed_fhenix:unknown_market:${marketId}`,
    });
    await markOracleUnavailable({ ...input, phase: "t1" });
    return { kind: "oracle_unavailable" };
  }
  const commitment = parseStoredCommitment(input.ctx.commitment_json);
  if (!commitment) {
    input.log({
      kind: "still_pending",
      call_id: input.ctx.call_id,
      phase: "t1",
      reason: "sealed_fhenix:missing_revealed_commitment_json",
    });
    await markOracleUnavailable({ ...input, phase: "t1" });
    return { kind: "oracle_unavailable" };
  }
  const side = sideFromNativePriceCommitment(commitment);
  if (!side) {
    input.log({
      kind: "still_pending",
      call_id: input.ctx.call_id,
      phase: "t1",
      reason: "sealed_fhenix:commitment_not_native_price_one_hot",
    });
    await markOracleUnavailable({ ...input, phase: "t1" });
    return { kind: "oracle_unavailable" };
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
    await markOracleUnavailable({ ...input, phase: "t1" });
    return { kind: "oracle_unavailable" };
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
  const resolvedOutcomeJson = JSON.stringify(serializeOutcome(observed));
  const payoutVectorJson = JSON.stringify(
    observed.payoutNumerators.map((n) => n.toString()),
  );
  const resolvedAt = nowIso(input.now());
  const tx = input.db.transaction(() => {
    resolutionsRepo.setResolution(input.db, {
      call_id: input.ctx.call_id,
      t1: input.obs.feed_timestamp,
      p1: input.obs.price,
      t1_feed: input.obs.feed,
      signed_return: String(signedReturn),
      outcome,
      call_score: score.call_score,
      resolved_at: resolvedAt,
      resolved_outcome_json: resolvedOutcomeJson,
      payout_vector_json: payoutVectorJson,
    });
    submissionsRepo.setStatus(input.db, input.ctx.call_id, "resolved");
    usageRepo.emit(
      input.db,
      makeUsage(input.ctx.agent_id, "resolution_completed", {
        call_id: input.ctx.call_id,
        outcome,
        call_score: score.call_score,
      }, input.now),
    );
  });
  tx();
  return { kind: "resolved", outcome };
}

export async function resolveRevealedAdapter(input: {
  db: Database.Database;
  ctx: ResolverContext;
  now: () => Date;
  log: Log;
}): Promise<
  | { kind: "resolved"; adapter: string; outcome: Outcome; call_score: number | null }
  | { kind: "oracle_unavailable" }
  | { kind: "pending" }
> {
  const marketId = input.ctx.market_id;
  if (!marketId) {
    input.log({
      kind: "still_pending",
      call_id: input.ctx.call_id,
      phase: "t1",
      reason: "sealed_fhenix:missing_market_id",
    });
    await markOracleUnavailable({ ...input, phase: "t1" });
    return { kind: "oracle_unavailable" };
  }
  const marketRow = marketsRepo.get(input.db, marketId);
  if (!marketRow) {
    input.log({
      kind: "still_pending",
      call_id: input.ctx.call_id,
      phase: "t1",
      reason: `sealed_fhenix:unknown_market:${marketId}`,
    });
    await markOracleUnavailable({ ...input, phase: "t1" });
    return { kind: "oracle_unavailable" };
  }
  const commitment = parseStoredCommitment(input.ctx.commitment_json);
  if (!commitment) {
    input.log({
      kind: "still_pending",
      call_id: input.ctx.call_id,
      phase: "t1",
      reason: "sealed_fhenix:missing_revealed_commitment_json",
    });
    await markOracleUnavailable({ ...input, phase: "t1" });
    return { kind: "oracle_unavailable" };
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
  if (adapter.name === "native-price") {
    input.log({
      kind: "still_pending",
      call_id: input.ctx.call_id,
      phase: "t1",
      reason: "sealed_fhenix:adapter_path_received_native_price",
    });
    await markOracleUnavailable({ ...input, phase: "t1" });
    return { kind: "oracle_unavailable" };
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
    await markOracleUnavailable({ ...input, phase: "t1" });
    return { kind: "oracle_unavailable" };
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
    await markOracleUnavailable({ ...input, phase: "t1" });
    return { kind: "oracle_unavailable" };
  }

  const resolvedOutcomeJson = JSON.stringify(serializeOutcome(observed));
  const payoutVectorJson = JSON.stringify(
    observed.payoutNumerators.map((n) => n.toString()),
  );
  const resolvedAtIso = isoFromMs(observed.resolvedAt * 1000);
  const now = nowIso(input.now());
  const tx = input.db.transaction(() => {
    resolutionsRepo.setResolution(input.db, {
      call_id: input.ctx.call_id,
      t1: resolvedAtIso,
      p1: score.call_score === null ? "0" : String(score.call_score),
      t1_feed: adapter.name,
      signed_return: "0",
      outcome,
      call_score: score.call_score,
      resolved_at: now,
      resolved_outcome_json: resolvedOutcomeJson,
      payout_vector_json: payoutVectorJson,
    });
    submissionsRepo.setStatus(input.db, input.ctx.call_id, "resolved");
    usageRepo.emit(
      input.db,
      makeUsage(input.ctx.agent_id, "resolution_completed", {
        call_id: input.ctx.call_id,
        outcome,
        call_score: score.call_score,
        adapter_id: adapter.name,
      }, input.now),
    );
  });
  tx();
  return {
    kind: "resolved",
    adapter: adapter.name,
    outcome,
    call_score: score.call_score,
  };
}

export async function markOracleUnavailable(input: {
  db: Database.Database;
  ctx: ResolverContext;
  phase: "t0" | "t1";
  now: () => Date;
  log: Log;
}): Promise<boolean> {
  const resolvedAt = nowIso(input.now());
  const t0row = anchorsRepo.getT0(input.db, input.ctx.call_id);
  const placeholderFeed: OracleFeed = "chainlink:base:ETH-USD";
  const t1Feed = (t0row?.feed ?? placeholderFeed) as OracleFeed;
  const tx = input.db.transaction(() => {
    resolutionsRepo.setResolution(input.db, {
      call_id: input.ctx.call_id,
      t1: resolvedAt,
      p1: "0",
      t1_feed: t1Feed,
      signed_return: "0",
      outcome: "oracle_unavailable",
      call_score: null,
      resolved_at: resolvedAt,
    });
    submissionsRepo.setStatus(input.db, input.ctx.call_id, "resolved");
    usageRepo.emit(
      input.db,
      makeUsage(input.ctx.agent_id, "resolution_completed", {
        call_id: input.ctx.call_id,
        outcome: "oracle_unavailable",
        phase: input.phase,
      }, input.now),
    );
  });
  tx();
  input.log({
    kind: "oracle_unavailable",
    call_id: input.ctx.call_id,
    phase: input.phase,
  });
  return true;
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

function legacyOutcomeFromVectorScore(
  score: ReturnType<typeof scoreOutcomeVector>,
): Outcome | null {
  if (score.call_score === null) {
    return score.void ? "void" : null;
  }
  return score.call_score > 0.5 ? "win" : "loss";
}

function makeUsage(
  agent_id: string,
  kind: UsageEvent["kind"],
  attributes: Record<string, unknown>,
  now: () => Date,
): UsageEvent {
  return {
    event_id: randomUUID(),
    agent_id,
    kind,
    ts: nowIso(now()),
    attributes,
  };
}
