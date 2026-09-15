// ─── The payout worker — the only thing here that spends money ──────────────
//
// One withdrawal row at a time, through four states, and every step is written
// down BEFORE the thing it describes is attempted.
//
//   reserved  → sign, persist the bytes and the nonce, THEN broadcast
//   signed    → broadcast (or rebroadcast the same bytes)
//   submitted → read the receipt, verify the transfer, journal it
//   paid      terminal
//
// ─── Why it is shaped like this ────────────────────────────────────────────
//
// An ERC-20 transfer has no idempotency. If the process dies between
// `broadcast()` returning and the row being updated, the only way to know
// whether money moved is to have written down, in advance, exactly what was
// sent and under which nonce. So:
//
//   · The bytes are persisted before the first broadcast. Recovery
//     REBROADCASTS those same bytes; it never re-signs. Re-signing would
//     produce a second, different transaction that could mine alongside the
//     first.
//   · The nonce is allocated once and owned for the life of the row, enforced
//     by a unique index. Two rows sharing a live nonce is the double-send this
//     whole design exists to prevent.
//   · A receipt must be FINAL and must carry a matching Transfer event before
//     anything is called paid.
//   · Anything the chain cannot answer becomes `needs_review`, which keeps
//     holding its reservation. Retries never expire into "probably fine": an
//     attempt limit is not evidence, and it must never authorize a fresh
//     payment.
//
// Deliberately NOT copied from the grant reconciler: its recovery path
// re-broadcasts a fresh transaction when the old one is lost. Grants are
// idempotent at the contract (granting twice is a no-op); transfers are not.

import type Database from "better-sqlite3";

import { providerPayoutsRepo } from "../verdict/repos/provider-payouts-repo.js";
import {
  providerWithdrawalsRepo,
  type ProviderWithdrawalRow,
} from "../verdict/repos/provider-withdrawals-repo.js";
import type { PayoutChainAdapter } from "./payout-chain-env.js";

export interface PayoutWorkerConfig {
  /** Receipt depth before a withdrawal may be called paid or failed. */
  confirmations: number;
  /** Rows per tick. Bounded so one stuck agent cannot starve the rest. */
  maxJobsPerTick: number;
  /** Backoff floor and ceiling between attempts on one row. */
  retryBaseMs: number;
  retryMaxMs: number;
  /** Refuse to sign below this much gas. Being stuck beats being half-sent. */
  minGasBalanceWei: bigint;
}

export interface PayoutWorkerDeps {
  db: Database.Database;
  now: () => Date;
  chain: PayoutChainAdapter;
  config: PayoutWorkerConfig;
  log?: (line: string) => void;
}

export interface PayoutTickResult {
  scanned: number;
  signed: number;
  broadcast: number;
  paid: number;
  failed: number;
  needsReview: number;
  deferred: number;
}

const EMPTY: PayoutTickResult = {
  scanned: 0,
  signed: 0,
  broadcast: 0,
  paid: 0,
  failed: 0,
  needsReview: 0,
  deferred: 0,
};

export async function payoutWorkerTick(deps: PayoutWorkerDeps): Promise<PayoutTickResult> {
  const result = { ...EMPTY };
  const nowIso = deps.now().toISOString();
  const due = providerWithdrawalsRepo.listDue(deps.db, nowIso, deps.config.maxJobsPerTick);
  result.scanned = due.length;
  if (due.length === 0) return result;

  // Checked once per tick, not per row: a worker that cannot pay gas must stop
  // before it signs anything, not discover it halfway through a batch.
  let gas: bigint;
  try {
    gas = await deps.chain.getGasBalanceWei();
  } catch (e) {
    deps.log?.(`[payout-worker] cannot read gas balance; skipping tick: ${errText(e)}`);
    result.deferred = due.length;
    return result;
  }
  if (gas < deps.config.minGasBalanceWei) {
    deps.log?.(
      `[payout-worker] gas balance ${gas} below floor ${deps.config.minGasBalanceWei}; not signing. ${due.length} withdrawal(s) waiting.`,
    );
    result.deferred = due.length;
    return result;
  }

  for (const row of due) {
    try {
      await advance(deps, row, result);
    } catch (e) {
      // An unexpected throw is never a reason to release a reservation: the
      // transfer may have gone out. Back off and look again.
      defer(deps, row, errText(e));
      result.deferred += 1;
    }
  }
  return result;
}

