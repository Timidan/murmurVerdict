import {
  createPublicClient,
  createWalletClient,
  http,
  nonceManager,
  parseAbi,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  parseFhenixAddressInput,
  parseFhenixChainIdInput,
  resolveFhenixContractAddress,
} from "./deployments.js";
import { createSerialBroadcastQueue } from "./fhenix-gateway-env.js";

// The grantor EOA's own contract surface: grantDecryptAccess is onlyGrantor
// (the contract enforces the sale window at execution) and getDecryptAccess is
// the subscriber-facing read used by the access-status endpoint. The grantor
// key holds ONLY the grantor role — never submit (relayer) or reveal authority.
const GRANT_ABI = parseAbi([
  "function grantDecryptAccess(bytes32 callId, address subscriber)",
  "function getDecryptAccess(bytes32 callId, address subscriber) view returns (uint8 state, uint64 revealOpenAt, bytes32 binaryIndexCtHash, bytes32 confidenceCtHash, bool alreadyGranted)",
]);

export class FhenixGrantConfigError extends Error {
  readonly key: string;

  constructor(key: string, message: string) {
    super(`${key}: ${message}`);
    this.name = "FhenixGrantConfigError";
    this.key = key;
  }
}

export interface GrantChainReceipt {
  blockNumber: number;
  success: boolean;
  // Block-depth of the receipt (this block counts as 1). Lets the state machine
  // enforce FHENIX_GRANT_CONFIRMATIONS before marking a grant terminal so a
  // shallow reorg of the grant block cannot leave a "granted" row ungranted.
  confirmations: number;
}

export interface GrantDecryptAccessView {
  // Mirrors contract CallState: 0 None, 1 Sealed, 2 Opened, 3 Revealed, 4 Invalid.
  state: number;
  revealOpenAt: number;
  binaryIndexCtHash: string;
  confidenceCtHash: string;
  alreadyGranted: boolean;
}

export interface GrantChainAdapter {
  readonly chainId: number;
  readonly contractAddress: string;
  readonly grantorAddress: string;
  /** Broadcast grantDecryptAccess(callId, subscriber); returns the tx hash. */
  sendGrant(onchainCallId: string, subscriber: string): Promise<string>;
  /** null until mined. */
  getReceipt(txHash: string): Promise<GrantChainReceipt | null>;
  /** Reads the subscriber-facing decrypt-access view; null if CallNotFound. */
  readDecryptAccess(
    onchainCallId: string,
    subscriber: string,
  ): Promise<GrantDecryptAccessView | null>;
  getBalanceWei(): Promise<bigint>;
}

export interface FhenixGrantEnvConfig {
  chainId: number;
  contractAddress: string;
  grantorAddress: string;
  confirmations: number;
  /**
   * Max grant broadcasts before a settled-but-ungrantable entitlement is owed a
   * refund. Bounds the reconciler's re-broadcast of a dropped grant tx so a
   * genuinely stuck grant heals to refund_due instead of retrying forever.
   */
  maxGrantAttempts: number;
  /**
   * Grace/poll cadence (seconds) for a broadcast grant tx before the reconciler
   * re-broadcasts it as presumed-dropped. Also paces settlement_unknown
   * resolution attempts.
   */
  grantRebroadcastDelaySeconds: number;
  /**
   * Reconcile attempts an ambiguous (settlement_unknown) row survives before it
   * is conservatively marked refund_due so it never strands silently.
   */
  settlementUnknownMaxAttempts: number;
  /**
   * Sales close at revealOpenAt - salesSafetySeconds. The margin must cover
   * grant broadcast, confirmations, and enough subscriber time to decrypt
   * before the ciphertext goes public. Default 180s (Codex §6).
   */
  salesSafetySeconds: number;
  minBalanceWei: bigint;
  /**
   * Flat, Murmur-configured access price in the settlement asset's atomic units
   * (e.g. USDC 6-decimals). ONE price for all calls (Codex v1 scope): no
   * producer split, no agent-set pricing. The payment asset/seller/network come
   * from the shared nanopay payment infra at composition time.
   */
  priceAtoms: string;
  currency: string;
  /** Bound into the paid resource; bump when the price/terms change. */
  pricingVersion: string;
  chain: GrantChainAdapter;
}

export interface FhenixGrantEnvOptions {
  contractAddress?: string | null;
  enabled?: boolean;
}

