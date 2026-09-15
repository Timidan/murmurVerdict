// ─── Payout configuration ───────────────────────────────────────────────────
//
// Off by default, and it stays off unless EVERY piece is present. A payout
// rail that half-starts is worse than one that does not start: an owner sees a
// withdraw button, the reservation is taken, and nothing ever sends.
//
// The signer is the SELLER EOA, the address x402 names as payTo, and it is a
// DEDICATED wallet: it must not be the gateway relayer, the grantor, or the
// reveal worker. Both halves are checked at boot from derived addresses.
//
// Why dedicated: every other writer on a key shares that key's nonce lane
// through one queue (fhenix-gateway-env.ts). The payout outbox allocates its
// nonces durably from the database so a signed transfer survives a restart,
// which is exactly the thing a shared in-memory nonce manager cannot see. Two
// allocators on one wallet race the same nonce. Seller equality is an
// operational convention that keeps sale proceeds and payouts on one balance;
// it is not a liquidity guarantee, since sales arrive as Gateway credit and
// the worker checks liquid token balance separately.

import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex, LocalAccount } from "viem";

export class PayoutConfigError extends Error {
  readonly key: string;

  constructor(key: string, message: string) {
    super(`${key}: ${message}`);
    this.name = "PayoutConfigError";
    this.key = key;
  }
}

export interface PayoutConfig {
  chainId: number;
  rpcUrl: string;
  tokenAddress: Address;
  currency: string;
  /** The signer. Raw-key or KMS-backed; the worker cannot tell and must not. */
  account: LocalAccount;
  /** account.address, verified against the seller address. */
  senderAddress: string;
  confirmations: number;
  tickSec: number;
  maxJobsPerTick: number;
  retryBaseMs: number;
  retryMaxMs: number;
  minGasBalanceWei: bigint;
  /** How often deadlines are swept for auto-acceptance. */
  deliverySweepTickSec: number;
  /** Binds acceptance signatures to this deployment. */
  popAudience: string;
}

export type PayoutConfigResult =
  | { enabled: true; config: PayoutConfig }
  | { enabled: false; reason: string };

const HEX_KEY = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * Read the payout rail's configuration, or say precisely why it is off.
 *
 * Never throws for "not configured" — that is the normal state of a deployment
 * that does not pay providers automatically. It DOES throw when the
 * configuration is present but wrong, because silently running with a payout
 * key that is not the seller is the failure worth refusing to boot over.
 */
