import type Database from "better-sqlite3";

import { prep } from "../db-statements.js";

// ─── provider_payouts — the payout JOURNAL (migration 073) ──────────────────
//
// provider_earnings says what a sale ACCRUED to a provider. This table says
// what murmur PAID them. Subtract one from the other and the balance is a
// computable fact rather than an operator's memory.
//
// APPEND-ONLY, and the database enforces it: BEFORE UPDATE / BEFORE DELETE
// triggers RAISE. There is deliberately no `update` and no `delete` here, and
// adding one would not work if you tried. A payout that has to be undone is
// undone by a 'reversal' row — the original stays, because a journal you can
// edit is a journal nobody can audit.
//
// EVERY amount is POSITIVE. The direction lives in entry_type. A signed
// amount column would let "payout of -5" and "reversal of 5" both exist and
// mean the same thing, and every total would then depend on which of the two
// conventions the query author had in mind.

export type ProviderPayoutEntryType = "payout" | "reversal";

export interface ProviderPayoutRow {
  id: number;
  producer_agent_id: string;
  entry_type: ProviderPayoutEntryType;
  currency: string;
  /** Positive atomic units as TEXT. Summed in BigInt in JS, never in SQLite. */
  amount_atoms: string;
  /** Transfer hash / bank reference / batch id. Also the idempotency key. */
  tx_ref: string;
  payout_method: string;
  /** Where the money actually went, snapshotted at the time it went there. */
  destination_ref: string;
  note: string | null;
  /**
   * "this settled everything accrued up to here". AUDIT CONTEXT ONLY —
   * nothing in this repo or the surfaces above it computes with the value.
   */
  earnings_cutoff_at: string;
  created_at: string;
}

export interface ProviderPayoutInsert {
  producer_agent_id: string;
  entry_type: ProviderPayoutEntryType;
  currency: string;
  amount_atoms: string;
  tx_ref: string;
  payout_method: string;
  destination_ref: string;
  note: string | null;
  earnings_cutoff_at: string;
  created_at: string;
}

export interface ProviderPayoutsCurrencyTotal {
  currency: string;
  /** Rows counted, both directions. */
  entries: number;
  /** Sum of 'payout' rows minus sum of 'reversal' rows. May be negative. */
  net_paid_atoms: string;
  paid_atoms: string;
  reversed_atoms: string;
}

const COLUMNS = `id, producer_agent_id, entry_type, currency, amount_atoms, tx_ref,
       payout_method, destination_ref, note, earnings_cutoff_at, created_at`;

