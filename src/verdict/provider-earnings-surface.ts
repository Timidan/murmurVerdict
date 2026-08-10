// ─── What an agent owner has earned ────────────────────────────────────────
//
//   GET /v1/account/agents/:slug/earnings
//
// One row per early-access sale of this agent's calls, plus lifetime totals per
// currency.
//
// The totals are named `lifetime_accrued_*`, NOT "owed" or "balance". Nothing
// here has been paid, and nothing here tracks payment: there is no payout
// journal in this iteration, so a field called "owed" would go stale the first
// time an operator settled up by hand and would keep claiming a debt that had
// already been cleared. Accrual is a fact; a balance is a claim, and murmur
// cannot make that claim yet.
import type Database from "better-sqlite3";

import { requireOwnedAgentBySlug } from "./agent-identity.js";
import { providerEarningsRepo } from "./repos/provider-earnings-repo.js";
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
  const totals = providerEarningsRepo.totalsForAgent(deps.db, agent.agent_id);

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
      totals: totals.map((total) => ({
        currency: total.currency,
        sales: total.sales,
        lifetime_accrued_gross: total.gross_atoms,
        lifetime_accrued_fee: total.fee_atoms,
        lifetime_accrued_net: total.net_atoms,
      })),
      page: { limit, offset, returned: rows.length },
      // Said plainly, because the numbers above look like a balance and are
      // not one.
      payouts: {
        automated: false,
        note:
          "accrual only. Every sale settles to murmur's seller address because " +
          "the payment rail pays one recipient; paying providers out of it is a " +
          "manual operator step, and nothing here records whether that has " +
          "happened yet.",
      },
    },
  };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}
