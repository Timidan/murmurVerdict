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
    /**
     * NOT a boolean. It was `false`, which claimed more than the system
     * delivers: a grantor grants to any address without on-chain proof of
     * payment, and the operator already runs one. The value names the
     * condition the guarantee actually rests on.
     */
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
      // Honest, not flattering. A hardcoded `false` overstated the guarantee:
      // grantDecryptAccess grants to ANY address the caller names, with no
      // on-chain proof of payment, and the production operator already holds
      // an authorized grantor key (FHENIX_GRANT_PRIVATE_KEY) — no owner
      // transaction is needed. The HTTP broker enforces payment; a direct
      // privileged transaction does not go through it. So "no early decrypt"
      // holds against the operator's SERVERS and against every unprivileged
      // party, but rests on grantor key custody for the operator themselves.
      //
      // What IS unconditional: the contract cannot make a verdict public
      // before publicRevealAt (allowPublic is gated on the snapshotted
      // timestamp), and on the canonical client-sealed path Murmur never holds
      // plaintext at all.
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
