import type Database from "better-sqlite3";

import { prep } from "../db-statements.js";

// ─── provider_withdrawals — the payout outbox (migration 080) ───────────────
//
// An ERC-20 transfer has NO idempotency of its own. Nothing on chain will stop
// a restarted process from sending a second one, and no amount of "did it
// work?" polling closes the window between broadcasting and learning the
// answer. The only thing that does is a durable row written BEFORE anything is
// signed, naming the exact nonce and the exact bytes.
//
// So read every state here as a claim about what MAY already be on chain:
//
//   reserved      nothing is signed; this is the only state certainly not sent
//   signed        bytes exist, so assume they may have been broadcast
//   submitted     a broadcast returned a hash
//   paid          finalized receipt AND a matching transfer event; journalled
//   failed        finalized revert; the funds were never moved
//   needs_review  the chain could not be read conclusively
//
// `needs_review` HOLDS its reservation forever until a human looks. That is
// deliberate: releasing a reservation whose transfer might have landed is how
// the same earnings fund two transfers. An attempt limit is not evidence, and
// it never authorizes a fresh payment.

export type WithdrawalState =
  | "reserved"
  | "signed"
  | "submitted"
  | "paid"
  | "failed"
  | "needs_review";

/**
 * States whose money is spoken for. A withdrawal here reduces what the agent
 * may request next, whether or not the transfer has landed.
 *
 * `paid` is absent because a paid withdrawal is counted by its JOURNAL row
 * instead; counting both would debit the same transfer twice.
 */
export const HOLDING_WITHDRAWAL_STATES: readonly WithdrawalState[] = [
  "reserved",
  "signed",
  "submitted",
  "needs_review",
];

/** States the worker can still move. `needs_review` is excluded: it wants a human. */
export const WORKABLE_WITHDRAWAL_STATES: readonly WithdrawalState[] = [
  "reserved",
  "signed",
  "submitted",
];