// Strict, default-OFF loader. Returns null when disabled; throws (fail-closed)
// on any invalid configuration when enabled — a mis-set grant key must never
// silently no-op while subscribers are charged for access they never receive.
export function loadFhenixGrantEnvConfig(
  env: NodeJS.ProcessEnv = process.env,
  opts: FhenixGrantEnvOptions = {},
): FhenixGrantEnvConfig | null {
  const enabled =
    opts.enabled ?? booleanEnv(env.FHENIX_GRANT_ENABLED, false, "FHENIX_GRANT_ENABLED");
  if (!enabled) return null;

  const rpcUrl = env.FHENIX_RPC_URL?.trim();
  if (!rpcUrl) {
    throw new FhenixGrantConfigError(
      "FHENIX_RPC_URL",
      "FHENIX_GRANT_ENABLED=true requires FHENIX_RPC_URL",
    );
  }
  const chainIdInput = parseFhenixChainIdInput(env.FHENIX_CHAIN_ID);
  if (chainIdInput.kind === "empty") {
    throw new FhenixGrantConfigError(
      "FHENIX_CHAIN_ID",
      "FHENIX_GRANT_ENABLED=true requires FHENIX_CHAIN_ID",
    );
  }
  if (chainIdInput.kind === "invalid") {
    throw new FhenixGrantConfigError("FHENIX_CHAIN_ID", "must be a positive integer");
  }
  const chainId = chainIdInput.chainId;

  const privateKey = env.FHENIX_GRANT_PRIVATE_KEY?.trim();
  if (!privateKey) {
    throw new FhenixGrantConfigError(
      "FHENIX_GRANT_PRIVATE_KEY",
      "FHENIX_GRANT_ENABLED=true requires FHENIX_GRANT_PRIVATE_KEY (a DEDICATED grantor EOA, not the relayer or reveal key)",
    );
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new FhenixGrantConfigError(
      "FHENIX_GRANT_PRIVATE_KEY",
      "must be a 32-byte 0x-prefixed private key",
    );
  }
  // Key isolation (Codex §4): the grantor key must not equal the relayer key
  // (nonce contention with submit/discovery) nor the reveal key (couples the
  // privacy revenue path to the availability fallback).
  const relayerKey = env.FHENIX_GATEWAY_RELAYER_PRIVATE_KEY?.trim();
  if (relayerKey && relayerKey.toLowerCase() === privateKey.toLowerCase()) {
    throw new FhenixGrantConfigError(
      "FHENIX_GRANT_PRIVATE_KEY",
      "must differ from FHENIX_GATEWAY_RELAYER_PRIVATE_KEY — a dedicated grantor key avoids nonce contention and privilege bleed",
    );
  }
  const revealKey = env.FHENIX_REVEAL_PRIVATE_KEY?.trim();
  if (revealKey && revealKey.toLowerCase() === privateKey.toLowerCase()) {
    throw new FhenixGrantConfigError(
      "FHENIX_GRANT_PRIVATE_KEY",
      "must differ from FHENIX_REVEAL_PRIVATE_KEY — the grant path must not share the reveal EOA",
    );
  }

  const contractAddress = resolveContractAddress(env, chainId, opts);
  if (!contractAddress) {
    throw new FhenixGrantConfigError(
      "FHENIX_SEALED_VERDICTS_ADDRESS",
      `FHENIX_GRANT_ENABLED=true but no contract address found for chainId ${chainId}`,
    );
  }

  const confirmations = integerEnv("FHENIX_GRANT_CONFIRMATIONS", 2, env, { min: 0 });
  const maxGrantAttempts = integerEnv("FHENIX_GRANT_MAX_ATTEMPTS", 5, env, { min: 1 });
  const grantRebroadcastDelaySeconds = integerEnv(
    "FHENIX_GRANT_REBROADCAST_DELAY_SEC",
    30,
    env,
    { min: 1 },
  );
  const settlementUnknownMaxAttempts = integerEnv(
    "FHENIX_GRANT_SETTLEMENT_UNKNOWN_MAX_ATTEMPTS",
    8,
    env,
    { min: 1 },
  );
  const salesSafetySeconds = integerEnv("FHENIX_GRANT_SALES_SAFETY_SEC", 180, env, { min: 0 });
  const priceAtoms = env.FHENIX_GRANT_PRICE_ATOMS?.trim() || "10000"; // $0.01 USDC
  if (!/^[0-9]+$/.test(priceAtoms) || priceAtoms === "0") {
    throw new FhenixGrantConfigError(
      "FHENIX_GRANT_PRICE_ATOMS",
      "must be a positive integer atomic amount",
    );
  }
  const currency = env.FHENIX_GRANT_CURRENCY?.trim() || "USDC";
  const pricingVersion = env.FHENIX_GRANT_PRICING_VERSION?.trim() || "v1";
  const minBalanceWei = weiEnv(
    "FHENIX_GRANT_MIN_BALANCE_WEI",
    20_000_000_000_000_000n, // 0.02 ETH
    env,
  );

  const account = privateKeyToAccount(privateKey as Hex, { nonceManager });
  const publicClient = createPublicClient({ transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account, transport: http(rpcUrl) });
  // The grantor EOA's OWN serial broadcast queue — signer-agnostic helper
  // reused from the Gateway. NOT the relayer or reveal queue.
  const broadcastQueue = createSerialBroadcastQueue();

  const chain = createViemGrantChainAdapter({
    chainId,
    contractAddress,
    confirmations,
    publicClient,
    walletClient,
    account,
    broadcastQueue,
  });

  return {
    chainId,
    contractAddress,
    grantorAddress: account.address.toLowerCase(),
    confirmations,
    maxGrantAttempts,
    grantRebroadcastDelaySeconds,
    settlementUnknownMaxAttempts,
    salesSafetySeconds,
    minBalanceWei,
    priceAtoms,
    currency,
    pricingVersion,
    chain,
  };
}

