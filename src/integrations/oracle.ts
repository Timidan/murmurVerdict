import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
import {
  DEFAULT_T0_POLICY,
  OracleFeed,
  T0Policy,
} from "../verdict/schema.js";

// Minimal structural shape so we can type-erase viem's chain-narrowed
// PublicClient and still allow test injection.
interface ReadContractClient {
  readContract: (args: {
    address: `0x${string}`;
    abi: readonly unknown[];
    functionName: string;
    args?: readonly unknown[];
  }) => Promise<unknown>;
}

// ─── Feed registry ────────────────────────────────────────────────────────────
//
// Chainlink Base mainnet ETH/USD proxy:
//   - Standard EACAggregatorProxy: 0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70
//   - SVR-enabled proxy:           0x1428C9E908e32dD2839F99D63C242c91329A58C0
// Operators can override via CHAINLINK_BASE_ETH_USD_ADDRESS without code changes.
//
// Pyth ETH/USD price ID is feed-not-contract; same across chains:
//   0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace
// We pull from Hermes HTTP rather than the on-chain contract for v0.1.
// ────────────────────────────────────────────────────────────────────────────

const CHAINLINK_BASE_ETH_USD_DEFAULT =
  "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70" as const;

const PYTH_ETH_USD_PRICE_ID =
  "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace" as const;

const HERMES_LATEST =
  "https://hermes.pyth.network/v2/updates/price/latest";

// ─── Public types ─────────────────────────────────────────────────────────────

export interface OracleObservation {
  feed: OracleFeed;
  price: string; // decimal, e.g. "3142.85"
  feed_timestamp: string; // ISO8601 UTC ('Z' suffix)
  observed_at: string; // when we read it; ISO8601 UTC
  /** Round ID for Chainlink, publish slot for Pyth. Hex-encoded for stability. */
  source_id: string;
  source_age_seconds: number; // now − feed_timestamp at observation time
}