async function advance(
  deps: PayoutWorkerDeps,
  row: ProviderWithdrawalRow,
  result: PayoutTickResult,
): Promise<void> {
  // The scan is global; the adapter is bound to one sender, chain and token.
  // A row from a previous identity (a seller cutover, a chain change) must not
  // be signed by this one: it would pay from the wrong wallet or on the wrong
  // network. Park it for a human instead.
  if (
    row.chain_id !== deps.chain.chainId ||
    row.token_address.toLowerCase() !== deps.chain.tokenAddress.toLowerCase() ||
    row.sender_address.toLowerCase() !== deps.chain.senderAddress.toLowerCase()
  ) {
    review(
      deps,
      row,
      `row is for chain ${row.chain_id} / token ${row.token_address} / sender ${row.sender_address}; this worker signs for ${deps.chain.chainId} / ${deps.chain.tokenAddress} / ${deps.chain.senderAddress}`,
    );
    result.needsReview += 1;
    return;
  }
  switch (row.state) {
    case "reserved":
      return void (await signAndSend(deps, row, result));
    case "signed":
      return void (await rebroadcast(deps, row, result));
    case "submitted":
      return void (await settle(deps, row, result));
    default:
      result.deferred += 1;
  }
}

/**
 * Allocate a nonce, sign, PERSIST, then broadcast.
 *
 * The order is the entire safety property. Signing without persisting first
 * would leave a transaction in the mempool that no row in the database knows
 * about — unattributable money leaving the wallet.
 */
async function signAndSend(
  deps: PayoutWorkerDeps,
  row: ProviderWithdrawalRow,
  result: PayoutTickResult,
): Promise<void> {
  const amount = BigInt(row.amount_atoms);

  // Liquid balance, not Gateway credit. A sale settles into batched Gateway
  // funds that are not spendable ERC-20 until they are withdrawn, so a sold
  // agent does not imply a funded wallet.
  const balance = await deps.chain.getTokenBalance();
  if (balance < amount) {
    deps.log?.(
      `[payout-worker] withdrawal ${row.id} needs ${amount} but the sender holds ${balance}; waiting for the float to be topped up.`,
    );
    defer(deps, row, `insufficient liquid balance (${balance} < ${amount})`);
    result.deferred += 1;
    return;
  }

  // Own the nonce before signing. max(chain pending, highest ever claimed + 1)
  // so a row that was signed but whose outcome is unknown keeps its slot — the
  // chain's pending count does not know about a broadcast that never landed.
  const pending = await deps.chain.getPendingNonce();
  const claimed = providerWithdrawalsRepo.maxNonce(deps.db, {
    chainId: row.chain_id,
    senderAddress: row.sender_address,
  });
  const nonce = Math.max(pending, claimed === null ? 0 : claimed + 1);

  const signed = await deps.chain.signTransfer({
    to: row.destination_address,
    amountAtoms: amount,
    nonce,
  });

  // Durable BEFORE the broadcast. The unique index on (chain, sender, nonce)
  // is what makes a concurrent signer collide here rather than on chain.
  const persisted = providerWithdrawalsRepo.transition(deps.db, row.id, ["reserved"], {
    state: "signed",
    nonce: signed.nonce,
    signed_raw_tx: signed.raw,
    tx_hash: signed.hash,
    last_error: null,
    next_attempt_at: null,
    updated_at: deps.now().toISOString(),
  });
  if (!persisted) {
    // Another worker took this row between the scan and here. Its bytes are
    // the ones that count; ours are never broadcast.
    result.deferred += 1;
    return;
  }
  result.signed += 1;

  await send(deps, row.id, signed.raw, result);
}

