import type { MarketRow } from "./repos/market-registry-repo.js";
import { getAdapterForMarket } from "./markets.js";
import type { Commitment, MarketRef } from "./markets-core.js";
import type { ObservationContext } from "../markets/types.js";
import { isoFromMs, parseIsoMs } from "./time.js";

const CONDITION_ID_REGEX = /^0x[0-9a-fA-F]{64}$/;

export interface CommitmentWire {
  marketRef: Commitment["marketRef"];
  predictedOutcome: {
    kind: string;
    payoutNumerators: string[];
    payoutDenominator: string;
    scalarValue?: string;
  };
  horizon: Commitment["horizon"];
  confidence: number;
}

export function commitmentToWire(commitment: Commitment): CommitmentWire {
  return {
    marketRef: commitment.marketRef,
    predictedOutcome: {
      kind: commitment.predictedOutcome.kind,
      payoutNumerators: commitment.predictedOutcome.payoutNumerators.map((n) =>
        n.toString()
      ),
      payoutDenominator: commitment.predictedOutcome.payoutDenominator.toString(),
      ...(commitment.predictedOutcome.scalarValue !== undefined
        ? { scalarValue: commitment.predictedOutcome.scalarValue.toString() }
        : {}),
    },
    horizon: commitment.horizon,
    confidence: commitment.confidence,
  };
}

export function marketRefForMarket(market: Pick<
  MarketRow,
  "adapter_id" | "market_id" | "market_config_version"
>): MarketRef {
  if (!market.adapter_id) {
    throw new Error(
      `marketRefForMarket: market '${market.market_id}' has no adapter_id`,
    );
  }
  return {
    protocol: market.adapter_id,
    sourceId: market.market_id,
    configVersion: market.market_config_version,
  };
}

export function parseMarketConfigJson(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string" || raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fail-soft: malformed market config should not crash a whole tick.
  }
  return {};
}

export function conditionIdForMarketConfig(raw: unknown): string | null {
  const config = parseMarketConfigJson(raw);
  return typeof config.conditionId === "string" &&
    CONDITION_ID_REGEX.test(config.conditionId)
    ? config.conditionId
    : null;
}

export function endDateMsForMarketConfig(raw: unknown): number | null {
  const config = parseMarketConfigJson(raw);
  if (typeof config.endDate !== "string") return null;
  const endDateMs = Date.parse(config.endDate);
  return Number.isFinite(endDateMs) ? endDateMs : null;
}

export function expectedRevealOpenMsForMarket(
  market: Pick<
    MarketRow,
    "adapter_id" | "market_id" | "market_config_version" | "horizon_seconds" | "config_json"
  >,
  acceptedAtMs: number,
): number {
  const config = parseMarketConfigJson(market.config_json);
  try {
    const adapter = getAdapterForMarket(market as MarketRow);
    const delegated = adapter.expectedRevealOpenAt?.({
      marketRef: marketRefForMarket(market),
      config,
      acceptedAtMs,
      horizonSeconds: market.horizon_seconds,
    });
    if (typeof delegated === "number" && Number.isFinite(delegated)) {
      return delegated;
    }
  } catch {
    // Fail-soft: an unregistered adapter or a partial historical row still
    // needs a reveal window. The acceptance guard is what refuses such a row.
  }

  // The adapter declined to name a window (e.g. Polymarket with a null
  // endDate). Fall back to the market's own horizon.
  return acceptedAtMs + market.horizon_seconds * 1000;
}

/**
 * When the market resolves, distinct from {@link expectedRevealOpenMsForMarket} (when murmur unseals).
 * Falls back to the reveal time, which is only correct with zero embargo.
 */
export function marketResolutionMsForMarket(
  market: Pick<
    MarketRow,
    "adapter_id" | "market_id" | "market_config_version" | "horizon_seconds" | "config_json"
  >,
  acceptedAtMs: number,
): number {
  const config = parseMarketConfigJson(market.config_json);
  try {
    const adapter = getAdapterForMarket(market as MarketRow);
    const delegated = adapter.marketResolutionAt?.({
      marketRef: marketRefForMarket(market),
      config,
      acceptedAtMs,
      horizonSeconds: market.horizon_seconds,
    });
    if (typeof delegated === "number" && Number.isFinite(delegated)) {
      return delegated;
    }
  } catch {
    // Same fail-soft contract as the reveal-window resolver above.
  }
  return expectedRevealOpenMsForMarket(market, acceptedAtMs);
}

export function outcomeLabelsForMarket(
  market: Pick<MarketRow, "adapter_id" | "market_id" | "market_config_version" | "config_json">,
): string[] {
  const config = parseMarketConfigJson(market.config_json);
  try {
    const adapter = getAdapterForMarket(market as MarketRow);
    const delegated = adapter.outcomeLabels?.({
      marketRef: marketRefForMarket(market),
      config,
    });
    if (
      Array.isArray(delegated) &&
      delegated.length === 2 &&
      delegated.every((label) => typeof label === "string" && label.length > 0)
    ) {
      return delegated;
    }
  } catch {
    // Fall through to the historical labels below.
  }

  const labels = config.outcomes;
  if (
    Array.isArray(labels) &&
    labels.length === 2 &&
    labels.every((label) => typeof label === "string" && label.length > 0)
  ) {
    return labels as string[];
  }
  return ["outcome_0", "outcome_1"];
}

export function binaryCommitmentFromReveal(input: {
  binary_index: 0 | 1;
  confidence: number;
  market: Pick<
    MarketRow,
    "adapter_id" | "market_id" | "market_config_version" | "horizon_seconds" | "config_json"
  >;
  accepted_at: string;
}): Commitment {
  const acceptedAtMs = parseIsoMs(input.accepted_at, "accepted_at");
  // A commitment's horizon is market resolution, not murmur's embargoed reveal.
  const expectedResolveMs = marketResolutionMsForMarket(input.market, acceptedAtMs);
  return {
    marketRef: marketRefForMarket(input.market),
    predictedOutcome: {
      kind: "binary",
      payoutNumerators: input.binary_index === 0 ? [1n, 0n] : [0n, 1n],
      payoutDenominator: 1n,
    },
    horizon: {
      iso: isoFromMs(expectedResolveMs),
      resolvesAfterMin: Math.max(
        0,
        Math.floor((expectedResolveMs - acceptedAtMs) / 60_000),
      ),
    },
    confidence: input.confidence,
  };
}

export function buildAdapterObservationContext(
  market: Pick<
    MarketRow,
    "adapter_id" | "market_id" | "market_config_version" | "config_json"
  >,
): ObservationContext {
  const config = parseMarketConfigJson(market.config_json);
  try {
    const adapter = getAdapterForMarket(market as MarketRow);
    const delegated = adapter.buildObservationContext?.({
      marketRef: marketRefForMarket(market),
      config,
      market_id: market.market_id,
    });
    if (delegated) return delegated;
  } catch {
    // The resolver handles adapter-missing separately; this helper stays fail-soft.
  }
  return {
    ...config,
    market_id: market.market_id,
  };
}