export interface OracleClientConfig {
  baseRpcUrl?: string;
  chainlinkEthUsdAddress?: `0x${string}`;
  hermesEndpoint?: string;
  /** ms timeout per Chainlink RPC call */
  rpcTimeoutMs?: number;
  /** ms timeout per Hermes fetch */
  hermesTimeoutMs?: number;
  /** Optional injection for tests */
  publicClient?: ReadContractClient;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export class OracleError extends Error {
  constructor(
    message: string,
    public readonly feed: OracleFeed,
    public readonly cause_kind:
      | "rpc_failure"
      | "stale"
      | "missing_field"
      | "http_failure"
      | "parse_error",
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "OracleError";
  }
}

// ─── Chainlink AggregatorV3Interface (minimal) ───────────────────────────────

const AGGREGATOR_V3_ABI = [
  {
    inputs: [],
    name: "latestRoundData",
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "decimals",
    outputs: [{ name: "", type: "uint8" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

// ─── OracleClient ────────────────────────────────────────────────────────────

export class OracleClient {
  private readonly publicClient: ReadContractClient;
  private readonly chainlinkAddress: `0x${string}`;
  private readonly hermesEndpoint: string;
  private readonly rpcTimeoutMs: number;
  private readonly hermesTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private cachedDecimals: number | null = null;

  constructor(cfg: OracleClientConfig = {}) {
    this.chainlinkAddress = (cfg.chainlinkEthUsdAddress ??
      (process.env.CHAINLINK_BASE_ETH_USD_ADDRESS as `0x${string}` | undefined) ??
      CHAINLINK_BASE_ETH_USD_DEFAULT) as `0x${string}`;
    this.hermesEndpoint =
      cfg.hermesEndpoint ??
      process.env.PYTH_HERMES_ENDPOINT ??
      HERMES_LATEST;
    this.rpcTimeoutMs = cfg.rpcTimeoutMs ?? 8_000;
    this.hermesTimeoutMs = cfg.hermesTimeoutMs ?? 6_000;
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.now = cfg.now ?? (() => new Date());

    if (cfg.publicClient) {
      this.publicClient = cfg.publicClient;
    } else {
      const rpcUrl = cfg.baseRpcUrl ?? process.env.BASE_MAINNET_RPC_URL;
      if (!rpcUrl) {
        throw new Error(
          "BASE_MAINNET_RPC_URL is required (or pass baseRpcUrl/publicClient)",
        );
      }
      this.publicClient = createPublicClient({
        chain: base,
        transport: http(rpcUrl, { timeout: this.rpcTimeoutMs }),
      }) as unknown as ReadContractClient;
    }
  }

  async getLatestPrice(feed: OracleFeed): Promise<OracleObservation> {
    if (feed === "chainlink:base:ETH-USD") return this.readChainlinkEthUsd();
    if (feed === "pyth:base:ETH-USD") return this.readPythEthUsd();
    throw new OracleError(`unsupported feed: ${feed}`, feed, "missing_field");
  }

  /**
   * Resolve t0/p0 per T0Policy. Returns the first observation that satisfies
   * staleness rules within the grace windows. Throws OracleError("stale") with
   * cause_kind="stale" when both feeds remain unavailable past extended grace.
   */
  async observeWithPolicy(
    policy: T0Policy = DEFAULT_T0_POLICY,
    options: { sleepMs?: (ms: number) => Promise<void> } = {},
  ): Promise<OracleObservation> {
    const sleepMs = options.sleepMs ?? defaultSleep;
    const start = this.now().getTime();
    const grace = policy.t0_grace_seconds * 1000;
    const extended = policy.t0_extended_grace_seconds * 1000;

    while (true) {
      const elapsed = this.now().getTime() - start;
      // Phase 2d: T0Policy fallback fields are optional (sub-hour markets
      // are Pyth-only). When no fallback is configured, retry primary
      // until extended grace expires.
      const wantFallback = elapsed >= grace;
      const fallbackConfigured =
        policy.fallback_feed !== undefined &&
        policy.fallback_max_staleness_sec !== undefined;
      const useFallback = wantFallback && fallbackConfigured;
      const target: OracleFeed = useFallback
        ? policy.fallback_feed!
        : policy.primary_feed;
      const maxStaleness = useFallback
        ? policy.fallback_max_staleness_sec!
        : policy.primary_max_staleness_sec;

      try {
        const obs = await this.getLatestPrice(target);
        if (obs.source_age_seconds <= maxStaleness) return obs;
      } catch (err) {
        if (!(err instanceof OracleError)) throw err;
        // swallow and keep walking the policy
      }

      const remaining = extended - (this.now().getTime() - start);
      if (remaining <= 0) {
        throw new OracleError(
          "both oracles failed staleness check inside extended grace",
          target,
          "stale",
          { policy },
        );
      }
      await sleepMs(Math.min(2_000, Math.max(500, remaining / 4)));
    }
  }

  private async readChainlinkEthUsd(): Promise<OracleObservation> {
    const feed: OracleFeed = "chainlink:base:ETH-USD";
    let roundId: bigint;
    let answer: bigint;
    let updatedAt: bigint;
    try {
      const result = (await this.publicClient.readContract({
        address: this.chainlinkAddress,
        abi: AGGREGATOR_V3_ABI,
        functionName: "latestRoundData",
      })) as readonly [bigint, bigint, bigint, bigint, bigint];
      [roundId, answer, , updatedAt] = result;
    } catch (err) {
      throw new OracleError(
        "chainlink RPC read failed",
        feed,
        "rpc_failure",
        { error: errorMessage(err) },
      );
    }

    if (answer <= 0n) {
      throw new OracleError(
        "chainlink answer non-positive",
        feed,
        "missing_field",
        { answer: answer.toString() },
      );
    }
    if (updatedAt === 0n) {
      throw new OracleError(
        "chainlink updatedAt is zero",
        feed,
        "missing_field",
      );
    }

    const decimals = await this.getChainlinkDecimals();
    const price = formatFixed(answer, decimals);
    const feed_timestamp = isoFromUnixSeconds(updatedAt);
    const observed_at = this.nowIso();
    const source_age_seconds = Math.max(
      0,
      Math.floor(this.now().getTime() / 1000) - Number(updatedAt),
    );

    return {
      feed,
      price,
      feed_timestamp,
      observed_at,
      source_id: `0x${roundId.toString(16)}`,
      source_age_seconds,
    };
  }

  private async getChainlinkDecimals(): Promise<number> {
    if (this.cachedDecimals !== null) return this.cachedDecimals;
    try {
      const d = (await this.publicClient.readContract({
        address: this.chainlinkAddress,
        abi: AGGREGATOR_V3_ABI,
        functionName: "decimals",
      })) as number;
      this.cachedDecimals = Number(d);
      return this.cachedDecimals;
    } catch (err) {
      throw new OracleError(
        "chainlink decimals() read failed",
        "chainlink:base:ETH-USD",
        "rpc_failure",
        { error: errorMessage(err) },
      );
    }
  }

  private async readPythEthUsd(): Promise<OracleObservation> {
    const feed: OracleFeed = "pyth:base:ETH-USD";
    const url =
      `${this.hermesEndpoint}?ids[]=${PYTH_ETH_USD_PRICE_ID}&parsed=true`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.hermesTimeoutMs);
    let payload: HermesResponse;
    try {
      const res = await this.fetchImpl(url, { signal: ctrl.signal });
      if (!res.ok) {
        throw new OracleError(
          `hermes HTTP ${res.status}`,
          feed,
          "http_failure",
        );
      }
      payload = (await res.json()) as HermesResponse;
    } catch (err) {
      if (err instanceof OracleError) throw err;
      throw new OracleError(
        "hermes fetch failed",
        feed,
        "http_failure",
        { error: errorMessage(err) },
      );
    } finally {
      clearTimeout(timer);
    }

    const item = payload.parsed?.[0];
    if (!item) {
      throw new OracleError(
        "hermes returned no parsed entries",
        feed,
        "parse_error",
      );
    }
    const px = item.price;
    if (!px || typeof px.price !== "string" || typeof px.expo !== "number") {
      throw new OracleError(
        "hermes parsed entry missing price/expo",
        feed,
        "missing_field",
      );
    }
    const expo = px.expo;
    const priceBig = BigInt(px.price);
    if (priceBig <= 0n) {
      throw new OracleError(
        "pyth price non-positive",
        feed,
        "missing_field",
      );
    }
    const price = formatPythDecimal(priceBig, expo);
    const publishUnix = px.publish_time ?? item.metadata?.publish_time;
    if (typeof publishUnix !== "number") {
      throw new OracleError(
        "hermes parsed entry missing publish_time",
        feed,
        "missing_field",
      );
    }
    const feed_timestamp = isoFromUnixSeconds(BigInt(publishUnix));
    const observed_at = this.nowIso();
    const source_age_seconds = Math.max(
      0,
      Math.floor(this.now().getTime() / 1000) - publishUnix,
    );

    return {
      feed,
      price,
      feed_timestamp,
      observed_at,
      source_id: `pyth:${publishUnix}`,
      source_age_seconds,
    };
  }

  private nowIso(): string {
    return this.now().toISOString().replace(/\.\d+Z$/, "Z");
  }
}

// ─── Hermes response shape (minimal) ─────────────────────────────────────────

interface HermesPriceEntry {
  price: string;
  expo: number;
  conf: string;
  publish_time?: number;
}

interface HermesParsedItem {
  id: string;
  price: HermesPriceEntry;
  ema_price?: HermesPriceEntry;
  metadata?: {
    slot?: number;
    publish_time?: number;
    prev_publish_time?: number;
  };
}

interface HermesResponse {
  parsed?: HermesParsedItem[];
  binary?: { encoding: string; data: string[] };
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function isoFromUnixSeconds(s: bigint): string {
  return new Date(Number(s) * 1000).toISOString().replace(/\.\d+Z$/, "Z");
}

/**
 * Formats a uint scaled by 10^decimals into a plain decimal string with no
 * trailing zeros beyond what's needed.
 */
function formatFixed(value: bigint, decimals: number): string {
  const neg = value < 0n;
  const abs = neg ? -value : value;
  const s = abs.toString().padStart(decimals + 1, "0");
  const cut = s.length - decimals;
  const intPart = s.slice(0, cut);
  const fracPart = s.slice(cut).replace(/0+$/, "");
  const out = fracPart.length > 0 ? `${intPart}.${fracPart}` : intPart;
  return neg ? `-${out}` : out;
}

/**
 * Pyth gives `price` as a signed integer string and `expo` as a (typically
 * negative) base-10 exponent. e.g. price="312485000000", expo=-8 → "3124.85".
 */
function formatPythDecimal(value: bigint, expo: number): string {
  if (expo === 0) return value.toString();
  if (expo > 0) return `${value.toString()}${"0".repeat(expo)}`;
  return formatFixed(value, -expo);
}