export const providerPayoutsRepo = {
  /**
   * Append one journal entry. Throws on a duplicate
   * (producer_agent_id, currency, tx_ref) — the caller decides whether that
   * collision is a legitimate retry (replay the existing row) or a genuine
   * conflict (409), and it cannot decide that without comparing content.
   *
   * `currency` is uppercased at write so per-currency totals cannot split into
   * "USDC" and "usdc" buckets that each look complete — same normalization
   * provider-earnings-repo applies to the accrual side.
   */
  insert(db: Database.Database, input: ProviderPayoutInsert): ProviderPayoutRow {
    const info = prep(
      db,
      `INSERT INTO provider_payouts
         (producer_agent_id, entry_type, currency, amount_atoms, tx_ref,
          payout_method, destination_ref, note, earnings_cutoff_at, created_at)
       VALUES (@producer_agent_id, @entry_type, @currency, @amount_atoms, @tx_ref,
               @payout_method, @destination_ref, @note, @earnings_cutoff_at,
               @created_at)`,
    ).run({ ...input, currency: input.currency.toUpperCase() });
    const row = this.byId(db, Number(info.lastInsertRowid));
    if (!row) throw new Error("provider_payouts insert produced no row");
    return row;
  },

  /**
   * Net paid = payouts minus reversals for one (agent, currency), summed as
   * BigInt in JS — never SQLite SUM over TEXT atoms. The reversal bound reads
   * this inside the insert transaction.
   */
  netPaidAtoms(
    db: Database.Database,
    key: { producerAgentId: string; currency: string },
  ): bigint {
    const rows = prep(
      db,
      `SELECT entry_type, amount_atoms FROM provider_payouts
       WHERE producer_agent_id = @producer_agent_id AND currency = @currency`,
    ).all({
      producer_agent_id: key.producerAgentId,
      currency: key.currency.toUpperCase(),
    }) as { entry_type: string; amount_atoms: string }[];
    let net = 0n;
    for (const r of rows) {
      net += r.entry_type === "reversal" ? -BigInt(r.amount_atoms) : BigInt(r.amount_atoms);
    }
    return net;
  },

  byId(db: Database.Database, id: number): ProviderPayoutRow | null {
    return (
      (prep(db, `SELECT ${COLUMNS} FROM provider_payouts WHERE id = ?`).get(id) as
        | ProviderPayoutRow
        | undefined) ?? null
    );
  },

  /** The idempotency lookup: the natural key the UNIQUE index is built on. */
  byIdempotencyKey(
    db: Database.Database,
    input: { producerAgentId: string; currency: string; txRef: string },
  ): ProviderPayoutRow | null {
    return (
      (prep(
        db,
        `SELECT ${COLUMNS} FROM provider_payouts
          WHERE producer_agent_id = ? AND currency = ? AND tx_ref = ?`,
      ).get(
        input.producerAgentId,
        input.currency.toUpperCase(),
        input.txRef,
      ) as ProviderPayoutRow | undefined) ?? null
    );
  },

  /** One provider's journal, newest first. */
  listForAgent(
    db: Database.Database,
    input: { producerAgentId: string; limit: number; offset?: number },
  ): ProviderPayoutRow[] {
    return prep(
      db,
      `SELECT ${COLUMNS} FROM provider_payouts
        WHERE producer_agent_id = @producer_agent_id
        ORDER BY created_at DESC, id DESC
        LIMIT @limit OFFSET @offset`,
    ).all({
      producer_agent_id: input.producerAgentId,
      limit: input.limit,
      offset: input.offset ?? 0,
    }) as ProviderPayoutRow[];
  },

  /**
   * Per-currency paid totals, summed in BigInt IN JS.
   *
   * Never SUM()/CAST() amount_atoms in SQLite: atomic amounts routinely exceed
   * 2^53, CAST(... AS INTEGER) on a TEXT column truncates at the first
   * non-digit, and SUM over enough rows goes through a float. The same rule
   * provider-earnings-repo states, for the same reason.
   *
   * net_paid_atoms MAY BE NEGATIVE — reversals can exceed payouts in a
   * currency after a clawback. It is returned signed on purpose; flooring it
   * at zero here would quietly turn "murmur is owed money back" into
   * "settled".
   */
  totalsForAgent(
    db: Database.Database,
    producerAgentId: string,
  ): ProviderPayoutsCurrencyTotal[] {
    const rows = prep(
      db,
      `SELECT currency, entry_type, amount_atoms
         FROM provider_payouts
        WHERE producer_agent_id = ?`,
    ).all(producerAgentId) as Array<{
      currency: string;
      entry_type: ProviderPayoutEntryType;
      amount_atoms: string;
    }>;
    const totals = new Map<
      string,
      { entries: number; paid: bigint; reversed: bigint }
    >();
    for (const row of rows) {
      const key = row.currency.toUpperCase();
      const acc = totals.get(key) ?? { entries: 0, paid: 0n, reversed: 0n };
      acc.entries += 1;
      if (row.entry_type === "reversal") acc.reversed += BigInt(row.amount_atoms);
      else acc.paid += BigInt(row.amount_atoms);
      totals.set(key, acc);
    }
    return [...totals.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([currency, acc]) => ({
        currency,
        entries: acc.entries,
        net_paid_atoms: (acc.paid - acc.reversed).toString(),
        paid_atoms: acc.paid.toString(),
        reversed_atoms: acc.reversed.toString(),
      }));
  },
} as const;