/** A row that has bytes but no confirmed broadcast. Send the SAME bytes again. */
async function rebroadcast(
  deps: PayoutWorkerDeps,
  row: ProviderWithdrawalRow,
  result: PayoutTickResult,
): Promise<void> {
  if (!row.signed_raw_tx) {
    // The CHECK constraint makes this unreachable; if it ever happens the row
    // is not something to guess about.
    review(deps, row, "signed row carries no bytes");
    result.needsReview += 1;
    return;
  }
  await send(deps, row.id, row.signed_raw_tx, result);
}

async function send(
  deps: PayoutWorkerDeps,
  id: number,
  raw: string,
  result: PayoutTickResult,
): Promise<void> {
  try {
    await deps.chain.broadcast(raw);
  } catch (e) {
    const text = errText(e);
    // "already known" means the pool holds OUR bytes: a success, not a retry.
    if (/already known|known transaction|already imported/i.test(text)) {
      providerWithdrawalsRepo.transition(deps.db, id, ["signed", "submitted"], {
        state: "submitted",
        last_error: null,
        next_attempt_at: null,
        updated_at: deps.now().toISOString(),
      });
      result.broadcast += 1;
      return;
    }
    // "nonce too low" is NOT that. It means some transaction consumed this
    // nonce, and unless it was ours (which a rebroadcast of a mined tx also
    // reports) we cannot tell from here. Our bytes may never mine. Treating it
    // as landed would poll a hash forever while holding the funds. Park it: the
    // reservation stays held, a human checks the nonce, and it also says out
    // loud that something else is writing from the payout wallet.
    if (/nonce too low/i.test(text)) {
      const rowNow = providerWithdrawalsRepo.byId(deps.db, id);
      if (rowNow) {
        review(
          deps,
          rowNow,
          `nonce ${rowNow.nonce} was consumed by another transaction from the payout wallet; this transfer may never mine. Another writer is using this wallet.`,
        );
      }
      result.needsReview += 1;
      return;
    }
    // Anything else: the bytes stay, the row stays `signed`, and we try again.
    // We do NOT know whether the node accepted it.
    const rowNow = providerWithdrawalsRepo.byId(deps.db, id);
    if (rowNow) defer(deps, rowNow, `broadcast failed: ${text}`);
    result.deferred += 1;
    return;
  }
  providerWithdrawalsRepo.transition(deps.db, id, ["signed", "submitted"], {
    state: "submitted",
    last_error: null,
    next_attempt_at: null,
    updated_at: deps.now().toISOString(),
  });
  result.broadcast += 1;
}

/**
 * Read the receipt and finish the row.
 *
 * Three outcomes and no fourth: finalized success WITH a matching transfer
 * event is paid; a finalized revert is failed; everything else waits or goes
 * to review. "Probably fine" is not an outcome.
 */
