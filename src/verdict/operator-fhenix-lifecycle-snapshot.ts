import type Database from "better-sqlite3";

import {
  type FhenixRevealStatus,
} from "./repos/fhenix-sealed-calls-repo.js";
import { fhenixLifecycleReadRepo } from "./repos/fhenix-lifecycle-read-repo.js";
import { isoFromMs, nowIso } from "./time.js";

export function fhenixLifecycleSnapshot(
  db: Database.Database,
  opts: {
    servedAt: Date;
    verifier_configured: boolean;
    status?: FhenixRevealStatus;
    limit: number;
    graceSeconds: number;
  },
) {
  const servedAt = nowIso(opts.servedAt);
  const graceCutoff = isoFromMs(opts.servedAt.getTime() - opts.graceSeconds * 1_000);
  const counts = fhenixLifecycleReadRepo.statusCounts(db);
  const cursors = fhenixLifecycleReadRepo.cursors(db);
  const pendingNotOpen = fhenixLifecycleReadRepo.pendingNotOpenCount(db, servedAt);
  const openPending = fhenixLifecycleReadRepo.openPendingCount(db, servedAt);
  const overdueGrace = fhenixLifecycleReadRepo.overdueGraceCount(db, graceCutoff);
  const invalid = counts.invalid ?? 0;
  const missed = counts.missed ?? 0;
  const needsAttention = overdueGrace + invalid + missed;
  return {
    served_at: servedAt,
    configured: {
      verifier: opts.verifier_configured,
      watcher: cursors.length > 0,
      reveal_grace_seconds: opts.graceSeconds,
    },
    counts,
    queues: {
      pending_not_open: pendingNotOpen,
      open_pending: openPending,
      overdue_grace: overdueGrace,
      terminal_failures: invalid + missed,
      needs_attention: needsAttention,
      grace_cutoff: graceCutoff,
    },
    cursors,
    event_counts: fhenixLifecycleReadRepo.eventCounts(db),
    needs_attention: fhenixLifecycleRows(db, {
      limit: opts.limit,
      graceCutoff,
      attentionOnly: true,
    }),
    recent: fhenixLifecycleRows(db, {
      limit: opts.limit,
      status: opts.status,
      graceCutoff,
    }),
  };
}

function fhenixLifecycleRows(
  db: Database.Database,
  opts: {
    limit: number;
    graceCutoff: string;
    status?: FhenixRevealStatus;
    attentionOnly?: boolean;
  },
) {
  const rows = fhenixLifecycleReadRepo.rows(db, opts);
  return rows.map((row) => ({
    call_id: row.call_id,
    chain_id: row.chain_id,
    contract_address: row.contract_address,
    onchain_call_id: row.onchain_call_id,
    reveal_status: row.reveal_status,
    reveal_open_at: row.reveal_open_at,
    revealed_at: row.revealed_at,
    terminal_at: row.terminal_at,
    invalid_reason: row.invalid_reason,
    reveal_tx_hash: row.reveal_tx_hash,
    reveal_block_number: row.reveal_block_number,
    agent_id: row.agent_id,
    agent_slug: row.agent_slug,
    market_id: row.market_id,
    submission_status: row.submission_status,
    resolution: row.resolution_outcome
      ? {
          outcome: row.resolution_outcome,
          call_score: row.call_score,
          resolved_at: row.resolved_at,
        }
      : null,
    overdue_grace:
      row.reveal_status === "pending" && row.reveal_open_at <= opts.graceCutoff,
  }));
}
