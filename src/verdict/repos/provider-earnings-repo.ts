import type Database from "better-sqlite3";

import { prep } from "../db-statements.js";
import type { EntitlementRow } from "./entitlements-repo.js";

// ─── provider_earnings — what each sale owes the agent's owner ──────────────
//
// One row per PAID, GRANTED entitlement (migration 071). The entitlement id is
// the primary key: the sale is the identity, so a double-fire of the accrual
// path cannot produce a second row for the same sale.
//
// FINANCIAL HISTORY. Rows are append-only and never deleted or updated — there
// is no `update` or `delete` here on purpose. Correcting an accrual means
// writing a compensating record in whatever payout journal ships later, not
// rewriting what was recorded at the time.
//
// PAYOUT EXECUTION IS NOT HERE. This table says what accrued; nothing in this
// iteration moves money. Circle settles every sale to the single seller address
// (MURMUR_NANOPAY_SELLER_ADDRESS) because the rail pays one recipient; paying
// providers out of that balance is a manual operator duty, exactly like refunds.

export type ProviderEarningAccrualSource = "sale_snapshot" | "legacy_fallback";

export interface ProviderEarningRow {
  entitlement_id: number;
  producer_agent_id: string;
  chain_id: number;
  contract_address: string;
  onchain_call_id: string;
  /** What the subscriber paid, in the settlement asset's atomic units. */
  gross_atoms: string;
  /** The split this sale was recorded under, in basis points. */
  fee_bps: number;
  /** Murmur's cut. */
  fee_atoms: string;
  /** The provider's share. Always exactly gross - fee. */
  net_atoms: string;
  currency: string;
  accrual_source: ProviderEarningAccrualSource;
  accrued_at: string;
}

export interface ProviderEarningInsert extends ProviderEarningRow {}

export interface ProviderEarningsCurrencyTotal {
  currency: string;
  sales: number;
  gross_atoms: string;
  fee_atoms: string;
  net_atoms: string;
}

const COLUMNS = `entitlement_id, producer_agent_id, chain_id, contract_address,
       onchain_call_id, gross_atoms, fee_bps, fee_atoms, net_atoms, currency,
       accrual_source, accrued_at`;

const ENTITLEMENT_COLUMNS = `e.id, e.chain_id, e.contract_address, e.call_id,
       e.onchain_call_id, e.subscriber_address, e.producer_agent_id,
       e.nanopay_receipt_id, e.amount, e.currency, e.fee_bps_at_sale, e.status,
       e.grant_tx_hash, e.grant_block_number, e.grant_attempts, e.last_error,
       e.refund_status, e.next_attempt_at, e.granted_at, e.created_at,
       e.updated_at`;