export interface ProviderWithdrawalRow {
  id: number;
  producer_agent_id: string;
  client_request_id: string;
  chain_id: number;
  token_address: string;
  currency: string;
  amount_atoms: string;
  destination_address: string;
  sender_address: string;
  state: WithdrawalState;
  nonce: number | null;
  signed_raw_tx: string | null;
  tx_hash: string | null;
  attempts: number;
  last_error: string | null;
  next_attempt_at: string | null;
  payout_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface ProviderWithdrawalInsert {
  producer_agent_id: string;
  client_request_id: string;
  chain_id: number;
  token_address: string;
  currency: string;
  amount_atoms: string;
  destination_address: string;
  sender_address: string;
  created_at: string;
}

const COLUMNS = `id, producer_agent_id, client_request_id, chain_id, token_address,
       currency, amount_atoms, destination_address, sender_address, state, nonce,
       signed_raw_tx, tx_hash, attempts, last_error, next_attempt_at, payout_id,
       created_at, updated_at`;

export const providerWithdrawalsRepo = {
  /**
   * Take a reservation. Throws on a duplicate request key — the caller decides
   * whether that is a retry to replay or a conflict to refuse, and it cannot
   * decide that without comparing the content.
   */
  reserve(
    db: Database.Database,
    input: ProviderWithdrawalInsert,
  ): ProviderWithdrawalRow {
    const info = prep(
      db,
      `INSERT INTO provider_withdrawals
         (producer_agent_id, client_request_id, chain_id, token_address, currency,
          amount_atoms, destination_address, sender_address, state,
          created_at, updated_at)
       VALUES (@producer_agent_id, @client_request_id, @chain_id, @token_address,
               @currency, @amount_atoms, @destination_address, @sender_address,
               'reserved', @created_at, @created_at)`,
    ).run({ ...input, currency: input.currency.toUpperCase() });
    const row = this.byId(db, Number(info.lastInsertRowid));
    if (!row) throw new Error("provider_withdrawals insert produced no row");
    return row;
  },

  byId(db: Database.Database, id: number): ProviderWithdrawalRow | null {
    return (prep(
      db,
      `SELECT ${COLUMNS} FROM provider_withdrawals WHERE id = ?`,
    ).get(id) ?? null) as ProviderWithdrawalRow | null;
  },

  byRequest(
    db: Database.Database,
    key: {
      producerAgentId: string;
      chainId: number;
      tokenAddress: string;
      clientRequestId: string;
    },
  ): ProviderWithdrawalRow | null {
    return (prep(
      db,
      `SELECT ${COLUMNS} FROM provider_withdrawals
        WHERE producer_agent_id = @agent AND chain_id = @chain
          AND token_address = @token AND client_request_id = @req`,
    ).get({
      agent: key.producerAgentId,
      chain: key.chainId,
      token: key.tokenAddress,
      req: key.clientRequestId,
    }) ?? null) as ProviderWithdrawalRow | null;
  },

  /**
   * What this agent already has in flight, in one currency, as BigInt.
   *
   * Summed in JS and never in SQLite: these are TEXT atoms that exceed the
   * range SUM() carries through a 64-bit float. Read INSIDE the reservation
   * transaction, or two concurrent requests each see the other's funds as free.
   */
  heldAtoms(
    db: Database.Database,
    key: { producerAgentId: string; currency: string },
  ): bigint {
    const placeholders = HOLDING_WITHDRAWAL_STATES.map((_, i) => `@s${i}`).join(", ");
    const params: Record<string, unknown> = {
      agent: key.producerAgentId,
      currency: key.currency.toUpperCase(),
    };
    HOLDING_WITHDRAWAL_STATES.forEach((s, i) => {
      params[`s${i}`] = s;
    });
    const rows = prep(
      db,
      `SELECT amount_atoms FROM provider_withdrawals
        WHERE producer_agent_id = @agent AND currency = @currency
          AND state IN (${placeholders})`,
    ).all(params) as { amount_atoms: string }[];
    let total = 0n;
    for (const r of rows) total += BigInt(r.amount_atoms);
    return total;
  },

  /**
   * Compare-and-set on state. Every worker step goes through this, so no two
   * ticks can both advance the same row.
   */
  transition(
    db: Database.Database,
    id: number,
    from: readonly WithdrawalState[],
    patch: {
      state: WithdrawalState;
      nonce?: number | null;
      signed_raw_tx?: string | null;
      tx_hash?: string | null;
      last_error?: string | null;
      next_attempt_at?: string | null;
      payout_id?: number | null;
      bumpAttempts?: boolean;
      updated_at: string;
    },
  ): boolean {
    if (from.length === 0) return false;
    const sets: string[] = ["state = @state", "updated_at = @updated_at"];
    for (const key of [
      "nonce",
      "signed_raw_tx",
      "tx_hash",
      "last_error",
      "next_attempt_at",
      "payout_id",
    ] as const) {
      if (key in patch) sets.push(`${key} = @${key}`);
    }
    if (patch.bumpAttempts) sets.push("attempts = attempts + 1");
    const placeholders = from.map((_, i) => `@from${i}`).join(", ");
    const params: Record<string, unknown> = { ...patch, id };
    delete params.bumpAttempts;
    from.forEach((s, i) => {
      params[`from${i}`] = s;
    });
    const info = prep(
      db,
      `UPDATE provider_withdrawals SET ${sets.join(", ")}
        WHERE id = @id AND state IN (${placeholders})`,
    ).run(params);
    return info.changes > 0;
  },

  /** Rows the worker may still act on, due now, oldest first. */
  listDue(db: Database.Database, nowIso: string, limit: number): ProviderWithdrawalRow[] {
    const placeholders = WORKABLE_WITHDRAWAL_STATES.map((_, i) => `@s${i}`).join(", ");
    const params: Record<string, unknown> = { now: nowIso, limit };
    WORKABLE_WITHDRAWAL_STATES.forEach((s, i) => {
      params[`s${i}`] = s;
    });
    return prep(
      db,
      `SELECT ${COLUMNS} FROM provider_withdrawals
        WHERE state IN (${placeholders})
          AND (next_attempt_at IS NULL OR next_attempt_at <= @now)
        ORDER BY id ASC
        LIMIT @limit`,
    ).all(params) as ProviderWithdrawalRow[];
  },

  /** Open rows for one agent, newest first — what the owner's page shows. */
  listForAgent(
    db: Database.Database,
    producerAgentId: string,
    limit: number,
  ): ProviderWithdrawalRow[] {
    return prep(
      db,
      `SELECT ${COLUMNS} FROM provider_withdrawals
        WHERE producer_agent_id = @agent
        ORDER BY id DESC LIMIT @limit`,
    ).all({ agent: producerAgentId, limit }) as ProviderWithdrawalRow[];
  },

  /**
   * The highest nonce this sender has ever claimed, or null.
   *
   * Nonce allocation reads this inside the signing transaction and takes
   * max(chain pending, this + 1), so a row that was signed but whose broadcast
   * outcome is unknown still owns its slot.
   */
  maxNonce(
    db: Database.Database,
    key: { chainId: number; senderAddress: string },
  ): number | null {
    const row = prep(
      db,
      `SELECT MAX(nonce) AS n FROM provider_withdrawals
        WHERE chain_id = @chain AND sender_address = @sender AND nonce IS NOT NULL`,
    ).get({ chain: key.chainId, sender: key.senderAddress }) as { n: number | null };
    return row?.n ?? null;
  },
};
