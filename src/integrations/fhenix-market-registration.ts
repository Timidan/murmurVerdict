import { parseAbi, type Address, type Hex } from "viem";

/** Owner-plane ABI for market registration: `owner()`, the `markets` mapping, and `registerMarket`. */
export const MURMUR_SEALED_VERDICTS_MARKET_REGISTRAR_ABI = parseAbi([
  "function owner() view returns (address)",
  "function markets(bytes32 marketId) view returns (uint64 armCloseAt, uint64 submissionOpenAt, uint64 earlyAccessCutoffAt, uint64 submissionCloseAt, uint64 resolutionAt, uint64 publicRevealAt, bool active)",
  "function registerMarket(bytes32 marketId, (uint64 armCloseAt, uint64 submissionOpenAt, uint64 earlyAccessCutoffAt, uint64 submissionCloseAt, uint64 resolutionAt, uint64 publicRevealAt, bool active) schedule)",
  // Declared so viem can decode registration reverts instead of logging bare selectors.
  "error NotOwner()",
  "error NotRelayer()",
  "error MarketAlreadyRegistered()",
  "error MarketNotFound()",
  "error MarketInactive()",
  "error ScheduleNotStrictlyOrdered()",
  // Misleading name, real meaning: registration must land BEFORE armCloseAt.
  "error RevealAfterMustBeFuture()",
]);

/** The six-instant schedule written on-chain at registration. */
export interface OnchainSchedule {
  armCloseAt: bigint;
  submissionOpenAt: bigint;
  earlyAccessCutoffAt: bigint;
  submissionCloseAt: bigint;
  resolutionAt: bigint;
  publicRevealAt: bigint;
  active: boolean;
}

/** Decoded `markets(bytes32)` tuple. All-zero fields mean "not registered". */
export type OnchainMarketState = OnchainSchedule;

/**
 * The configured contract is an older deployment whose `markets()` shape this
 * daemon cannot decode. Distinct from a transient read failure: no amount of
 * retrying fixes it.
 */
export class LegacyContractError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LegacyContractError";
  }
}

/**
 * Whether an error is (or wraps) an ABI decode failure. viem wraps the decoder error
 * in ContractFunctionExecutionError, so walk the cause chain.
 */
export function isLegacyMarketsDecodeError(err: unknown): boolean {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  for (let depth = 0; cur && depth < 12; depth += 1) {
    if (seen.has(cur)) break;
    seen.add(cur);
    const name = cur instanceof Error ? cur.name : "";
    const msg = cur instanceof Error ? cur.message : String(cur);
    if (
      /AbiDecodingDataSizeTooSmall|PositionOutOfBounds|SliceOffsetOutOfBounds|AbiDecodingZeroData/i.test(
        name,
      ) ||
      /data size of \d+ bytes is too small|position .* out of bounds|offset .* out of bounds/i.test(
        msg,
      )
    ) {
      return true;
    }
    cur = (cur as { cause?: unknown } | null)?.cause;
  }
  return false;
}

export interface MarketRegistrationReceipt {
  status: "success" | "reverted";
  gasUsed: bigint | null;
  effectiveGasPriceWei: bigint | null;
  blockNumber: bigint | null;
}

export interface FhenixMarketRegistrar {
  chainId: number;
  contractAddress: string;
  relayerAddress: string;
  getChainId(): Promise<number>;
  getOwner(): Promise<string>;
  hasContractCode(): Promise<boolean>;
  getMarket(marketId: Hex): Promise<OnchainMarketState>;
  getRelayerBalanceWei(): Promise<bigint>;
  /** estimateGas × current gas price — the pre-write spend ceiling check. */
  estimateRegisterCostWei(marketId: Hex, schedule: OnchainSchedule): Promise<bigint>;
  registerMarket(
    marketId: Hex,
    schedule: OnchainSchedule,
    opts?: { preBroadcast?: MarketRegistrarPreBroadcast },
  ): Promise<Hex>;
  waitForReceipt(hash: Hex): Promise<MarketRegistrationReceipt>;
  /**
   * Non-blocking receipt lookup for a persisted broadcast hash; null while
   * the tx is unmined or unknown. The pre-rebroadcast reconciliation read.
   */
  getReceipt(hash: Hex): Promise<MarketRegistrationReceipt | null>;
}

