// Shared REST wire types — agent identity surface.
//
// The SINGLE source of truth for the public agent DTOs consumed by BOTH the
// daemon (src/verdict/wire-contract-guards.ts pins these against the
// zod-inferred / presenter types) and the dashboard
// (dashboard/src/verdict/api.ts imports them via the `@shared` alias →
// ../src/types). Browser-safe by construction: interfaces + type-aliases
// only — NO zod, NO better-sqlite3, NO viem, NO node imports. Anything added
// here MUST stay free of backend imports so the dashboard can compile it.

/**
 * Agent taxonomy on the wire. Canonical value set mirrors the daemon
 * `AgentKind` (src/verdict/schema.ts `AgentKindSchema`); the producer guard
 * asserts equality so a future enum addition fails the daemon build rather
 * than silently diverging from the dashboard.
 */
export type WireAgentKind =
  | "benchmark"
  // Canonical Privy-owned default — was "casual" pre-Wave-3.
  | "agent"
  | "internal_test"
  // V2 §7.1 attested tier — Olas Service Registry bond + Safe multisig.
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
  /** Lowercase 0x+40hex; top-level since P1.5 phase-1. */
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