export function loadPayoutConfig(
  env: NodeJS.ProcessEnv,
  opts: {
    /** A resolved KMS-backed signer. When set, MURMUR_PAYOUT_PRIVATE_KEY is not read. */
    account?: LocalAccount;
    /** Addresses of the other lanes' signers, for the distinctness rule. */
    peerAddresses?: readonly string[];
  } = {},
): PayoutConfigResult {
  if ((env.MURMUR_PAYOUT_ENABLED ?? "false").toLowerCase() !== "true") {
    return { enabled: false, reason: "MURMUR_PAYOUT_ENABLED is not true" };
  }

  const privateKey = (env.MURMUR_PAYOUT_PRIVATE_KEY ?? "").trim();
  if (!privateKey && !opts.account) {
    return { enabled: false, reason: "neither MURMUR_PAYOUT_PRIVATE_KEY nor MURMUR_PAYOUT_KMS_KEY_ID is set" };
  }
  if (!opts.account && !HEX_KEY.test(privateKey)) {
    throw new PayoutConfigError("MURMUR_PAYOUT_PRIVATE_KEY", "not a 0x-prefixed 32-byte hex key");
  }

  const rpcUrl = (env.MURMUR_PAYOUT_RPC_URL ?? "").trim();
  if (!rpcUrl) return { enabled: false, reason: "MURMUR_PAYOUT_RPC_URL is unset" };

  const tokenAddress = (env.MURMUR_PAYOUT_TOKEN_ADDRESS ?? "").trim();
  if (!tokenAddress) return { enabled: false, reason: "MURMUR_PAYOUT_TOKEN_ADDRESS is unset" };
  if (!ADDRESS.test(tokenAddress)) {
    throw new PayoutConfigError("MURMUR_PAYOUT_TOKEN_ADDRESS", "not a 0x address");
  }

  const chainId = Number(env.MURMUR_PAYOUT_CHAIN_ID ?? "");
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new PayoutConfigError("MURMUR_PAYOUT_CHAIN_ID", "must be a positive integer");
  }

  const account = opts.account ?? privateKeyToAccount(privateKey as Hex);
  const senderAddress = account.address.toLowerCase();

  // THE preflight. The seller address is where every sale lands; a payout key
  // for any other wallet cannot pay anyone, and would only say so by reverting
  // after a reservation had already been taken.
  const seller = (env.MURMUR_NANOPAY_SELLER_ADDRESS ?? "").trim().toLowerCase();
  if (!seller) {
    throw new PayoutConfigError(
      "MURMUR_NANOPAY_SELLER_ADDRESS",
      "required when payouts are enabled — it is the wallet sales settle into, and the one payouts must send from",
    );
  }
  if (seller !== senderAddress) {
    throw new PayoutConfigError(
      "MURMUR_PAYOUT_PRIVATE_KEY",
      `derives ${senderAddress}, which is not the seller address ${seller}. Sale proceeds land in the seller wallet; a payout signed by any other key would send from an empty one.`,
    );
  }

  // No other writer may share this wallet. Compared by DERIVED address, so a
  // key pasted under two names is caught, not just an identical string.
  // Raw peers are derived here; KMS-backed peers arrive as addresses.
  const peers: Array<[string, string]> = (opts.peerAddresses ?? []).map((a) => [
    "another KMS-backed lane",
    a.toLowerCase(),
  ]);
  for (const other of [
    "FHENIX_GATEWAY_RELAYER_PRIVATE_KEY",
    "FHENIX_GRANT_PRIVATE_KEY",
    "FHENIX_REVEAL_PRIVATE_KEY",
  ] as const) {
    const raw = (env[other] ?? "").trim();
    if (HEX_KEY.test(raw)) peers.push([other, privateKeyToAccount(raw as Hex).address.toLowerCase()]);
  }
  for (const [name, address] of peers) {
    if (address === senderAddress) {
      throw new PayoutConfigError(
        "MURMUR_PAYOUT_PRIVATE_KEY",
        `is the same wallet as ${name}. The payout outbox owns its wallet's nonces; a second writer on that wallet races them. Use a dedicated seller/payout wallet.`,
      );
    }
  }

  const popAudience = (env.MURMUR_POP_AUDIENCE ?? "").trim() || "murmur.verdict";

  return {
    enabled: true,
    config: {
      chainId,
      rpcUrl,
      tokenAddress: tokenAddress.toLowerCase() as Address,
      currency: (env.MURMUR_PAYOUT_CURRENCY ?? "USDC").trim().toUpperCase(),
      account,
      senderAddress,
      confirmations: intEnv(env, "MURMUR_PAYOUT_CONFIRMATIONS", 2, 1),
      tickSec: intEnv(env, "MURMUR_PAYOUT_TICK_SEC", 30, 5),
      maxJobsPerTick: intEnv(env, "MURMUR_PAYOUT_MAX_JOBS_PER_TICK", 5, 1),
      retryBaseMs: intEnv(env, "MURMUR_PAYOUT_RETRY_BASE_MS", 5_000, 100),
      retryMaxMs: intEnv(env, "MURMUR_PAYOUT_RETRY_MAX_MS", 300_000, 1_000),
      minGasBalanceWei: bigintEnv(env, "MURMUR_PAYOUT_MIN_GAS_WEI", 20_000_000_000_000_000n),
      deliverySweepTickSec: intEnv(env, "MURMUR_DELIVERY_SWEEP_TICK_SEC", 120, 10),
      popAudience,
    },
  };
}

function intEnv(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number): number {
  const raw = (env[key] ?? "").trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    throw new PayoutConfigError(key, `must be an integer >= ${min}`);
  }
  return n;
}

function bigintEnv(env: NodeJS.ProcessEnv, key: string, fallback: bigint): bigint {
  const raw = (env[key] ?? "").trim();
  if (!raw) return fallback;
  if (!/^[0-9]+$/.test(raw)) throw new PayoutConfigError(key, "must be a non-negative integer");
  return BigInt(raw);
}