export function isRegisteredOnchain(state: OnchainMarketState): boolean {
  // Registration enforces strict ordering above a nonzero timestamp, so a
  // registered market always has a nonzero publicRevealAt.
  return state.publicRevealAt !== 0n;
}

/**
 * Whether the on-chain schedule matches the intended one exactly, every instant.
 * Registration is one-shot, so a mismatch is a hard stop, never overwritten.
 */
export function hasExactSchedule(
  state: OnchainMarketState,
  expected: OnchainSchedule,
): boolean {
  return (
    state.armCloseAt === expected.armCloseAt &&
    state.submissionOpenAt === expected.submissionOpenAt &&
    state.earlyAccessCutoffAt === expected.earlyAccessCutoffAt &&
    state.submissionCloseAt === expected.submissionCloseAt &&
    state.resolutionAt === expected.resolutionAt &&
    state.publicRevealAt === expected.publicRevealAt &&
    state.active === expected.active
  );
}

// Structural client deps so the registrar is testable without a live viem stack.

export interface MarketRegistrarPublicClientLike {
  getChainId(): Promise<number>;
  getBalance(args: { address: Address }): Promise<bigint>;
  getCode(args: { address: Address }): Promise<Hex | undefined>;
  getGasPrice(): Promise<bigint>;
  readContract(args: {
    address: Address;
    abi: typeof MURMUR_SEALED_VERDICTS_MARKET_REGISTRAR_ABI;
    functionName: "owner" | "markets";
    args?: readonly [Hex];
  }): Promise<unknown>;
  estimateContractGas(args: {
    address: Address;
    abi: typeof MURMUR_SEALED_VERDICTS_MARKET_REGISTRAR_ABI;
    functionName: "registerMarket";
    args: readonly [Hex, OnchainSchedule];
    account: Address;
  }): Promise<bigint>;
  waitForTransactionReceipt(args: { hash: Hex }): Promise<RawRegistrarReceipt>;
  /** Throws (viem TransactionReceiptNotFoundError) while the tx is unmined. */
  getTransactionReceipt(args: { hash: Hex }): Promise<RawRegistrarReceipt>;
}

export interface RawRegistrarReceipt {
  status?: "success" | "reverted";
  gasUsed?: bigint;
  effectiveGasPrice?: bigint;
  blockNumber?: bigint;
}

/**
 * Runs INSIDE the serialized broadcast slot, just before signing. Registration is one-shot,
 * so a halt during the queue wait must still stop it. Throwing aborts before any tx is sent.
 */
export type MarketRegistrarPreBroadcast = () => void;

export interface MarketRegistrarWriteFn {
  (
    args: {
      address: Address;
      abi: typeof MURMUR_SEALED_VERDICTS_MARKET_REGISTRAR_ABI;
      functionName: "registerMarket";
      args: readonly [Hex, OnchainSchedule];
    },
    opts?: { preBroadcast?: MarketRegistrarPreBroadcast },
  ): Promise<Hex>;
}

export interface ViemFhenixMarketRegistrarDeps {
  chainId: number;
  contractAddress: string;
  relayerAddress: string;
  publicClient: MarketRegistrarPublicClientLike;
  /** Routed through the shared relayer queue so registrations and gateway writes never race nonces. */
  writeContract: MarketRegistrarWriteFn;
}

export class ViemFhenixMarketRegistrar implements FhenixMarketRegistrar {
  readonly chainId: number;
  readonly contractAddress: string;
  readonly relayerAddress: string;
  private readonly publicClient: MarketRegistrarPublicClientLike;
  private readonly write: MarketRegistrarWriteFn;

  constructor(deps: ViemFhenixMarketRegistrarDeps) {
    this.chainId = deps.chainId;
    this.contractAddress = deps.contractAddress;
    this.relayerAddress = deps.relayerAddress;
    this.publicClient = deps.publicClient;
    this.write = deps.writeContract;
  }

  getChainId(): Promise<number> {
    return this.publicClient.getChainId();
  }

  async getOwner(): Promise<string> {
    const owner = await this.publicClient.readContract({
      address: this.contractAddress as Address,
      abi: MURMUR_SEALED_VERDICTS_MARKET_REGISTRAR_ABI,
      functionName: "owner",
    });
    return String(owner);
  }

