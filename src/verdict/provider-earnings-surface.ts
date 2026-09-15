// ─── What an agent owner has earned, and what is still owed ────────────────
//
//   GET /v1/account/agents/:slug/earnings
//
// One row per sale, plus per-currency totals: accrued (provider_earnings) minus paid (provider_payouts).
// The balance is signed; a negative one shows as `overpaid_atoms` rather than being clamped to zero.
import type Database from "better-sqlite3";

import { requireOwnedAgentBySlug } from "./agent-identity.js";
import { providerEarningsRepo } from "./repos/provider-earnings-repo.js";
import { providerPayoutsRepo } from "./repos/provider-payouts-repo.js";
import { SCHEMA_VERSION } from "./schema.js";

export interface ProviderEarningsResponse {
  status: number;
  body: unknown;
}

export interface ProviderEarningsSurfaceDeps {
  db: Database.Database;
  accountId: string;
  slug: string;
  /** Page size. Clamped to a sane ceiling; defaults to 100. */
  limit?: number;
  offset?: number;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

export interface ProviderEarningsCurrencyBalance {
  currency: string;
  sales: number;
  lifetime_accrued_gross: string;
  lifetime_accrued_fee: string;
  lifetime_accrued_net: string;
  payout_entries: number;
  lifetime_paid_gross: string;
  lifetime_paid_reversed: string;
  /** Payouts minus reversals. May be negative after a large clawback. */
  lifetime_paid_net: string;
  /** accrued_net - paid_net. SIGNED. */
  balance_atoms: string;
  /** The positive part of the balance: what the provider is still owed. */
  owed_atoms: string;
  /** The negative part, stated as a positive number. Usually "0". */
  overpaid_atoms: string;
}

export function readProviderEarnings(
  deps: ProviderEarningsSurfaceDeps,
): ProviderEarningsResponse {
  const agent = requireOwnedAgentBySlug(deps.db, deps.accountId, deps.slug);
  const limit = clamp(deps.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT);
  const offset = Math.max(0, Math.floor(deps.offset ?? 0));

  const rows = providerEarningsRepo.listForAgent(deps.db, {
    producerAgentId: agent.agent_id,
    limit,
    offset,
  });
  const accrued = providerEarningsRepo.totalsForAgent(deps.db, agent.agent_id);
  const paid = providerPayoutsRepo.totalsForAgent(deps.db, agent.agent_id);

  return {
    status: 200,
    body: {
      schema_version: SCHEMA_VERSION,
      agent_slug: agent.display_slug,
      sales: rows.map((row) => ({
        entitlement_id: row.entitlement_id,
        onchain_call_id: row.onchain_call_id,
        chain_id: row.chain_id,
        contract_address: row.contract_address,
        gross_atoms: row.gross_atoms,
        fee_atoms: row.fee_atoms,
        net_atoms: row.net_atoms,
        fee_bps: row.fee_bps,
        currency: row.currency,
        // 'sale_snapshot'  — the split this sale actually froze
        // 'legacy_fallback' — a sale predating the ledger, accrued at the fee
        //                     as it stood when it was repaired
        accrual_source: row.accrual_source,
        accrued_at: row.accrued_at,
      })),
      totals: mergeTotals(accrued, paid),
      page: { limit, offset, returned: rows.length },
      payouts: {
        // Nothing here moves money; the operator's transfer is only recorded.
        automated: false,
        note:
          "Every sale settles to murmur's seller address, because the payment " +
          "rail pays one recipient. An operator sends your share by hand and " +
          "records it here. The balance is what accrued, less what was recorded " +
          "as paid.",
      },
    },
  };
}

/** Per-currency merge over the union of both sides, so paid-only currencies still show. BigInt throughout. */
export function mergeTotals(
  accrued: ReturnType<typeof providerEarningsRepo.totalsForAgent>,
  paid: ReturnType<typeof providerPayoutsRepo.totalsForAgent>,
): ProviderEarningsCurrencyBalance[] {
  const currencies = new Set<string>();
  for (const row of accrued) currencies.add(row.currency.toUpperCase());
  for (const row of paid) currencies.add(row.currency.toUpperCase());

  const accruedBy = new Map(accrued.map((r) => [r.currency.toUpperCase(), r]));
  const paidBy = new Map(paid.map((r) => [r.currency.toUpperCase(), r]));

  return [...currencies]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((currency) => {
      const a = accruedBy.get(currency);
      const p = paidBy.get(currency);
      const accruedNet = BigInt(a?.net_atoms ?? "0");
      const paidNet = BigInt(p?.net_paid_atoms ?? "0");
      const balance = accruedNet - paidNet;
      return {
        currency,
        sales: a?.sales ?? 0,
        lifetime_accrued_gross: a?.gross_atoms ?? "0",
        lifetime_accrued_fee: a?.fee_atoms ?? "0",
        lifetime_accrued_net: a?.net_atoms ?? "0",
        payout_entries: p?.entries ?? 0,
        lifetime_paid_gross: p?.paid_atoms ?? "0",
        lifetime_paid_reversed: p?.reversed_atoms ?? "0",
        lifetime_paid_net: paidNet.toString(),
        balance_atoms: balance.toString(),
        owed_atoms: (balance > 0n ? balance : 0n).toString(),
        overpaid_atoms: (balance < 0n ? -balance : 0n).toString(),
      };
    });
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}
