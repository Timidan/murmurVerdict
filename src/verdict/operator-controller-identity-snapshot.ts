import type Database from "better-sqlite3";

import { controllerWalletReattestationHealth } from "./auth/controller-wallets.js";
import { isoFromMs, nowIso } from "./time.js";

export function controllerIdentitySnapshot(
  db: Database.Database,
  opts: {
    servedAt: Date;
    limit: number;
    dueSoonHours: number;
  },
) {
  const servedAt = nowIso(opts.servedAt);
  const dueSoonAt = isoFromMs(
    opts.servedAt.getTime() + opts.dueSoonHours * 60 * 60 * 1_000,
  );
  const healthSummary = controllerIdentityHealthSummary(db, {
    checkedAt: opts.servedAt,
    dueSoonAt,
  });
  const activeRuntimeKeys = scalarCount(
    db,
    `SELECT COUNT(*) AS count
     FROM agent_runtime_keys
     WHERE revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > ?)`,
    [servedAt],
  );
  const rows = controllerIdentityRows(db, {
    limit: opts.limit,
    checkedAt: opts.servedAt,
    servedAt,
    dueSoonAt,
  });
  return {
    served_at: servedAt,
    due_soon_at: dueSoonAt,
    counts: {
      controller_wallets: healthSummary.total,
      overdue: healthSummary.overdue,
      due_soon: healthSummary.dueSoon,
      active_runtime_keys: activeRuntimeKeys,
      needs_attention: healthSummary.overdue + healthSummary.dueSoon,
    },
    needs_attention: rows.filter((row) => row.status !== "current"),
    rows,
  };
}

function scalarCount(
  db: Database.Database,
  sql: string,
  params: unknown[],
): number {
  const row = db.prepare(sql).get(...params) as { count: number } | undefined;
  return row?.count ?? 0;
}

function controllerIdentityHealthSummary(
  db: Database.Database,
  opts: {
    checkedAt: Date;
    dueSoonAt: string;
  },
): {
  total: number;
  overdue: number;
  dueSoon: number;
} {
  const rows = db
    .prepare(
      `SELECT created_at, last_attested_at, reattestation_due_at
       FROM agent_controller_wallets`,
    )
    .all() as ControllerIdentityAttestationRow[];
  let overdue = 0;
  let dueSoon = 0;
  for (const row of rows) {
    const health = controllerWalletReattestationHealth(row, opts);
    if (health.status === "overdue") overdue += 1;
    if (health.status === "due_soon") dueSoon += 1;
  }
  return {
    total: rows.length,
    overdue,
    dueSoon,
  };
}

function controllerIdentityRows(
  db: Database.Database,
  opts: {
    limit: number;
    checkedAt: Date;
    servedAt: string;
    dueSoonAt: string;
  },
) {
  const rows = db
    .prepare(
      `SELECT
        c.agent_id,
        c.account_id,
        a.display_slug AS agent_slug,
        c.wallet_address,
        c.chain_id,
        c.wallet_kind,
        c.provider,
        c.created_at,
        c.last_attested_at,
        c.reattestation_due_at,
        (
          SELECT COUNT(*) FROM agent_runtime_keys k
          WHERE k.agent_id = c.agent_id
        ) AS total_runtime_keys,
        (
          SELECT COUNT(*) FROM agent_runtime_keys k
          WHERE k.agent_id = c.agent_id
            AND k.revoked_at IS NULL
            AND (k.expires_at IS NULL OR k.expires_at > @served_at)
        ) AS active_runtime_keys,
        (
          SELECT COUNT(*) FROM agent_runtime_keys k
          WHERE k.agent_id = c.agent_id
            AND k.revoked_at IS NOT NULL
        ) AS revoked_runtime_keys,
        (
          SELECT MAX(k.created_at) FROM agent_runtime_keys k
          WHERE k.agent_id = c.agent_id
        ) AS last_runtime_key_created_at
       FROM agent_controller_wallets c
       LEFT JOIN agents a ON a.agent_id = c.agent_id
       ORDER BY
         CASE WHEN c.reattestation_due_at IS NULL THEN 0 ELSE 1 END,
         c.reattestation_due_at ASC,
         c.created_at DESC
       LIMIT @limit`,
    )
    .all({ served_at: opts.servedAt, limit: opts.limit }) as ControllerIdentityRow[];
  return rows.map((row) => {
    const health = controllerWalletReattestationHealth(row, opts);
    return {
      ...row,
      last_attested_at: health.last_attested_at,
      reattestation_due_at: health.reattestation_due_at,
      status: health.status,
      reattestation_overdue: health.reattestation_overdue,
      reattestation_due_soon: health.reattestation_due_soon,
    };
  });
}

interface ControllerIdentityAttestationRow {
  created_at: string;
  last_attested_at: string | null;
  reattestation_due_at: string | null;
}

interface ControllerIdentityRow extends ControllerIdentityAttestationRow {
  agent_id: string;
  account_id: string;
  agent_slug: string | null;
  wallet_address: string;
  chain_id: string;
  wallet_kind: string;
  provider: string | null;
  total_runtime_keys: number;
  active_runtime_keys: number;
  revoked_runtime_keys: number;
  last_runtime_key_created_at: string | null;
}
