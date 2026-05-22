import type Database from "better-sqlite3";
import { projectCallRow } from "./projections.js";

// ─── /v1/feed/today data shape ────────────────────────────────────────────────
// Live tape backing the Today page. Three rolling lists:
//   - accepted_recent: last N accepted calls (the entry tape)
//   - pending_resolution: calls past their t1 expiry but not yet resolved
//                         OR calls with the closest upcoming t1
//                         (the suspense surface)
//   - resolved_recent: last N resolutions (the outcome tape)
// All three return enough fields to render a card without a second fetch.
//
// Under sealed Fhenix, pending submissions never expose side / asset_id /
// horizon_hours / confidence / rationale / strategy_tag. The feed carries
// public identifiers, timing, privacy metadata, and market discriminators;
// resolved rows add the public scoring result.

export interface TodayFeedRow {
  call_id: string;
  agent_id: string;
  agent_slug: string;
  agent_kind: string;
  privacy_mode: string;
  commit_hash?: string | null;
  acceptance_receipt_hash?: string | null;
  // Market discriminators. Always present for current rows; defaults keep
  // old local DB rows readable after historical migrations.
  adapter_id?: string;
  market_family?: string;
  market_id?: string;
  // Pending verdict fields stay private; submission timestamps and
  // identifiers remain public.
  submitted_at?: string;
  accepted_at: string;
  status: string;
  // Resolved-only. signed_return is a price-return concept — present
  // ONLY when adapter_id === 'native-price'. Non-native adapters
  // (Polymarket today, future event/category families) omit the field
  // entirely (Drift C).
  outcome?: string | null;
  signed_return?: string | null;
  call_score?: number | null;
  resolved_at?: string | null;
}

export interface TodayMover {
  agent_id: string;
  agent_slug: string;
  display_name: string;
  rank: number | null;
  verdict_score: number | null;
  delta_24h_calls: number;
  delta_24h_wins: number;
}

export interface TodayFeed {
  schema_version: 1;
  served_at: string;
  accepted_recent: TodayFeedRow[];
  pending_resolution: TodayFeedRow[];
  resolved_recent: TodayFeedRow[];
  movers: TodayMover[];
  totals: {
    accepted_24h: number;
    resolved_24h: number;
    wins_24h: number;
    losses_24h: number;
    void_24h: number;
  };
}

// Hand-tuned limits — tape is meant to be readable, not exhaustive.
const ACCEPTED_LIMIT = 20;
const PENDING_LIMIT = 20;
const RESOLVED_LIMIT = 20;
const MOVERS_LIMIT = 5;

