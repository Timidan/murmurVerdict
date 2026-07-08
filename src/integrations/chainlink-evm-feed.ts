import {
  errorMessage,
  formatFixed,
  isoFromUnixSeconds,
  nowIso,
} from "./oracle-primitives.js";

// Chainlink AggregatorV3Interface (minimal).
export const CHAINLINK_AGGREGATOR_V3_ABI = [
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

export const CHAINLINK_BASE_ETH_USD_FEED =
  "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70" as const;

export type ChainlinkEvmErrorKind = "rpc_failure" | "missing_field";

export class ChainlinkEvmReadError extends Error {
  constructor(
    message: string,
    public readonly cause_kind: ChainlinkEvmErrorKind,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ChainlinkEvmReadError";
  }
}

export interface ChainlinkEvmReadContractClient {
  readContract: (args: {
    address: `0x${string}`;
    abi: readonly unknown[];
    functionName: string;
    args?: readonly unknown[];
  }) => Promise<unknown>;
}

export interface ChainlinkEvmDecimalsCache {
  get(key: string): number | undefined;
  set(key: string, value: number): unknown;
}

export interface ChainlinkEvmReadInput {
  client: ChainlinkEvmReadContractClient;
  address: `0x${string}`;
  now: () => Date;
  decimalsCache?: ChainlinkEvmDecimalsCache;
  decimalsCacheKey?: string;
}

export interface ChainlinkEvmObservation {
  price: string;
  feed_timestamp: string;
  observed_at: string;
  source_id: string;
  source_age_seconds: number;
}

export async function readChainlinkEvmPrice(
  input: ChainlinkEvmReadInput,
): Promise<ChainlinkEvmObservation> {
  let roundId: bigint;
  let answer: bigint;
  let updatedAt: bigint;
  try {
    const result = (await input.client.readContract({
      address: input.address,
      abi: CHAINLINK_AGGREGATOR_V3_ABI,
      functionName: "latestRoundData",
    })) as readonly [bigint, bigint, bigint, bigint, bigint];
    [roundId, answer, , updatedAt] = result;
  } catch (err) {
    throw new ChainlinkEvmReadError(
      "chainlink RPC read failed",
      "rpc_failure",
      { error: errorMessage(err) },
    );
  }

  if (answer <= 0n) {
    throw new ChainlinkEvmReadError(
      "chainlink answer non-positive",
      "missing_field",
      { answer: answer.toString() },
    );
  }
  if (updatedAt === 0n) {
    throw new ChainlinkEvmReadError(
      "chainlink updatedAt is zero",
      "missing_field",
    );
  }

  const decimals = await readChainlinkEvmDecimals(input);
  const observedAt = input.now();
  return {
    price: formatFixed(answer, decimals),
    feed_timestamp: isoFromUnixSeconds(updatedAt),
    observed_at: nowIso(() => observedAt),
    source_id: `0x${roundId.toString(16)}`,
    source_age_seconds: Math.max(
      0,
      Math.floor(observedAt.getTime() / 1000) - Number(updatedAt),
    ),
  };
}

async function readChainlinkEvmDecimals(
  input: ChainlinkEvmReadInput,
): Promise<number> {
  const cacheKey = input.decimalsCacheKey;
  const cached = cacheKey ? input.decimalsCache?.get(cacheKey) : undefined;
  if (cached !== undefined) return cached;
  try {
    const raw = (await input.client.readContract({
      address: input.address,
      abi: CHAINLINK_AGGREGATOR_V3_ABI,
      functionName: "decimals",
    })) as number;
    const decimals = Number(raw);
    if (cacheKey) input.decimalsCache?.set(cacheKey, decimals);
    return decimals;
  } catch (err) {
    throw new ChainlinkEvmReadError(
      "chainlink decimals() read failed",
      "rpc_failure",
      { error: errorMessage(err) },
    );
  }
}
