// ─── Settled payments owed a refund ────────────────────────────────────────
//
//   GET /v1/admin/entitlements/refunds
//
// No refund worker exists; this exposes entitlementsRepo.listRefundDue to the operator over the admin token.
// The body carries a machine-readable warning because a row can appear and then legitimately vanish.
import type Database from "better-sqlite3";

import { entitlementsRepo } from "./repos/entitlements-repo.js";
import { SCHEMA_VERSION } from "./schema.js";

export interface EntitlementRefundsResponse {
  status: number;
  body: unknown;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/** The refund queue, oldest first. `nanopay_receipt_id`, not this list, is the authority on whether money moved. */
export function listRefundDueResponse(
  db: Database.Database,
  input: { limit?: number } = {},
): EntitlementRefundsResponse {
  const limit = clamp(input.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT);
  const rows = entitlementsRepo.listRefundDue(db, { limit });
  return {
    status: 200,
    body: {
      schema_version: SCHEMA_VERSION,
      refunds: rows.map((row) => ({
        entitlement_id: row.id,
        chain_id: row.chain_id,
        contract_address: row.contract_address,
        onchain_call_id: row.onchain_call_id,
        subscriber_address: row.subscriber_address,
        nanopay_receipt_id: row.nanopay_receipt_id,
        amount: row.amount,
        currency: row.currency,
        status: row.status,
        refund_status: row.refund_status,
        last_error: row.last_error,
        grant_attempts: row.grant_attempts,
        created_at: row.created_at,
        updated_at: row.updated_at,
      })),
      page: { limit, returned: rows.length },
      warning: {
        code: "refund_rows_are_not_a_payment_authorization",
        automated: false,
        message:
          "This is a snapshot, not an instruction. Re-read each entitlement " +
          "INSIDE the transaction that issues the refund, and require a " +
          "non-null nanopay_receipt_id before paying anything out. A row can " +
          "appear here and then legitimately vanish: a settle that stayed " +
          "pending past the unknown-resolution budget is terminalized as " +
          "refund_due, and a definitive rejection arriving afterwards deletes " +
          "it because no money ever moved.",
      },
    },
  };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}
