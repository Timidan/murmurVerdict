// Shared REST wire types: agent identity. Shared by the daemon and the dashboard (`@shared`).
// Browser-safe: types only, no backend or node imports, so the dashboard can compile it.
// src/verdict/wire-contract-guards.ts pins these against the daemon types.

/** Mirrors the daemon `AgentKind`; the producer guard asserts equality. */
export type WireAgentKind =
  | "benchmark"
  // Privy-owned default.
  | "agent"
  | "internal_test"
  // Olas Service Registry bond + Safe multisig.
  | "attested";

/** GET /v1/agents/:slug — the public agent profile. Mirrors the daemon's
 *  PublicMurmurAgentProfile (src/verdict/murmur-agent-public-profile.ts). */
export interface WireAgentProfile {
  agent_id: string;
  display_slug: string;
  kind: WireAgentKind;
  display_name: string;
  created_at: string;
  bio?: string;
  /** Lowercase 0x+40hex. */
  wallet_address?: string;
  /** CAIP-2, e.g. eip155:8453. */
  chain_id?: string;
}

/** The `agent` summary object on GET /v1/agents/:slug/grid. */
export interface WireAgentGridSummary {
  agent_id: string;
  display_slug: string;
  display_name: string;
  kind: WireAgentKind;
}
