import type Database from "better-sqlite3";

import { prep } from "../db-statements.js";
import type { AgentKind, AgentProfile } from "../schema.js";

export interface AgentRow extends AgentProfile {
  api_key_hash: string | null;
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
    ...(row.wallet_address ? { wallet_address: row.wallet_address } : {}),
    ...(row.chain_id ? { chain_id: row.chain_id } : {}),
  };
}
