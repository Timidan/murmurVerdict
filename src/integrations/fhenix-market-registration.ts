import { parseAbi, type Address, type Hex } from "viem";

/**
 * Narrow owner-plane ABI for MurmurSealedVerdicts market registration.
 * Deliberately excludes the relayer submit surface — the discovery ticker
 * only needs `owner()` (precondition check), the public `markets` mapping
 * (on-chain dedupe/reconciliation), and `registerFixedRevealMarket`.
 */
export const MURMUR_SEALED_VERDICTS_MARKET_REGISTRAR_ABI = parseAbi([
  "function owner() view returns (address)",
  "function markets(bytes32 marketId) view returns (uint64 horizonSeconds, uint64 fixedRevealAfter, bool active)",
  "function registerFixedRevealMarket(bytes32 marketId, uint64 revealAfter, bool active)",
]);

/** Decoded `markets(bytes32)` tuple. All-zero fields mean "not registered". */
export interface OnchainMarketState {
  horizonSeconds: bigint;
  fixedRevealAfter: bigint;
  active: boolean;
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
  estimateRegisterCostWei(marketId: Hex, revealAfterSec: bigint): Promise<bigint>;
  registerFixedRevealMarket(marketId: Hex, revealAfterSec: bigint): Promise<Hex>;
  waitForReceipt(hash: Hex): Promise<MarketRegistrationReceipt>;
  /**
   * Non-blocking receipt lookup for a persisted broadcast hash; null while
   * the tx is unmined or unknown. The pre-rebroadcast reconciliation read.
   */
  getReceipt(hash: Hex): Promise<MarketRegistrationReceipt | null>;
}

export function isRegisteredOnchain(state: OnchainMarketState): boolean {
  return state.horizonSeconds !== 0n || state.fixedRevealAfter !== 0n;
}

/**
 * Exact fixed-reveal shape the sealed-call acceptance guard requires:
 * relative horizon unset, fixedRevealAfter pinned to the market endDate,
 * and the market active. Anything else must go through the audited
 * repair path — re-registering overwrites on-chain configuration.
 */
export function hasExactFixedRevealState(
  state: OnchainMarketState,
  endDateEpochSec: bigint,
): boolean {
  return (
    state.horizonSeconds === 0n &&
    state.fixedRevealAfter === endDateEpochSec &&
    state.active === true
  );
}

// Structural client dependencies so the registrar stays testable without a
// live viem stack (mirrors the FhenixGatewayClient injection posture).

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
    functionName: "registerFixedRevealMarket";
    args: readonly [Hex, bigint, boolean];
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

export interface MarketRegistrarWriteFn {
  (args: {
    address: Address;
    abi: typeof MURMUR_SEALED_VERDICTS_MARKET_REGISTRAR_ABI;
    functionName: "registerFixedRevealMarket";
    args: readonly [Hex, bigint, boolean];
  }): Promise<Hex>;
}

export interface ViemFhenixMarketRegistrarDeps {
  chainId: number;
  contractAddress: string;
  relayerAddress: string;
  publicClient: MarketRegistrarPublicClientLike;
  /**
   * Broadcast entry point. The caller routes this through the shared
   * relayer broadcast queue so market registrations and Gateway
   * submitSealedFor writes never race the same account's nonces.
   */
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
    const tuple = (await this.publicClient.readContract({
      address: this.contractAddress as Address,
      abi: MURMUR_SEALED_VERDICTS_MARKET_REGISTRAR_ABI,
      functionName: "markets",
      args: [marketId],
    })) as readonly [bigint, bigint, boolean];
    return {
      horizonSeconds: tuple[0],
      fixedRevealAfter: tuple[1],
      active: tuple[2],
    };
  }

  getRelayerBalanceWei(): Promise<bigint> {
    return this.publicClient.getBalance({
      address: this.relayerAddress as Address,
    });
  }

  async estimateRegisterCostWei(
    marketId: Hex,
    revealAfterSec: bigint,
  ): Promise<bigint> {
    const [gas, gasPrice] = await Promise.all([
      this.publicClient.estimateContractGas({
        address: this.contractAddress as Address,
        abi: MURMUR_SEALED_VERDICTS_MARKET_REGISTRAR_ABI,
        functionName: "registerFixedRevealMarket",
        args: [marketId, revealAfterSec, true],
        account: this.relayerAddress as Address,
      }),
      this.publicClient.getGasPrice(),
    ]);
    return gas * gasPrice;
  }

  registerFixedRevealMarket(marketId: Hex, revealAfterSec: bigint): Promise<Hex> {
    return this.write({
      address: this.contractAddress as Address,
      abi: MURMUR_SEALED_VERDICTS_MARKET_REGISTRAR_ABI,
      functionName: "registerFixedRevealMarket",
      args: [marketId, revealAfterSec, true],
    });
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
