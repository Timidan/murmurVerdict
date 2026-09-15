import {
  createPublicClient,
  createWalletClient,
  http,
  nonceManager,
  parseAbi,
  type Address,
  type Hex,
  type LocalAccount,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  parseFhenixAddressInput,
  parseFhenixChainIdInput,
  resolveFhenixContractAddress,
} from "./deployments.js";
import type { CallTerms } from "../verdict/call-sale-terms.js";
import { SETTLEMENT_CURRENCY } from "./circle-gateway.js";
import { createSerialBroadcastQueue } from "./fhenix-gateway-env.js";

// The grantor EOA's own contract surface: grantDecryptAccess is onlyGrantor
// (the contract enforces the sale window at execution) and getDecryptAccess is
// the subscriber-facing read used by the access-status endpoint. The grantor
// key holds ONLY the grantor role — never submit (relayer) or reveal authority.
const GRANT_ABI = parseAbi([
  "function grantDecryptAccess(bytes32 callId, address subscriber)",
  "function getDecryptAccess(bytes32 callId, address subscriber) view returns (uint8 state, uint64 grantCloseAt, bytes32 binaryIndexCtHash, bytes32 confidenceCtHash, bool alreadyGranted)",
  // Startup preflight: prove this key actually holds the role before selling.
  "function grantors(address) view returns (bool)",
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
  /**
   * The contract's GRANT deadline (the market's submissionCloseAt), not the
   * public reveal time. Sales must close when delivery stops being useful —
   * once the prediction window opens, a grant is worthless to the subscriber.
   * Using publicRevealAt here let the payment gate settle money for access the
   * contract would reject, for the whole length of the embargo.
   */
  grantCloseAt: number;
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
  /**
   * Whether the configured EOA holds the on-chain grantor role.
   *
   * Checked at startup: without it a wrong or unauthorized key issues 402s,
   * settles payments, and only then discovers every grant reverts NotGrantor —
   * turning each sale into a refund obligation.
   */
  hasGrantorRole(): Promise<boolean>;
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
   * Sales close at grantCloseAt - salesSafetySeconds. The margin must cover
   * grant broadcast, confirmations, and enough subscriber time to decrypt
   * before the ciphertext goes public. Default 180s.
   */
  salesSafetySeconds: number;
  /**
   * Max armed consumers per call. Enforced BEFORE the 402 challenge so a full
   * call is never charged for. Every armed consumer costs two ACL writes in
   * the grant flow, so an unbounded cohort can exceed what one transaction
   * can spend — and the grant then fails for everyone on that call.
   *
   * An OPERATIONAL SALES LIMIT, not a gas bound. Each grant is its own
   * transaction — there is no batch-grant entrypoint — so a large cohort costs
   * N transactions rather than risking a block limit. Size it from grantor
   * funding and from how many grants can confirm inside the delivery budget.
   *
   * Must match the series' `max_armed_per_call`; eligibility prefers the
   * persisted series value and falls back to this only when the call's market
   * cannot be resolved.
   */
  maxArmedPerCall: number;
  minBalanceWei: bigint;
  /**
   * Flat, Murmur-configured access price in the settlement asset's atomic units
   * (e.g. USDC 6-decimals). ONE price for all calls: no
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
  /** A resolved signer (KMS-backed). When set, no raw key is read and the
   *  raw-key isolation checks below are replaced by assertDistinctSigners. */
  account?: LocalAccount;
}

/** Default sales safety margin, in seconds. Mirrors FhenixGrantEnvConfig. */
export const DEFAULT_SALES_SAFETY_SECONDS = 180;

export interface FhenixSaleTermsEnv {
  /**
   * The deployment-wide access terms, or null when this daemon has none.
   *
   * Called "legacy" because only calls sealed before providers could price
   * themselves (migration 070) are sold under them. Null is a real answer, not
   * a failure: a seal-only daemon has no price configured, and the storefront
   * must then EXCLUDE legacy rows rather than advertise a made-up number.
   */
  legacyTerms: CallTerms | null;
  /** Sales close this many seconds before the contract's grant deadline. */
  salesSafetySeconds: number;
}

/**
 * Sale terms as a READ, independent of FHENIX_GRANT_ENABLED.
 *
 * `loadFhenixGrantEnvConfig` returns null the moment grants are off, because
 * everything else it builds (a grantor key, an RPC client, a broadcast queue)
 * is machinery for selling. The terms themselves are not machinery — they are
 * the answer to "what would this call cost here", and a seal-only daemon must
 * resolve it exactly as a paid daemon would, or the same call is priced
 * differently depending on which process is asked.
 *
 * Deliberately LENIENT where the strict loader is fail-closed: a missing or
 * malformed price yields null terms instead of throwing. This path never takes
 * money — it only decides whether a legacy row can be listed — and a daemon
 * that seals fine should not refuse to boot over a storefront detail. The
 * strict loader still rejects the same values when grants are actually on.
 */
export function loadFhenixSaleTermsEnv(
  env: NodeJS.ProcessEnv = process.env,
): FhenixSaleTermsEnv {
  const priceAtoms = env.FHENIX_GRANT_PRICE_ATOMS?.trim() ?? "";
  const currency = env.FHENIX_GRANT_CURRENCY?.trim() ?? "";
  const pricingVersion = env.FHENIX_GRANT_PRICING_VERSION?.trim() ?? "";
  // ALL THREE or nothing. A price with no pricing version describes terms a
  // subscriber cannot be shown to have agreed to, and a currency with no price
  // is not an offer. Partial configuration reads as an operator mid-edit.
  const complete =
    /^[0-9]+$/.test(priceAtoms) &&
    BigInt(priceAtoms || "0") > 0n &&
    currency.length > 0 &&
    pricingVersion.length > 0;
  const salesSafetySeconds = (() => {
    const raw = env.FHENIX_GRANT_SALES_SAFETY_SEC?.trim();
    if (!raw) return DEFAULT_SALES_SAFETY_SECONDS;
    const value = Number(raw);
    // Fall back rather than throw, for the same reason as above — but never to
    // a SMALLER margin than the default, since a bad value must not widen the
    // sale window past what delivery can cover.
    if (!Number.isInteger(value) || value < 0) return DEFAULT_SALES_SAFETY_SECONDS;
    return value;
  })();
  return {
    legacyTerms: complete ? { priceAtoms, currency, pricingVersion } : null,
    salesSafetySeconds,
  };
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
  if (!privateKey && !opts.account) {
    throw new FhenixGrantConfigError(
      "FHENIX_GRANT_PRIVATE_KEY",
      "FHENIX_GRANT_ENABLED=true requires FHENIX_GRANT_PRIVATE_KEY (a DEDICATED grantor EOA, not the relayer or reveal key)",
    );
  }
  if (!opts.account) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey ?? "")) {
      throw new FhenixGrantConfigError(
        "FHENIX_GRANT_PRIVATE_KEY",
        "must be a 32-byte 0x-prefixed private key",
      );
    }
    // Key isolation: the grantor key must not equal the relayer key
    // (nonce contention with submit/discovery) nor the reveal key (couples the
    // privacy revenue path to the availability fallback).
    const relayerKey = env.FHENIX_GATEWAY_RELAYER_PRIVATE_KEY?.trim();
    if (relayerKey && relayerKey.toLowerCase() === privateKey!.toLowerCase()) {
      throw new FhenixGrantConfigError(
        "FHENIX_GRANT_PRIVATE_KEY",
        "must differ from FHENIX_GATEWAY_RELAYER_PRIVATE_KEY — a dedicated grantor key avoids nonce contention and privilege bleed",
      );
    }
    const revealKey = env.FHENIX_REVEAL_PRIVATE_KEY?.trim();
    if (revealKey && revealKey.toLowerCase() === privateKey!.toLowerCase()) {
      throw new FhenixGrantConfigError(
        "FHENIX_GRANT_PRIVATE_KEY",
        "must differ from FHENIX_REVEAL_PRIVATE_KEY — the grant path must not share the reveal EOA",
      );
    }
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
  // NO DEFAULT. The prior 179 came from dividing a block gas budget by a
  // measured per-grant cost — a derivation that described a batch transaction
  // this contract does not have. There is no defensible number to fall back
  // on: the real ceiling is how many grant transactions the grantor can fund
  // and confirm inside the delivery budget, which only the operator knows.
  const maxArmedRaw = env.FHENIX_GRANT_MAX_ARMED_PER_CALL?.trim() ?? "";
  if (!maxArmedRaw) {
    throw new FhenixGrantConfigError(
      "FHENIX_GRANT_MAX_ARMED_PER_CALL",
      "is required when FHENIX_GRANT_ENABLED=true — state the maximum number " +
        "of subscribers you will sell one call to (there is no default). Each " +
        "grant is its own transaction, so size it from what the grantor can " +
        "fund and confirm inside the delivery budget",
    );
  }
  const maxArmedPerCall = integerEnv("FHENIX_GRANT_MAX_ARMED_PER_CALL", 0, env, { min: 1 });
  // NO DEFAULT PRICE. A price is a commercial decision; a hidden $0.01 fallback
  // silently charges real subscribers a number nobody chose, and reads as
  // intentional in every log and receipt. Enabling paid grants must state it.
  const priceAtoms = env.FHENIX_GRANT_PRICE_ATOMS?.trim() ?? "";
  if (!priceAtoms) {
    throw new FhenixGrantConfigError(
      "FHENIX_GRANT_PRICE_ATOMS",
      "is required when FHENIX_GRANT_ENABLED=true — set the access price " +
        "explicitly in the settlement asset's atomic units (there is no default)",
    );
  }
  // BigInt, not a `!== "0"` string check: that compared the literal only, so
  // "00" and "000" passed startup and failed later at the Circle gateway —
  // an operator sees a healthy boot and a broken payment challenge.
  if (!/^[0-9]+$/.test(priceAtoms) || BigInt(priceAtoms) <= 0n) {
    throw new FhenixGrantConfigError(
      "FHENIX_GRANT_PRICE_ATOMS",
      "must be a positive integer atomic amount",
    );
  }
  const currency = env.FHENIX_GRANT_CURRENCY?.trim() ?? "";
  if (!currency) {
    throw new FhenixGrantConfigError(
      "FHENIX_GRANT_CURRENCY",
      `is required when FHENIX_GRANT_ENABLED=true (${SETTLEMENT_CURRENCY})`,
    );
  }
  // Must name the asset the rail actually charges. The Circle challenge always
  // denominates in USDC atoms, so any other label here is charged as USDC and
  // then written onto receipts under the wrong name — a mislabel on real
  // money, caught at startup rather than at the first sale.
  if (currency.toUpperCase() !== SETTLEMENT_CURRENCY) {
    throw new FhenixGrantConfigError(
      "FHENIX_GRANT_CURRENCY",
      `must be ${SETTLEMENT_CURRENCY} — the settlement rail charges in that asset ` +
        `and cannot honour "${currency}"`,
    );
  }
  // Pricing identity binds the commercial terms a subscriber agreed to, so it
  // fails closed alongside price and currency rather than silently becoming v1.
  const pricingVersion = env.FHENIX_GRANT_PRICING_VERSION?.trim() ?? "";
  if (!pricingVersion) {
    throw new FhenixGrantConfigError(
      "FHENIX_GRANT_PRICING_VERSION",
      "is required when FHENIX_GRANT_ENABLED=true (e.g. v1) — it identifies " +
        "the terms a subscriber agreed to and must be stated, not defaulted",
    );
  }
  const minBalanceWei = weiEnv(
    "FHENIX_GRANT_MIN_BALANCE_WEI",
    20_000_000_000_000_000n, // 0.02 ETH
    env,
  );

  const account = opts.account ?? privateKeyToAccount(privateKey as Hex, { nonceManager });
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
    maxArmedPerCall,
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
  account: LocalAccount;
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
          grantCloseAt: Number(view[1]),
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
    hasGrantorRole: async () =>
      (await deps.publicClient.readContract({
        address: deps.contractAddress as Address,
        abi: GRANT_ABI,
        functionName: "grantors",
        args: [deps.account.address],
      })) as boolean,
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
