// ─── What an agent owner has earned, and what is still owed ────────────────
//
//   GET /v1/account/agents/:slug/earnings
//
// One row per early-access sale of this agent's calls, plus per-currency
// totals that now close the loop: accrued (provider_earnings, migration 071)
// MINUS paid (provider_payouts, migration 073) is a balance.
//
// Until 073 there was no payout journal, so this surface could only report
// `lifetime_accrued_*` — a field called "owed" would have gone stale the first
// time an operator settled up by hand and would have kept claiming a debt
// already cleared. That is no longer true: settling up writes a journal entry,
// so the balance below is derived from records on both sides rather than from
// anyone's memory.
//
// The balance is SIGNED and reported as such. A negative balance means murmur
// paid out more than accrued — a double-send, a reversal that never landed, a
// mistyped amount — and it is surfaced as `overpaid_atoms` rather than floored
// at zero, because silently clamping it would render an operator error
// invisible in exactly the view meant to catch it.
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
        // Still true, and still worth saying: nothing here moves money. What
        // changed is that murmur now records the operator's transfer, so the
        // balance above is checkable instead of assumed.
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

/**
 * Per-currency merge over the UNION of both sides.
 *
 * An intersection (or a left join from accruals) would drop the two cases that
 * matter most: a currency that has been paid out but has no accruals left in
 * range, and a currency an operator paid in that never accrued at all. Both
 * are exactly the rows an owner needs to see.
 *
 * Every sum arrives already computed in BigInt from its repo; this function
 * only subtracts, and does that in BigInt too. No amount ever passes through a
 * JS number.
 */
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
