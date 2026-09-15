import type Database from "better-sqlite3";

import { prep } from "../db-statements.js";
import type { EntitlementRow } from "./entitlements-repo.js";

// ─── provider_earnings — what each sale owes the agent's owner ──────────────
// One row per paid, granted entitlement, keyed by its id so a double accrual adds nothing.
// Append-only financial history: no update or delete; corrections are compensating records.
// Moves no money: Circle settles to one seller address; paying providers is a manual operator duty.

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
   * Record an accrual; true iff this call created the row. ON CONFLICT(entitlement_id) only,
   * not INSERT OR IGNORE, which would also swallow CHECK and NOT NULL failures.
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
   * Lifetime totals per currency, summed as BigInt in JS. Never SUM()/CAST() these in SQLite:
   * atomic amounts exceed 2^53, and CAST truncates while SUM goes through a float.
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
   * Repair queue for the invariant: a paid, granted entitlement has exactly one earnings row.
   * `granted` is outside listDue, so this is what heals a missed accrual. Not scoped to one
   * chain/contract, so a redeployed contract's ledger is not stranded.
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