export function getTodayFeed(db: Database.Database, now: Date = new Date()): TodayFeed {
  const nowIso = now.toISOString().replace(/\.\d+Z$/, "Z");

  // The feed reads only the public submission projection. Revealed verdict
  // fields reach scoring through the post-horizon commitment attachment,
  // not through pending feed rows.
  const rawAccepted = db
    .prepare(
      `SELECT s.call_id, s.agent_id, a.display_slug AS agent_slug, a.kind AS agent_kind,
              s.submitted_at, s.accepted_at, s.status,
              s.privacy_mode, s.commit_hash,
              s.adapter_id, s.market_family, s.market_id
       FROM submissions s
       JOIN agents a ON a.agent_id = s.agent_id
       ORDER BY s.accepted_at DESC
       LIMIT ?`,
    )
    .all(ACCEPTED_LIMIT) as Array<Record<string, unknown> & { agent_slug: string; agent_kind: string; agent_id: string }>;
  const acceptedRows: TodayFeedRow[] = rawAccepted.map(toFeedRow);

  const rawPending = db
    .prepare(
      `SELECT s.call_id, s.agent_id, a.display_slug AS agent_slug, a.kind AS agent_kind,
              s.submitted_at, s.accepted_at, s.status,
              s.privacy_mode, s.commit_hash,
              s.adapter_id, s.market_family, s.market_id
       FROM submissions s
       JOIN agents a ON a.agent_id = s.agent_id
       WHERE s.status IN ('accepted','pending_t0','pending_t1')
       ORDER BY s.accepted_at DESC
       LIMIT ?`,
    )
    .all(PENDING_LIMIT) as Array<Record<string, unknown> & { agent_slug: string; agent_kind: string; agent_id: string }>;
  // Pending rows do not expose the sealed horizon details needed to derive
  // a t1 estimate; the dashboard renders them without a countdown.
  const pendingRows: TodayFeedRow[] = rawPending.map(toFeedRow);

  // Include adapter_id / market_family / market_id on the resolved tape so
  // non-native rows render with the right labels.
  const rawResolved = db
    .prepare(
      `SELECT s.call_id, s.agent_id, a.display_slug AS agent_slug, a.kind AS agent_kind,
              s.submitted_at, s.accepted_at, s.status,
              s.privacy_mode, s.commit_hash,
              s.adapter_id, s.market_family, s.market_id,
              r.outcome, r.signed_return, r.call_score, r.resolved_at
       FROM t1_resolutions r
       JOIN submissions s ON s.call_id = r.call_id
       JOIN agents a ON a.agent_id = s.agent_id
       ORDER BY r.resolved_at DESC
       LIMIT ?`,
    )
    .all(RESOLVED_LIMIT) as Array<Record<string, unknown> & { agent_slug: string; agent_kind: string; agent_id: string }>;
  const resolvedRows: TodayFeedRow[] = rawResolved.map(toFeedRow);

  // Movers: agents with the most resolved-call activity in the last 24h.
  // verdict_score and rank come from the live leaderboard; we only join the
  // 24h delta counts here.
  const moverRows = db
    .prepare(
      `SELECT a.agent_id, a.display_slug AS agent_slug, a.display_name,
              SUM(CASE WHEN r.outcome IN ('win','loss','void','oracle_unavailable') THEN 1 ELSE 0 END) AS resolved_24h,
              SUM(CASE WHEN r.outcome = 'win' THEN 1 ELSE 0 END) AS wins_24h
       FROM agents a
       JOIN submissions s ON s.agent_id = a.agent_id
       JOIN t1_resolutions r ON r.call_id = s.call_id
       WHERE r.resolved_at >= datetime('now', '-1 day')
         AND a.kind IN ('agent','attested','benchmark')
       GROUP BY a.agent_id
       ORDER BY resolved_24h DESC, wins_24h DESC
       LIMIT ?`,
    )
    .all(MOVERS_LIMIT) as Array<{
    agent_id: string;
    agent_slug: string;
    display_name: string;
    resolved_24h: number;
    wins_24h: number;
  }>;

  const movers: TodayMover[] = moverRows.map((r) => ({
    agent_id: r.agent_id,
    agent_slug: r.agent_slug,
    display_name: r.display_name,
    rank: null, // populated below if the leaderboard has them
    verdict_score: null,
    delta_24h_calls: r.resolved_24h,
    delta_24h_wins: r.wins_24h,
  }));

  const totalsRow = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM submissions WHERE accepted_at >= datetime('now','-1 day')) AS accepted_24h,
         (SELECT COUNT(*) FROM t1_resolutions WHERE resolved_at >= datetime('now','-1 day')) AS resolved_24h,
         (SELECT COUNT(*) FROM t1_resolutions WHERE resolved_at >= datetime('now','-1 day') AND outcome='win') AS wins_24h,
         (SELECT COUNT(*) FROM t1_resolutions WHERE resolved_at >= datetime('now','-1 day') AND outcome='loss') AS losses_24h,
         (SELECT COUNT(*) FROM t1_resolutions WHERE resolved_at >= datetime('now','-1 day') AND outcome='void') AS void_24h`,
    )
    .get() as {
    accepted_24h: number;
    resolved_24h: number;
    wins_24h: number;
    losses_24h: number;
    void_24h: number;
  };

  return {
    schema_version: 1,
    served_at: nowIso,
    accepted_recent: acceptedRows,
    pending_resolution: pendingRows,
    resolved_recent: resolvedRows,
    movers,
    totals: totalsRow,
  };
}

/**
 * Map a raw SQL row to a TodayFeedRow. Pending verdict fields are never
 * populated. Public identifiers, discriminators, and resolved-side fields
 * pass through from the SQL row.
 */
function toFeedRow(row: Record<string, unknown>): TodayFeedRow {
  const projected = projectCallRow(
    {
      call_id: row.call_id as string,
      status: row.status as string,
      accepted_at: row.accepted_at as string,
      privacy_mode: row.privacy_mode as string | null,
      commit_hash: row.commit_hash as string | null,
      // Wave 4b: receipts subsystem dropped; projection always emits null.
      acceptance_receipt_hash: null,
      submitted_at: row.submitted_at as string | null,
    },
    row.agent_slug as string,
  );
  // Phase 10 / Z4-extra Drift C — discriminators travel with the row.
  // Native-price defaults match MIGRATION_016 backfill semantics.
  const adapter_id = (row.adapter_id as string | null) ?? "native-price";
  const market_family =
    (row.market_family as string | null) ?? "financial-direction";
  const market_id = (row.market_id as string | null) ?? null;
  // signed_return is a price-return concept — keep it only for the
  // native-price adapter. Non-native rows surface outcome + call_score
  // but omit signed_return entirely so consumers (RSS, embed, mobile)
  // don't render a misleading "null %" / "0%" formatting for event-
  // based markets.
  const isNativePrice = adapter_id === "native-price";
  const result: TodayFeedRow = {
    ...projected,
    agent_id: row.agent_id as string,
    agent_slug: row.agent_slug as string,
    agent_kind: row.agent_kind as string,
    adapter_id,
    market_family,
    ...(market_id ? { market_id } : {}),
  };
  // Resolved-side fields come from t1_resolutions (public, not under FHE).
  // Forward straight from the SQL row when present.
  if (typeof row.submitted_at === "string") {
    result.submitted_at = row.submitted_at;
  }
  if (typeof row.outcome === "string") result.outcome = row.outcome;
  if (typeof row.call_score === "number") result.call_score = row.call_score;
  if (typeof row.resolved_at === "string") result.resolved_at = row.resolved_at;
  if (isNativePrice && typeof row.signed_return === "string") {
    result.signed_return = row.signed_return;
  }
  return result;
}
