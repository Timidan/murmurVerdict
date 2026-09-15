import type Database from "better-sqlite3";

import { prep } from "../db-statements.js";
import type { AgentKind, AgentProfile } from "../schema.js";

export interface AgentRow extends AgentProfile {
  api_key_hash: string | null;
  /**
   * When the owner retired this agent (migration 073), or null while it is
   * still working. Retirement stops NEW calls; it never touches the record
   * already on the board, and never touches the earnings the record earned.
   */
  retired_at: string | null;
}

export const agentsRepo = {
  insert(
    db: Database.Database,
    profile: AgentProfile,
  ): void {
    prep(
      db,
      `INSERT INTO agents (agent_id, display_slug, kind, display_name, bio, created_at, api_key_hash, wallet_address, chain_id)
       VALUES (@agent_id, @display_slug, @kind, @display_name, @bio, @created_at, @api_key_hash, @wallet_address, @chain_id)`,
    ).run({
      agent_id: profile.agent_id,
      display_slug: profile.display_slug,
      kind: profile.kind,
      display_name: profile.display_name,
      bio: profile.bio ?? null,
      created_at: profile.created_at,
      api_key_hash: null,
      wallet_address: profile.wallet_address ?? null,
      chain_id: profile.chain_id ?? null,
    });
  },

  byId(db: Database.Database, agent_id: string): AgentRow | null {
    const row = prep(
      db,
      "SELECT * FROM agents WHERE agent_id = ?",
    ).get(agent_id) as RawAgentRow | undefined;
    return row ? hydrateAgent(row) : null;
  },

  bySlug(db: Database.Database, slug: string): AgentRow | null {
    const row = prep(
      db,
      "SELECT * FROM agents WHERE display_slug = ? COLLATE NOCASE",
    ).get(slug) as RawAgentRow | undefined;
    return row ? hydrateAgent(row) : null;
  },

  /**
   * Bind a wallet to an agent. Idempotent: re-running with the same values
   * is a no-op. The wallet is expected to be lowercase-normalized by the
   * caller; the schema check enforces the lowercase form.
   */
  setWallet(
    db: Database.Database,
    agent_id: string,
    wallet_address: string,
    chain_id: string,
  ): void {
    prep(
      db,
      "UPDATE agents SET wallet_address = ?, chain_id = ? WHERE agent_id = ?",
    ).run(wallet_address, chain_id, agent_id);
  },

  byWallet(
    db: Database.Database,
    wallet_address: string,
    chain_id: string,
  ): AgentRow | null {
    const row = prep(
      db,
      "SELECT * FROM agents WHERE wallet_address = ? AND chain_id = ?",
    ).get(wallet_address, chain_id) as RawAgentRow | undefined;
    return row ? hydrateAgent(row) : null;
  },

  /**
   * The one read the gateway hot path takes. Deliberately NOT `byId` — the
   * reservation runs inside a BEGIN IMMEDIATE and only needs one column, so it
   * does not pay for a full row hydration per attempt.
   */
  retiredAt(db: Database.Database, agent_id: string): string | null {
    const row = prep(
      db,
      "SELECT retired_at FROM agents WHERE agent_id = ?",
    ).get(agent_id) as { retired_at: string | null } | undefined;
    return row?.retired_at ?? null;
  },

  deletedAt(db: Database.Database, agent_id: string): string | null {
    const row = prep(db, "SELECT deleted_at FROM agents WHERE agent_id = ?")
      .get(agent_id) as { deleted_at: string | null } | undefined;
    return row?.deleted_at ?? null;
  },

  /**
   * Set or clear the retirement marker. Returns true iff the state changed, so
   * the caller can make retire/unretire idempotent without a second read.
   *
   * The WHERE clause carries the current state on purpose: two concurrent
   * retires cannot both report "you retired it".
   */
  setRetiredAt(
    db: Database.Database,
    agent_id: string,
    retired_at: string | null,
  ): boolean {
    const info = retired_at === null
      ? prep(
          db,
          "UPDATE agents SET retired_at = NULL WHERE agent_id = ? AND retired_at IS NOT NULL",
        ).run(agent_id)
      : prep(
          db,
          "UPDATE agents SET retired_at = ? WHERE agent_id = ? AND retired_at IS NULL",
        ).run(retired_at, agent_id);
    return info.changes > 0;
  },

  /**
   * Edit the two fields an owner may change after creation.
   *
   * display_slug is NOT here and never will be: it is the agent's identity in
   * every URL, every receipt, and every webhook subscription (webhooks key on
   * agent_slug, not agent_id), while the financial tables key on agent_id.
   * Renaming the slug would silently orphan the first set.
   */
  updateProfile(
    db: Database.Database,
    agent_id: string,
    fields: { display_name?: string; bio?: string | null },
  ): void {
    const sets: string[] = [];
    const params: Record<string, unknown> = { agent_id };
    if (fields.display_name !== undefined) {
      sets.push("display_name = @display_name");
      params.display_name = fields.display_name;
    }
    if (fields.bio !== undefined) {
      sets.push("bio = @bio");
      params.bio = fields.bio;
    }
    if (sets.length === 0) return;
    prep(
      db,
      `UPDATE agents SET ${sets.join(", ")} WHERE agent_id = @agent_id`,
    ).run(params);
  },

  countActiveCallsForAgent(db: Database.Database, agent_id: string): number {
    const row = prep(
      db,
      `SELECT COUNT(*) AS n FROM submissions
       WHERE agent_id = ? AND status IN ('accepted','pending_t0','pending_t1')`,
    ).get(agent_id) as { n: number } | undefined;
    return row?.n ?? 0;
  },

  listByKind(
    db: Database.Database,
    kind: AgentKind,
    limit = 100,
  ): Array<Pick<AgentRow, "agent_id" | "display_slug" | "display_name" | "kind" | "bio" | "created_at">> {
    const rows = prep(
      db,
      `SELECT agent_id, display_slug, display_name, kind, bio, created_at
       FROM agents
       WHERE kind = ?
       ORDER BY created_at DESC
       LIMIT ?`,
    ).all(kind, limit) as Array<RawAgentRow>;
    return rows.map((r) => {
      return {
        agent_id: r.agent_id,
        display_slug: r.display_slug,
        display_name: r.display_name,
        kind: r.kind,
        bio: r.bio ?? undefined,
        created_at: r.created_at,
      };
    });
  },
};

interface RawAgentRow {
  agent_id: string;
  display_slug: string;
  kind: AgentKind;
  display_name: string;
  bio: string | null;
  created_at: string;
  api_key_hash: string | null;
  wallet_address: string | null;
  chain_id: string | null;
  retired_at: string | null;
}

function hydrateAgent(row: RawAgentRow): AgentRow {
  return {
    agent_id: row.agent_id,
    display_slug: row.display_slug,
    kind: row.kind,
    display_name: row.display_name,
    bio: row.bio ?? undefined,
    created_at: row.created_at,
    api_key_hash: row.api_key_hash,
    // `?? null` rather than a bare read: `SELECT *` on a database that has not
    // reached 073 yet returns no such key at all, and `undefined` here would
    // read as "not retired" in one place and blow up a strict comparison in
    // another. One shape, always.
    retired_at: row.retired_at ?? null,
    ...(row.wallet_address ? { wallet_address: row.wallet_address } : {}),
    ...(row.chain_id ? { chain_id: row.chain_id } : {}),
  };
}
