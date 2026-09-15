// ─── Requesting a withdrawal ────────────────────────────────────────────────
//
// The owner asks to be paid; this module decides whether they may be, and
// writes down the intent. It does NOT move money — that is the worker's job,
// and keeping the two apart is what makes the decision auditable separately
// from the transfer.
//
// EVERYTHING here happens in ONE IMMEDIATE transaction: read the balance,
// check it covers the request, and take the reservation. Split those apart and
// two requests arriving together each see the same funds as free, and the
// agent withdraws its balance twice. The write lock is taken from the first
// statement for the same reason.
//
// The destination is SNAPSHOTTED into the row. A payout must go where the
// owner said at the moment they asked; re-reading the address later would let
// an address changed mid-flight redirect a transfer that was already signed.

import type Database from "better-sqlite3";

import { prep } from "./db-statements.js";
import {
  readProviderReleaseBalance,
  type ProviderReleaseBalance,
} from "./provider-release-balance.js";
import {
  providerWithdrawalsRepo,
  type ProviderWithdrawalRow,
} from "./repos/provider-withdrawals-repo.js";

/** Where payouts go out from, for one deployment. One asset, one network. */
export interface PayoutAssetConfig {
  chainId: number;
  tokenAddress: string;
  currency: string;
  senderAddress: string;
}

export interface WithdrawalRequest {
  producerAgentId: string;
  /** The caller's idempotency key. Same key twice is the SAME withdrawal. */
  clientRequestId: string;
  /**
   * Atomic units, or null for "everything available".
   *
   * Null is the normal case: the button says withdraw what I have, and a
   * client that names its own number is one round trip away from naming a
   * stale one.
   */
  amountAtoms: string | null;
}

export type WithdrawalRequestResult =
  | { ok: true; withdrawal: ProviderWithdrawalRow; replayed: boolean }
  | { ok: false; code: WithdrawalErrorCode; message: string; status: number };

export type WithdrawalErrorCode =
  | "no_destination"
  | "nothing_available"
  | "insufficient_available"
  | "bad_amount"
  | "request_conflict";

export interface WithdrawalDeps {
  db: Database.Database;
  now: () => Date;
  asset: PayoutAssetConfig;
}

/**
 * Reserve a withdrawal, or explain why not.
 *
 * Idempotent on (agent, chain, token, clientRequestId): a retry of the same
 * request replays the original row rather than reserving a second time. A
 * retry carrying a DIFFERENT amount is a conflict, not an update — the caller
 * changed its mind about money that may already be in flight.
 */
export function requestWithdrawal(
  deps: WithdrawalDeps,
  input: WithdrawalRequest,
): WithdrawalRequestResult {
  const { db, asset } = deps;
  const nowIso = deps.now().toISOString();

  if (input.amountAtoms !== null && !/^[1-9][0-9]*$/.test(input.amountAtoms)) {
    return {
      ok: false,
      code: "bad_amount",
      status: 400,
      message: "amount_atoms must be a positive integer string, or omitted to take everything.",
    };
  }

  const run = db.transaction((): WithdrawalRequestResult => {
    const existing = providerWithdrawalsRepo.byRequest(db, {
      producerAgentId: input.producerAgentId,
      chainId: asset.chainId,
      tokenAddress: asset.tokenAddress,
      clientRequestId: input.clientRequestId,
    });
    if (existing) {
      // A replay must return the ORIGINAL, not a fresh reservation. Only an
      // amount that disagrees is an error, because that is the caller asking
      // for something different under a key that is already spoken for.
      if (input.amountAtoms !== null && existing.amount_atoms !== input.amountAtoms) {
        return {
          ok: false,
          code: "request_conflict",
          status: 409,
          message: "That request id already reserved a different amount.",
        };
      }
      return { ok: true, withdrawal: existing, replayed: true };
    }

    const destination = readDestination(db, input.producerAgentId);
    if (!destination) {
      return {
        ok: false,
        code: "no_destination",
        status: 409,
        message: "Set a payout address for this agent before withdrawing.",
      };
    }

    const balance = readProviderReleaseBalance(db, input.producerAgentId, asset.currency);
    const available = BigInt(balance?.available_atoms ?? "0");
    if (available <= 0n) {
      return {
        ok: false,
        code: "nothing_available",
        status: 409,
        message: nothingAvailableReason(balance),
      };
    }

    const amount = input.amountAtoms === null ? available : BigInt(input.amountAtoms);
    if (amount > available) {
      return {
        ok: false,
        code: "insufficient_available",
        status: 409,
        message: `Only ${available.toString()} atoms are available right now.`,
      };
    }

    const withdrawal = providerWithdrawalsRepo.reserve(db, {
      producer_agent_id: input.producerAgentId,
      client_request_id: input.clientRequestId,
      chain_id: asset.chainId,
      token_address: asset.tokenAddress,
      currency: asset.currency,
      amount_atoms: amount.toString(),
      destination_address: destination,
      sender_address: asset.senderAddress,
      created_at: nowIso,
    });
    return { ok: true, withdrawal, replayed: false };
  });

  // IMMEDIATE: the balance read must happen under the write lock, or a
  // concurrent request reads the same funds as free before either reserves.
  return run.immediate();
}

/**
 * Say WHY there is nothing to take. "Nothing available" over an agent holding
 * four pending sales is technically true and useless; each of these is a
 * different thing for the owner to do about it.
 */
function nothingAvailableReason(balance: ProviderReleaseBalance | null): string {
  if (!balance) return "This agent has not sold anything yet.";
  if (BigInt(balance.reserved_atoms) > 0n) {
    return "A withdrawal is already in flight. It has to finish before another can start.";
  }
  if (BigInt(balance.held_net_atoms) > 0n) {
    return `${balance.held_sales} sale${balance.held_sales === 1 ? " is" : "s are"} waiting on buyer confirmation. They become withdrawable once the buyer accepts, or once the call is publicly revealed.`;
  }
  if (BigInt(balance.unenrolled_net_atoms) > 0n) {
    return "These sales predate murmur's delivery policy and need an operator to reconcile them before they can be withdrawn.";
  }
  if (BigInt(balance.cancelled_net_atoms) > 0n) {
    return "Every sale here was refunded to the buyer, so nothing is owed.";
  }
  return "Everything earned has already been paid out.";
}

function readDestination(db: Database.Database, agentId: string): string | null {
  const row = prep(
    db,
    "SELECT destination_address FROM agents WHERE agent_id = ?",
  ).get(agentId) as { destination_address: string | null } | undefined;
  const address = row?.destination_address ?? null;
  // A destination that is not an address is not a destination. The set-surface
  // validates on write; this is the read-side guard against a row that got
  // there another way.
  if (!address || !/^0x[0-9a-f]{40}$/i.test(address)) return null;
  return address.toLowerCase();
}

/** One agent's withdrawal history, newest first, for the owner's page. */
export function listWithdrawals(
  db: Database.Database,
  producerAgentId: string,
  limit = 20,
): ProviderWithdrawalRow[] {
  return providerWithdrawalsRepo.listForAgent(db, producerAgentId, limit);
}