function createViemGrantChainAdapter(deps: {
  chainId: number;
  contractAddress: string;
  confirmations: number;
  publicClient: ReturnType<typeof createPublicClient>;
  walletClient: ReturnType<typeof createWalletClient>;
  account: ReturnType<typeof privateKeyToAccount>;
  broadcastQueue: ReturnType<typeof createSerialBroadcastQueue>;
}): GrantChainAdapter {
  const address = deps.contractAddress as Hex;
  return {
    chainId: deps.chainId,
    contractAddress: deps.contractAddress,
    grantorAddress: deps.account.address.toLowerCase(),
    sendGrant(onchainCallId, subscriber) {
      // Serialize allocate/sign/broadcast on THIS EOA. Reset its (address-scoped)
      // nonce cache first so a dropped grant tx's nonce is reclaimed on retry
      // instead of stranding the queue at a gap; the serial queue awaits
      // eth_sendRawTransaction before releasing, so a still-mempooled prior tx
      // is never double-signed on one nonce.
      return deps.broadcastQueue.run(async () => {
        nonceManager.reset({ address: deps.account.address, chainId: deps.chainId });
        return (await deps.walletClient.writeContract({
          address,
          abi: GRANT_ABI,
          functionName: "grantDecryptAccess",
          args: [onchainCallId as Hex, subscriber as Hex],
          account: deps.account,
          chain: null,
        } as never)) as string;
      });
    },
    async getReceipt(txHash) {
      try {
        const receipt = await deps.publicClient.getTransactionReceipt({ hash: txHash as Hex });
        let confirmations = 1;
        try {
          const head = await deps.publicClient.getBlockNumber();
          const depth = Number(head - receipt.blockNumber) + 1;
          confirmations = depth > 0 ? depth : 1;
        } catch {
          // Head unavailable — the receipt itself proves at least 1 confirmation.
          confirmations = 1;
        }
        return {
          blockNumber: Number(receipt.blockNumber),
          success: receipt.status === "success",
          confirmations,
        };
      } catch {
        return null; // not mined yet
      }
    },
    async readDecryptAccess(onchainCallId, subscriber) {
      try {
        const view = (await deps.publicClient.readContract({
          address,
          abi: GRANT_ABI,
          functionName: "getDecryptAccess",
          args: [onchainCallId as Hex, subscriber as Hex],
        })) as readonly [number, bigint, string, string, boolean];
        return {
          state: Number(view[0]),
          revealOpenAt: Number(view[1]),
          binaryIndexCtHash: view[2],
          confidenceCtHash: view[3],
          alreadyGranted: view[4],
        };
      } catch (err) {
        // A revert (CallNotFound) means no on-chain state → null. Network/RPC
        // failures must NOT be swallowed as null.
        if (isRevertError(err)) return null;
        throw err;
      }
    },
    getBalanceWei: () => deps.publicClient.getBalance({ address: deps.account.address }),
  };
}

function resolveContractAddress(
  env: NodeJS.ProcessEnv,
  chainId: number,
  opts: FhenixGrantEnvOptions,
): string | null {
  if (opts.contractAddress === undefined) {
    return resolveFhenixContractAddress(chainId, env);
  }
  const parsed = parseFhenixAddressInput(opts.contractAddress);
  if (parsed.kind === "empty") return null;
  if (parsed.kind === "address") return parsed.address;
  throw new FhenixGrantConfigError(
    "FHENIX_SEALED_VERDICTS_ADDRESS",
    "must be a 20-byte 0x-prefixed address",
  );
}

function isRevertError(err: unknown): boolean {
  const text = err instanceof Error ? `${err.message} ${String((err as { shortMessage?: string }).shortMessage ?? "")}` : String(err);
  return /revert|CallNotFound|execution reverted/i.test(text);
}

function booleanEnv(raw: string | undefined, fallback: boolean, key: string): boolean {
  const normalized = raw?.trim().toLowerCase();
  if (!normalized) return fallback;
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  throw new FhenixGrantConfigError(key, "must be one of true, false, 1, or 0");
}

function integerEnv(
  name: string,
  fallback: number,
  env: NodeJS.ProcessEnv,
  opts: { min: number },
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (Number.isInteger(value) && value >= opts.min) return value;
  throw new FhenixGrantConfigError(name, `must be an integer >= ${opts.min}`);
}

function weiEnv(name: string, fallback: bigint, env: NodeJS.ProcessEnv): bigint {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (!/^[0-9]+$/.test(raw)) {
    throw new FhenixGrantConfigError(name, "must be a non-negative integer wei amount");
  }
  return BigInt(raw);
}
