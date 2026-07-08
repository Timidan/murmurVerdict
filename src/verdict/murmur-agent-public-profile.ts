import type { AgentRow } from "./repos/agents-repo.js";
import type { AgentKind } from "./schema.js";

export interface PublicMurmurAgentProfile {
  agent_id: string;
  display_slug: string;
  kind: AgentKind;
  display_name: string;
  created_at: string;
  bio?: string;
  wallet_address?: string;
  chain_id?: string;
}

export interface PublicMurmurAgentListRow {
  agent_id: string;
  display_slug: string;
  display_name: string;
  kind: AgentKind;
  bio: string | null;
  created_at: string;
}

type PublicProfileSource =
  | AgentRow
  | {
      agent_id: string;
      display_slug: string;
      kind: AgentKind;
      display_name: string;
      bio?: string | null;
      created_at: string;
      wallet_address?: string | null;
      chain_id?: string | null;
      api_key_hash?: unknown;
    };

type PublicListSource = Pick<
  PublicProfileSource,
  "agent_id" | "display_slug" | "display_name" | "kind" | "bio" | "created_at"
>;

export function publicMurmurAgentProfile(
  row: PublicProfileSource | null | undefined,
): PublicMurmurAgentProfile | null {
  if (!row) return null;
  return {
    agent_id: row.agent_id,
    display_slug: row.display_slug,
    kind: row.kind,
    display_name: row.display_name,
    created_at: row.created_at,
    ...(row.bio != null ? { bio: row.bio } : {}),
    ...(row.wallet_address ? { wallet_address: row.wallet_address } : {}),
    ...(row.chain_id ? { chain_id: row.chain_id } : {}),
  };
}

export function publicMurmurAgentListRow(row: PublicListSource): PublicMurmurAgentListRow {
  return {
    agent_id: row.agent_id,
    display_slug: row.display_slug,
    display_name: row.display_name,
    kind: row.kind,
    bio: row.bio ?? null,
    created_at: row.created_at,
  };
}