async function settle(
  deps: PayoutWorkerDeps,
  row: ProviderWithdrawalRow,
  result: PayoutTickResult,
): Promise<void> {
  if (!row.tx_hash) {
    review(deps, row, "submitted row carries no hash");
    result.needsReview += 1;
    return;
  }
  const amount = BigInt(row.amount_atoms);
  let receipt;
  try {
    receipt = await deps.chain.getReceipt(row.tx_hash, {
      to: row.destination_address,
      amountAtoms: amount,
    });
  } catch (e) {
    // Could not read the chain. The reservation is HELD.
    defer(deps, row, `receipt read failed: ${errText(e)}`);
    result.deferred += 1;
    return;
  }

  if (!receipt) {
    // Not mined yet. Rebroadcasting the same bytes is safe and unsticks a
    // dropped mempool entry.
    if (row.signed_raw_tx) {
      try {
        await deps.chain.broadcast(row.signed_raw_tx);
      } catch {
        // Already known, or a transient node error. Either way, wait.
      }
    }
    defer(deps, row, null);
    result.deferred += 1;
    return;
  }

  if (receipt.confirmations < deps.config.confirmations) {
    defer(deps, row, null);
    result.deferred += 1;
    return;
  }

  if (!receipt.success) {
    // A finalized revert moved nothing. This is the ONE path that may release
    // a reservation, because the chain has said definitively that it did not
    // happen.
    providerWithdrawalsRepo.transition(deps.db, row.id, ["submitted"], {
      state: "failed",
      last_error: "transaction reverted",
      next_attempt_at: null,
      updated_at: deps.now().toISOString(),
    });
    deps.log?.(`[payout-worker] withdrawal ${row.id} reverted on chain; reservation released`);
    result.failed += 1;
    return;
  }

  if (!receipt.matchedTransfer) {
    // Succeeded, but did not move what we said it moved. Never journal this,
    // and never free the funds: a human has to look.
    review(
      deps,
      row,
      "receipt succeeded but carries no matching Transfer for this amount and destination",
    );
    result.needsReview += 1;
    return;
  }

  // Journal and finish in ONE transaction. A payout that is marked paid
  // without a journal row, or journalled without being marked paid, is the
  // pair of bugs that make the ledger and the chain disagree.
  const nowIso = deps.now().toISOString();
  const done = deps.db.transaction(() => {
    const payout = providerPayoutsRepo.insert(deps.db, {
      producer_agent_id: row.producer_agent_id,
      entry_type: "payout",
      currency: row.currency,
      amount_atoms: row.amount_atoms,
      // Chain-qualified, so a hash from another network can never collide with
      // this one under the journal's (agent, currency, tx_ref) uniqueness.
      tx_ref: `eip155:${row.chain_id}:${row.tx_hash}`,
      payout_method: "auto_erc20",
      destination_ref: row.destination_address,
      note: null,
      earnings_cutoff_at: row.created_at,
      created_at: nowIso,
    });
    return providerWithdrawalsRepo.transition(deps.db, row.id, ["submitted"], {
      state: "paid",
      payout_id: payout.id,
      last_error: null,
      next_attempt_at: null,
      updated_at: nowIso,
    });
  });

  try {
    if (done.immediate()) {
      result.paid += 1;
      deps.log?.(
        `[payout-worker] withdrawal ${row.id} paid: ${row.amount_atoms} ${row.currency} → ${row.destination_address}`,
      );
    } else {
      result.deferred += 1;
    }
  } catch (e) {
    // A journal collision means this transfer was already recorded — the row
    // is ahead of us, not duplicated. Do not retry the transfer.
    review(deps, row, `journal write failed: ${errText(e)}`);
    result.needsReview += 1;
  }
}

/** Back off. Never changes state, so the reservation keeps holding. */
function defer(deps: PayoutWorkerDeps, row: ProviderWithdrawalRow, error: string | null): void {
  const attempt = row.attempts + 1;
  const delay = Math.min(
    deps.config.retryMaxMs,
    deps.config.retryBaseMs * 2 ** Math.min(attempt, 10),
  );
  providerWithdrawalsRepo.transition(deps.db, row.id, [row.state], {
    state: row.state,
    last_error: error,
    next_attempt_at: new Date(deps.now().getTime() + delay).toISOString(),
    bumpAttempts: true,
    updated_at: deps.now().toISOString(),
  });
  if (error) deps.log?.(`[payout-worker] withdrawal ${row.id} deferred: ${error}`);
}

/** Park for a human. The reservation is held indefinitely, on purpose. */
function review(deps: PayoutWorkerDeps, row: ProviderWithdrawalRow, why: string): void {
  providerWithdrawalsRepo.transition(deps.db, row.id, [row.state], {
    state: "needs_review",
    last_error: why,
    next_attempt_at: null,
    updated_at: deps.now().toISOString(),
  });
  deps.log?.(`[payout-worker] withdrawal ${row.id} NEEDS REVIEW: ${why}`);
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