export const providerEarningsRepo = {
  /**
   * Record an accrual. Returns true iff this call created the row.
   *
   * ON CONFLICT(entitlement_id) DO NOTHING — targeted at the one collision that
   * is legitimate (the same sale accrued twice by two convergent writers).
   * Deliberately NOT `INSERT OR IGNORE`, which also swallows every CHECK and
   * NOT NULL violation: a malformed amount or a missing producer would then
   * vanish silently instead of failing where it can be seen.
   */
  insert(db: Database.Database, input: ProviderEarningInsert): boolean {
    const result = prep(
      db,
      `INSERT INTO provider_earnings (${COLUMNS})
       VALUES (@entitlement_id, @producer_agent_id, @chain_id, @contract_address,
               @onchain_call_id, @gross_atoms, @fee_bps, @fee_atoms, @net_atoms,
               @currency, @accrual_source, @accrued_at)
       ON CONFLICT(entitlement_id) DO NOTHING`,
    ).run({
      ...input,
      contract_address: input.contract_address.toLowerCase(),
      onchain_call_id: input.onchain_call_id.toLowerCase(),
      // Normalized at write so per-currency totals cannot split into "USDC"
      // and "usdc" buckets that each look complete.
      currency: input.currency.toUpperCase(),
    });
    return result.changes > 0;
  },

  byEntitlement(
    db: Database.Database,
    entitlementId: number,
  ): ProviderEarningRow | null {
    return (
      (prep(
        db,
        `SELECT ${COLUMNS} FROM provider_earnings WHERE entitlement_id = ?`,
      ).get(entitlementId) as ProviderEarningRow | undefined) ?? null
    );
  },

  /** One provider's accruals, newest first. */
  listForAgent(
    db: Database.Database,
    input: { producerAgentId: string; limit: number; offset?: number },
  ): ProviderEarningRow[] {
    return prep(
      db,
      `SELECT ${COLUMNS} FROM provider_earnings
       WHERE producer_agent_id = @producer_agent_id
       ORDER BY accrued_at DESC, entitlement_id DESC
       LIMIT @limit OFFSET @offset`,
    ).all({
      producer_agent_id: input.producerAgentId,
      limit: input.limit,
      offset: input.offset ?? 0,
    }) as ProviderEarningRow[];
  },

  /**
   * Lifetime totals per currency, summed in BigInt IN JS.
   *
   * Never SUM()/CAST() these columns in SQLite. Atomic amounts routinely exceed
   * 2^53, CAST(... AS INTEGER) on a TEXT column silently truncates at the first
   * non-digit, and SUM over a large enough set goes through a float. A total
   * that is quietly wrong is worse than no total at all.
   */
  totalsForAgent(
    db: Database.Database,
    producerAgentId: string,
  ): ProviderEarningsCurrencyTotal[] {
    const rows = prep(
      db,
      `SELECT currency, gross_atoms, fee_atoms, net_atoms
       FROM provider_earnings
       WHERE producer_agent_id = ?`,
    ).all(producerAgentId) as Array<{
      currency: string;
      gross_atoms: string;
      fee_atoms: string;
      net_atoms: string;
    }>;
    const totals = new Map<
      string,
      { sales: number; gross: bigint; fee: bigint; net: bigint }
    >();
    for (const row of rows) {
      const key = row.currency.toUpperCase();
      const acc = totals.get(key) ?? { sales: 0, gross: 0n, fee: 0n, net: 0n };
      acc.sales += 1;
      acc.gross += BigInt(row.gross_atoms);
      acc.fee += BigInt(row.fee_atoms);
      acc.net += BigInt(row.net_atoms);
      totals.set(key, acc);
    }
    return [...totals.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([currency, acc]) => ({
        currency,
        sales: acc.sales,
        gross_atoms: acc.gross.toString(),
        fee_atoms: acc.fee.toString(),
        net_atoms: acc.net.toString(),
      }));
  },

  /**
   * The repair queue behind the ledger's one invariant: a paid, granted
   * entitlement has exactly one earnings row.
   *
   * `granted` is terminal and excluded from the reconciler's `listDue`, so a
   * row that reached it without accruing — a receipt attached after another
   * writer had already granted it, a crash in an older build — would never be
   * revisited. This query is what makes the invariant self-healing rather than
   * aspirational.
   *
   * NOT scoped to one chain/contract. Accrual is local bookkeeping that never
   * touches a chain, and scoping it would strand the ledger of a contract that
   * has since been redeployed.
   */
  listAccruableEntitlements(
    db: Database.Database,
    input: { limit: number },
  ): EntitlementRow[] {
    return prep(
      db,
      `SELECT ${ENTITLEMENT_COLUMNS}
       FROM entitlements e
       LEFT JOIN provider_earnings pe ON pe.entitlement_id = e.id
       WHERE e.status = 'granted'
         AND e.nanopay_receipt_id IS NOT NULL
         AND e.amount IS NOT NULL
         AND pe.entitlement_id IS NULL
       ORDER BY e.updated_at, e.id
       LIMIT @limit`,
    ).all({ limit: input.limit }) as EntitlementRow[];
  },
} as const;
