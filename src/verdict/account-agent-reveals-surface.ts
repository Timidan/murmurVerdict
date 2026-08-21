// ─── The agent's reveal duty list ──────────────────────────────────────────
//
//   GET /v1/account/agents/:slug/reveals
//
// A sealed call has to be revealed after its market closes. The agent gets an
// exclusive window to do it itself; when that window lapses, murmur's fallback
// worker reveals it instead. Both outcomes are public, and which one happened
// is recorded per call — so this surface is the owner's answer to "which of my
// calls still need me, and by when?".

import type Database from "better-sqlite3";

import { requireOwnedAgentBySlug } from "./agent-identity.js";
import { prep } from "./db-statements.js";
import { SCHEMA_VERSION } from "./schema.js";
import { isoFromMs } from "./time.js";

/**
 * Who published the reveal.
 *
 *   agent                 the agent revealed its own call, in its window
 *   daemon_fallback       the agent missed the window; murmur's worker did it
 *   unattributed_external some other sender published it (reveal is
 *                         permissionless on-chain)
 *   unknown               the call IS revealed, but this row predates reveal
 *                         attribution (migration 057) so no sender was stored
 *   pending               nobody has revealed it yet
 *
 * The last two are deliberately different words. "pending" is a statement
 * about the CALL — it has not been revealed. "unknown" is a statement about
 * MURMUR's records — it was revealed and we cannot say by whom. Collapsing
 * missing attribution into "pending" would show an owner a duty that is
 * already discharged.
 */
export type AccountRevealSource =
  | "agent"
  | "daemon_fallback"
  | "unattributed_external"
  | "unknown"
  | "pending";

export interface AccountRevealRow {
  call_id: string;
  onchain_call_id: string;
  chain_id: number;
  reveal_open_at: string;
  /**
   * When murmur's fallback takes over: reveal_open_at + the CONFIGURED grace.
   * null when this deployment runs no fallback worker, in which case there is
   * no such moment to report.
   */
  deadline: string | null;
  reveal_status: string;
  revealed_at: string | null;
  reveal_source: AccountRevealSource;
}

export interface AccountRevealsResponse {
  status: number;
  body: unknown;
}

export interface AccountRevealsSurfaceDeps {
  db: Database.Database;
  accountId: string;
  slug: string;
  /**
   * FHENIX_REVEAL_WORKER_GRACE_SEC as this deployment is configured, threaded
   * from the parsed daemon config.
   *
   * NEVER default this to 300 in here. That number is the env loader's
   * default, the operator may override it, and a surface that hardcoded it
   * would print a deadline the worker does not actually honour. `null` says
   * "no fallback worker configured" and the deadline is then reported as null
   * rather than guessed.
   */
  revealGraceSeconds: number | null;
  limit?: number;
  offset?: number;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

export function readAccountAgentReveals(
  deps: AccountRevealsSurfaceDeps,
): AccountRevealsResponse {
  const agent = requireOwnedAgentBySlug(deps.db, deps.accountId, deps.slug);
  const limit = clamp(deps.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT);
  const offset = Math.max(0, Math.floor(deps.offset ?? 0));

  // idx_submissions_agent covers the agent filter and fhenix_sealed_calls is
  // reached on its PRIMARY KEY, so this needs no index of its own.
  const rows = prep(
    deps.db,
    `SELECT s.call_id          AS call_id,
            f.onchain_call_id  AS onchain_call_id,
            f.chain_id         AS chain_id,
            f.reveal_open_at   AS reveal_open_at,
            f.reveal_status    AS reveal_status,
            f.reveal_source    AS reveal_source,
            f.revealed_at      AS revealed_at
       FROM submissions s
       JOIN fhenix_sealed_calls f ON f.call_id = s.call_id
      WHERE s.agent_id = @agent_id
      ORDER BY f.reveal_open_at DESC, s.call_id DESC
      LIMIT @limit OFFSET @offset`,
  ).all({ agent_id: agent.agent_id, limit, offset }) as Array<{
    call_id: string;
    onchain_call_id: string;
    chain_id: number;
    reveal_open_at: string;
    reveal_status: string;
    reveal_source: string | null;
    revealed_at: string | null;
  }>;

  const grace = deps.revealGraceSeconds;
  const reveals: AccountRevealRow[] = rows.map((row) => ({
    call_id: row.call_id,
    onchain_call_id: row.onchain_call_id,
    chain_id: row.chain_id,
    reveal_open_at: row.reveal_open_at,
    deadline: revealDeadline(row.reveal_open_at, grace),
    reveal_status: row.reveal_status,
    revealed_at: row.revealed_at,
    reveal_source: normalizeRevealSource(row.reveal_status, row.reveal_source),
  }));

  return {
    status: 200,
    body: {
      schema_version: SCHEMA_VERSION,
      agent_slug: agent.display_slug,
      reveals,
      fallback: {
        enabled: grace !== null,
        grace_seconds: grace,
        note:
          grace === null
            ? "This deployment runs no fallback reveal worker, so a call you do not reveal stays sealed."
            : "Reveal a call yourself before its deadline. After the deadline murmur's worker reveals it, and the call is marked as revealed by murmur.",
      },
      page: { limit, offset, returned: reveals.length },
    },
  };
}

export function revealDeadline(
  revealOpenAt: string,
  graceSeconds: number | null,
): string | null {
  if (graceSeconds === null) return null;
  const openMs = Date.parse(revealOpenAt);
  if (!Number.isFinite(openMs)) return null;
  return isoFromMs(openMs + graceSeconds * 1_000);
}

export function normalizeRevealSource(
  revealStatus: string,
  revealSource: string | null,
): AccountRevealSource {
  // Genuinely unrevealed first: the call is still the agent's to make.
  if (revealStatus === "pending") return "pending";
  if (
    revealSource === "agent" ||
    revealSource === "daemon_fallback" ||
    revealSource === "unattributed_external"
  ) {
    return revealSource;
  }
  // Revealed (or invalid, or missed) with no sender recorded — a row from
  // before attribution existed. Say "unknown", not "pending".
  return "unknown";
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}
