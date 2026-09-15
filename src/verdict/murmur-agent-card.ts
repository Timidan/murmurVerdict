import type { AgentRow } from "./repos/agents-repo.js";

export const MURMUR_AGENT_CARD_CONTENT_TYPE = "application/json; charset=utf-8";
export const MURMUR_AGENT_CARD_CACHE_CONTROL = "public, max-age=120, stale-while-revalidate=600";
export const MURMUR_AGENT_CARD_CORS_ORIGIN = "*";

export interface MurmurAgentCardService {
  type: string;
  name: string;
  endpoint: string;
}

export interface MurmurAgentCardX402 {
  protocol: "x402";
  gateway: "circle";
  endpoint: string;
  mounted: true;
  notes: string;
}

export interface MurmurAgentCard {
  type: "ERC-8004:AgentCard";
  spec_version: "erc-8004-draft-2025";
  name: string;
  slug: string;
  description: string;
  services: MurmurAgentCardService[];
  x402Support: boolean;
  x402?: MurmurAgentCardX402;
  active: boolean;
  registrations: Array<{ chain_id: string; registration_id: string }>;
  privacy: {
    submission_modes: ["sealed_fhenix"];
    threshold_network: "fhenix";
    /** Not a boolean: a grantor can grant any address without on-chain payment proof, so this names the condition. */
    operator_can_decrypt_pre_horizon: "requires_owner_or_grantor_key";
    /** Plaintext never reaches Murmur on the canonical client-sealed path. */
    operator_holds_plaintext: "never_on_sealed_fhenix";
    /** allowPublic is gated on the snapshotted on-chain timestamp. Unconditional. */
    public_reveal_enforced_onchain: true;
    threat_model_url: string;
  };
  murmur_wallet?: {
    address: string;
    chain_id: string;
  };
  meta: {
    served_at: string;
    call_history_entrypoint: string;
    openapi: string;
    manifest: string;
  };
}

export interface PublicMurmurAgentCardInput {
  agent: AgentRow;
  apiBase: string;
  nanopayX402Mounted?: boolean;
  servedAt: string;
}

export function publicMurmurAgentCard(
  input: PublicMurmurAgentCardInput,
): MurmurAgentCard {
  const apiBase = input.apiBase.replace(/\/$/, "");
  const agent = input.agent;
  const nanopayEndpoint = `${apiBase}/v2/nanopay/infer/{pipelineId}`;
  const nanopayX402Mounted = input.nanopayX402Mounted === true;
  const card: MurmurAgentCard = {
    type: "ERC-8004:AgentCard",
    spec_version: "erc-8004-draft-2025",
    name: agent.display_name,
    slug: agent.display_slug,
    description:
      agent.bio ??
      "Autonomous market-prediction agent registered on Murmur Verdict — sealed calls scored against the external venue's own resolution.",
    services: [
      {
        type: "murmur-verdict.score",
        name: "Public Verdict score + call history",
        endpoint: `${apiBase}/v1/agents/${agent.display_slug}`,
      },
      {
        type: "murmur-verdict.calls",
        name: "Gateway sealed Fhenix submit",
        endpoint: `${apiBase}/v2/gateway/calls`,
      },
      ...(nanopayX402Mounted
        ? [{
            type: "murmur-verdict.nanopay-x402",
            name: "x402 paid inference",
            endpoint: nanopayEndpoint,
          }]
        : []),
      {
        type: "murmur-verdict.skill",
        name: "Self-onboarding skill (Claude/Cursor/OpenServ readable)",
        endpoint: `${apiBase}/v1/skill.md`,
      },
    ],
    x402Support: nanopayX402Mounted,
    active: agent.kind === "agent",
    registrations: [],
    privacy: {
      submission_modes: ["sealed_fhenix"],
      threshold_network: "fhenix",
      // grantDecryptAccess grants any named address with no on-chain payment proof, and the operator
      // holds a grantor key (FHENIX_GRANT_PRIVATE_KEY), so "no early decrypt" rests on key custody.
      // Unconditional: nothing goes public before publicRevealAt, and client-sealed calls never give Murmur plaintext.
      operator_can_decrypt_pre_horizon: "requires_owner_or_grantor_key",
      operator_holds_plaintext: "never_on_sealed_fhenix",
      public_reveal_enforced_onchain: true,
      threat_model_url: `${apiBase}/v1/skill.md#threat-model--privacy-guarantees`,
    },
    ...(agent.wallet_address && agent.chain_id
      ? {
          murmur_wallet: {
            address: agent.wallet_address,
            chain_id: agent.chain_id,
          },
        }
      : {}),
    meta: {
      served_at: input.servedAt,
      call_history_entrypoint: `${apiBase}/v1/agents/${agent.display_slug}/calls`,
      openapi: `${apiBase}/v1/openapi.json`,
      manifest: `${apiBase}/.well-known/murmur.json`,
    },
  };
  if (nanopayX402Mounted) {
    card.x402 = {
      protocol: "x402",
      gateway: "circle",
      endpoint: nanopayEndpoint,
      mounted: true,
      notes:
        "Backed by @circle-fin/x402-batching middleware; this deployment has mounted Nanopay with a pipeline catalog.",
    };
  }
  return card;
}
