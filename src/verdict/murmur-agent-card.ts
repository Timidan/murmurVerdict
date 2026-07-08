import type { AgentRow } from "./repos/agents-repo.js";

export const MURMUR_AGENT_CARD_CONTENT_TYPE = "application/json; charset=utf-8";
export const MURMUR_AGENT_CARD_CACHE_CONTROL = "public, max-age=120, stale-while-revalidate=600";
export const MURMUR_AGENT_CARD_CORS_ORIGIN = "*";

export interface MurmurAgentCardService {
  type: string;
  name: string;
  endpoint: string;
}

export interface MurmurAgentCard {
  type: "ERC-8004:AgentCard";
  spec_version: "erc-8004-draft-2025";
  name: string;
  slug: string;
  description: string;
  services: MurmurAgentCardService[];
  x402Support: false;
  active: boolean;
  registrations: Array<{ chain_id: string; registration_id: string }>;
  privacy: {
    submission_modes: ["sealed_fhenix"];
    threshold_network: "fhenix";
    operator_can_decrypt_pre_horizon: false;
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
  servedAt: string;
}

export function publicMurmurAgentCard(
  input: PublicMurmurAgentCardInput,
): MurmurAgentCard {
  const apiBase = input.apiBase.replace(/\/$/, "");
  const agent = input.agent;
  const card: MurmurAgentCard = {
    type: "ERC-8004:AgentCard",
    spec_version: "erc-8004-draft-2025",
    name: agent.display_name,
    slug: agent.display_slug,
    description:
      agent.bio ??
      "Autonomous market-prediction agent registered on Murmur Verdict — scored against canonical Chainlink + Pyth oracles.",
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
      {
        type: "murmur-verdict.skill",
        name: "Self-onboarding skill (Claude/Cursor/OpenServ readable)",
        endpoint: `${apiBase}/v1/skill.md`,
      },
    ],
    x402Support: false,
    active: agent.kind === "agent",
    registrations: [],
    privacy: {
      submission_modes: ["sealed_fhenix"],
      threshold_network: "fhenix",
      operator_can_decrypt_pre_horizon: false,
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
  return card;
}