  async hasContractCode(): Promise<boolean> {
    const code = await this.publicClient.getCode({
      address: this.contractAddress as Address,
    });
    return typeof code === "string" && code.length > 2;
  }

  async getMarket(marketId: Hex): Promise<OnchainMarketState> {
    let tuple: readonly [bigint, bigint, bigint, bigint, bigint, bigint, boolean];
    try {
      tuple = (await this.publicClient.readContract({
        address: this.contractAddress as Address,
        abi: MURMUR_SEALED_VERDICTS_MARKET_REGISTRAR_ABI,
        functionName: "markets",
        args: [marketId],
      })) as readonly [bigint, bigint, bigint, bigint, bigint, bigint, boolean];
    } catch (err) {
      // A pre-schedule deployment returns 3 words, not 7: a config error, not a transient read.
      if (isLegacyMarketsDecodeError(err)) {
        throw new LegacyContractError(
          `contract at ${this.contractAddress} predates the six-instant market schedule ` +
            `(markets() returned an incompatible tuple). Redeploy MurmurSealedVerdicts and ` +
            `repoint FHENIX_SEALED_VERDICTS_ADDRESS; the old deployment cannot be driven ` +
            `by this daemon.`,
          { cause: err },
        );
      }
      throw err;
    }
    return {
      armCloseAt: tuple[0],
      submissionOpenAt: tuple[1],
      earlyAccessCutoffAt: tuple[2],
      submissionCloseAt: tuple[3],
      resolutionAt: tuple[4],
      publicRevealAt: tuple[5],
      active: tuple[6],
    };
  }

  getRelayerBalanceWei(): Promise<bigint> {
    return this.publicClient.getBalance({
      address: this.relayerAddress as Address,
    });
  }

  async estimateRegisterCostWei(
    marketId: Hex,
    schedule: OnchainSchedule,
  ): Promise<bigint> {
    const [gas, gasPrice] = await Promise.all([
      this.publicClient.estimateContractGas({
        address: this.contractAddress as Address,
        abi: MURMUR_SEALED_VERDICTS_MARKET_REGISTRAR_ABI,
        functionName: "registerMarket",
        args: [marketId, schedule],
        account: this.relayerAddress as Address,
      }),
      this.publicClient.getGasPrice(),
    ]);
    return gas * gasPrice;
  }

  registerMarket(
    marketId: Hex,
    schedule: OnchainSchedule,
    opts?: { preBroadcast?: MarketRegistrarPreBroadcast },
  ): Promise<Hex> {
    return this.write(
      {
        address: this.contractAddress as Address,
        abi: MURMUR_SEALED_VERDICTS_MARKET_REGISTRAR_ABI,
        functionName: "registerMarket",
        args: [marketId, schedule],
      },
      opts,
    );
  }

  async waitForReceipt(hash: Hex): Promise<MarketRegistrationReceipt> {
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    return mapRegistrarReceipt(receipt);
  }

  async getReceipt(hash: Hex): Promise<MarketRegistrationReceipt | null> {
    let receipt: RawRegistrarReceipt;
    try {
      receipt = await this.publicClient.getTransactionReceipt({ hash });
    } catch {
      // viem throws while the tx is unmined; an RPC outage looks the same.
      // Both mean "unknown" — the caller decides whether to keep waiting or
      // rebroadcast (identical calldata keeps a rebroadcast idempotent).
      return null;
    }
    try {
      return mapRegistrarReceipt(receipt);
    } catch {
      return null;
    }
  }
}

/**
 * Fail closed on a malformed RPC receipt: an absent status must never be
 * read as success, or a reverted registration could drive a DB listing.
 */
function mapRegistrarReceipt(
  receipt: RawRegistrarReceipt,
): MarketRegistrationReceipt {
  if (receipt.status !== "success" && receipt.status !== "reverted") {
    throw new Error("receipt_missing_status");
  }
  return {
    status: receipt.status,
    gasUsed: receipt.gasUsed ?? null,
    effectiveGasPriceWei: receipt.effectiveGasPrice ?? null,
    blockNumber: receipt.blockNumber ?? null,
  };
}
