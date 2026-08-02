// ─── Account activity history ────────────────────────────────────────────────
//
// Account-scoped union of the two gateway attempt tables, joined to
// runtime-key metadata: what each agent credential DID, when, and with what
// outcome. This is deliberately named activity history, not audit — attempt
// rows are mutable lifecycle state (status/tx_hash advance), unlike the
// append-only agent_security_events stream. Rows carry an immutable
// account_id stamped at reservation, so historical activity can't be
// misattributed when agent ownership later changes.
//
// Keyset pagination on (created_at, attempt_id) — LIMIT/OFFSET would skip or
// repeat rows as new attempts land between pages.

import type Database from "better-sqlite3";

export interface AccountActivityRow {
  attempt_id: string;
  kind: "sealed_call" | "feed_packet";
  agent_id: string;
  agent_slug: string | null;
  market_id: string | null;
  feed_id: string | null;
  status: string;
  runtime_key_id: string | null;
  runtime_key_prefix: string | null;
  runtime_key_label: string | null;
  auth_proof: string | null;
  tx_hash: string | null;
  call_id: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

const ACTIVITY_UNION_SQL = `
  SELECT * FROM (
    SELECT
      t.attempt_id, 'sealed_call' AS kind, t.agent_id, a.display_slug AS agent_slug,
      t.market_id, NULL AS feed_id, t.status, t.runtime_key_id,
      rk.runtime_key_prefix, rk.label AS runtime_key_label,
      t.auth_proof, t.tx_hash, t.call_id, t.last_error, t.created_at, t.updated_at
    FROM fhenix_gateway_tx_attempts t
    LEFT JOIN agent_runtime_keys rk ON rk.runtime_key_id = t.runtime_key_id
    LEFT JOIN agents a ON a.agent_id = t.agent_id
    WHERE t.account_id = @account_id
    UNION ALL
    SELECT
      t.attempt_id, 'feed_packet' AS kind, t.agent_id, a.display_slug AS agent_slug,
      t.market_id, t.feed_id, t.status, t.runtime_key_id,
      rk.runtime_key_prefix, rk.label AS runtime_key_label,
      t.auth_proof, t.tx_hash, NULL AS call_id, t.last_error, t.created_at, t.updated_at
    FROM fhenix_gateway_feed_packet_tx_attempts t
    LEFT JOIN agent_runtime_keys rk ON rk.runtime_key_id = t.runtime_key_id
    LEFT JOIN agents a ON a.agent_id = t.agent_id
    WHERE t.account_id = @account_id
  )
  WHERE (
    @before IS NULL
    OR created_at < @before
    OR (created_at = @before AND attempt_id < @before_id)
  )
  ORDER BY created_at DESC, attempt_id DESC
  LIMIT @limit
`;

export function listAccountActivityResponse(input: {
  db: Database.Database;
  accountId: string;
  limit?: number;
  before?: string | null;
  before_id?: string | null;
}): {
  status: 200;
  body: {
    activity: AccountActivityRow[];
    next: { before: string; before_id: string } | null;
  };
} {
  const limit = Math.min(Math.max(Math.floor(input.limit ?? 50), 1), 200);
  const rows = input.db.prepare(ACTIVITY_UNION_SQL).all({
    account_id: input.accountId,
    before: input.before ?? null,
    // A before timestamp without its id half degrades to strict created_at <
    // comparison; '' never ties with a real uuid so no row is skipped.
    before_id: input.before_id ?? "",
    limit,
  }) as AccountActivityRow[];
  const last = rows.length === limit ? rows[rows.length - 1] : undefined;
  return {
    status: 200,
    body: {
      activity: rows,
      next: last ? { before: last.created_at, before_id: last.attempt_id } : null,
    },
  };
}
