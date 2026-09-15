import type Database from "better-sqlite3";
import type { FhenixRevealStatus } from "./fhenix-sealed-calls-repo.js";

const FHENIX_REVEAL_STATUSES: readonly FhenixRevealStatus[] = [
  "pending",
  "revealed",
  "invalid",
  "missed",
];

export interface FhenixLifecycleRow {
  call_id: string;
  chain_id: number;
  contract_address: string;
  onchain_call_id: string;
  reveal_status: FhenixRevealStatus;
  reveal_open_at: string;
  revealed_at: string | null;
  terminal_at: string | null;
  invalid_reason: string | null;
  reveal_tx_hash: string | null;
  reveal_block_number: number | null;
  agent_id: string;
  agent_slug: string | null;
  market_id: string | null;
  submission_status: string;
  resolution_outcome: string | null;
  call_score: number | null;
  resolved_at: string | null;
}

export interface FhenixLifecycleCursorRow {
  chain_id: number;
  contract_address: string;
  event_name: string;
  last_block_number: number;
  updated_at: string;
}

/** Binding-tuple columns returned by latestSealedCallForPipeline. */
export interface LatestSealedCallForPipelineRow {
  chain_id: number;
  contract_address: string;
  onchain_call_id: string;
  submit_tx_hash: string;
  submit_log_index: number;
  binary_index_ct_hash: string;
  confidence_ct_hash: string;
  reveal_open_at: string;
  market_id: string;
  commit_hash: string;
  commit_scheme: string;
}

export const fhenixLifecycleReadRepo = {
  statusCounts(db: Database.Database): Record<FhenixRevealStatus, number> {
    const counts = Object.fromEntries(
      FHENIX_REVEAL_STATUSES.map((status) => [status, 0]),
    ) as Record<FhenixRevealStatus, number>;
    const rows = db
      .prepare(
        `SELECT reveal_status AS status, COUNT(*) AS count
         FROM fhenix_sealed_calls
         GROUP BY reveal_status`,
      )
      .all() as Array<{ status: FhenixRevealStatus; count: number }>;
    for (const row of rows) counts[row.status] = row.count;
    return counts;
  },

  pendingNotOpenCount(db: Database.Database, servedAt: string): number {
    return scalarCount(
      db,
      `SELECT COUNT(*) AS count
       FROM fhenix_sealed_calls
       WHERE reveal_status = 'pending'
         AND reveal_open_at > ?`,
      [servedAt],
    );
  },

  openPendingCount(db: Database.Database, servedAt: string): number {
    return scalarCount(
      db,
      `SELECT COUNT(*) AS count
       FROM fhenix_sealed_calls
       WHERE reveal_status = 'pending'
         AND reveal_open_at <= ?`,
      [servedAt],
    );
  },

  overdueGraceCount(db: Database.Database, graceCutoff: string): number {
    return scalarCount(
      db,
      `SELECT COUNT(*) AS count
       FROM fhenix_sealed_calls
       WHERE reveal_status = 'pending'
         AND reveal_open_at <= ?`,
      [graceCutoff],
    );
  },

  cursors(db: Database.Database): FhenixLifecycleCursorRow[] {
    return db
      .prepare(
        `SELECT chain_id, contract_address, event_name, last_block_number, updated_at
         FROM fhenix_event_cursors
         ORDER BY chain_id, contract_address, event_name`,
      )
      .all() as FhenixLifecycleCursorRow[];
  },

  eventCounts(db: Database.Database): Record<string, number> {
    const rows = db
      .prepare(
        `SELECT event_name, COUNT(*) AS count
         FROM fhenix_events
         GROUP BY event_name
         ORDER BY event_name`,
      )
      .all() as Array<{ event_name: string; count: number }>;
    return Object.fromEntries(rows.map((row) => [row.event_name, row.count]));
  },

  /**
   * Latest servable sealed call for an (agent, market), for the Nanopayments resolver.
   * Needs commit_hash and commit_scheme (the binding uses both) and a pending or revealed
   * status: invalid/missed calls never resolve, so a buyer must not pay for them.
   * Newest created_at first; call_id breaks ties. Null if none.
   */
  latestSealedCallForPipeline(
    db: Database.Database,
    key: { agentId: string; marketId: string },
  ): LatestSealedCallForPipelineRow | null {
    const row = db
      .prepare(
        `SELECT
           f.chain_id,
           f.contract_address,
           f.onchain_call_id,
           f.submit_tx_hash,
           f.submit_log_index,
           f.binary_index_ct_hash,
           f.confidence_ct_hash,
           f.reveal_open_at,
           s.market_id,
           s.commit_hash,
           s.commit_scheme
         FROM fhenix_sealed_calls f
         JOIN submissions s ON s.call_id = f.call_id
         WHERE s.agent_id = ?
           AND s.market_id = ?
           AND s.commit_hash IS NOT NULL
           AND s.commit_scheme IS NOT NULL
           AND f.reveal_status IN ('pending','revealed')
         ORDER BY f.created_at DESC, f.call_id DESC
         LIMIT 1`,
      )
      .get(key.agentId, key.marketId) as LatestSealedCallForPipelineRow | undefined;
    return row ?? null;
  },

  rows(
    db: Database.Database,
    opts: {
      limit: number;
      graceCutoff: string;
      status?: FhenixRevealStatus;
      attentionOnly?: boolean;
    },
  ): FhenixLifecycleRow[] {
    const baseSql = `
      SELECT
        f.call_id,
        f.chain_id,
        f.contract_address,
        f.onchain_call_id,
        f.reveal_status,
        f.reveal_open_at,
        f.revealed_at,
        f.terminal_at,
        f.invalid_reason,
        f.reveal_tx_hash,
        f.reveal_block_number,
        s.agent_id,
        a.display_slug AS agent_slug,
        s.market_id,
        s.status AS submission_status,
        r.outcome AS resolution_outcome,
        r.call_score,
        r.resolved_at
      FROM fhenix_sealed_calls f
      JOIN submissions s ON s.call_id = f.call_id
      LEFT JOIN agents a ON a.agent_id = s.agent_id
      LEFT JOIN t1_resolutions r ON r.call_id = f.call_id`;
    const orderSql = `
      ORDER BY
        COALESCE(f.terminal_at, f.revealed_at, f.reveal_open_at) DESC,
        f.call_id DESC
      LIMIT ?`;
    if (opts.attentionOnly) {
      return db
        .prepare(
          `${baseSql}
           WHERE (
             (f.reveal_status = 'pending' AND f.reveal_open_at <= ?)
             OR f.reveal_status IN ('invalid','missed')
           )
           ${orderSql}`,
        )
        .all(opts.graceCutoff, opts.limit) as FhenixLifecycleRow[];
    }
    if (opts.status) {
      return db
        .prepare(`${baseSql} WHERE f.reveal_status = ? ${orderSql}`)
        .all(opts.status, opts.limit) as FhenixLifecycleRow[];
    }
    return db
      .prepare(`${baseSql} ${orderSql}`)
      .all(opts.limit) as FhenixLifecycleRow[];
  },
};

function scalarCount(
  db: Database.Database,
  sql: string,
  params: unknown[],
): number {
  const row = db.prepare(sql).get(...params) as { count: number } | undefined;
  return row?.count ?? 0;
}
