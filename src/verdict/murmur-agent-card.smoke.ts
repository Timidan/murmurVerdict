import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";

import { publicMurmurAgentCard } from "./murmur-agent-card.js";
import type { AgentRow } from "./repos/agents-repo.js";

process.stdout.write("murmur agent card smoke\n");

const agent: AgentRow = {
  agent_id: randomUUID(),
  display_slug: "card-smoke",
  kind: "agent",
  display_name: "Card Smoke",
  bio: "Public card bio",
  created_at: "2026-05-27T12:00:00Z",
  api_key_hash: "private-hash",
  wallet_address: "0x2222222222222222222222222222222222222222",
  chain_id: "eip155:8453",
};

const card = publicMurmurAgentCard({
  agent,
  apiBase: "https://api.murmur.example/",
  nanopayX402Mounted: true,
  servedAt: "2026-05-27T12:01:00Z",
});

assert.equal(card.type, "ERC-8004:AgentCard");
assert.equal(card.name, "Card Smoke");
assert.equal(card.slug, "card-smoke");
assert.equal(card.description, "Public card bio");
assert.equal(card.active, true);
assert.equal(card.murmur_wallet?.address, "0x2222222222222222222222222222222222222222");
assert.equal(card.murmur_wallet?.chain_id, "eip155:8453");
assert.equal(card.services[0]?.endpoint, "https://api.murmur.example/v1/agents/card-smoke");
assert.equal(card.services[1]?.endpoint, "https://api.murmur.example/v2/gateway/calls");
assert.equal(card.services[2]?.type, "murmur-verdict.nanopay-x402");
assert.equal(card.services[2]?.endpoint, "https://api.murmur.example/v2/nanopay/infer/{pipelineId}");
assert.equal(card.x402Support, true);
assert.equal(card.x402?.protocol, "x402");
assert.equal(card.x402?.gateway, "circle");
assert.equal(card.x402?.endpoint, "https://api.murmur.example/v2/nanopay/infer/{pipelineId}");
assert.equal(card.x402?.mounted, true);
assert.equal(card.privacy.operator_can_decrypt_pre_horizon, false);
assert.equal(card.privacy.threat_model_url, "https://api.murmur.example/v1/skill.md#threat-model--privacy-guarantees");
assert.equal(card.meta.call_history_entrypoint, "https://api.murmur.example/v1/agents/card-smoke/calls");
assert.equal("api_key_hash" in card, false);
assert.equal("runtime_key" in card, false);

const defaultCard = publicMurmurAgentCard({
  agent,
  apiBase: "https://api.murmur.example/",
  servedAt: "2026-05-27T12:02:00Z",
});
assert.equal(defaultCard.x402Support, false);
assert.equal(defaultCard.x402, undefined);
assert.equal(
  defaultCard.services.some((service) => service.type === "murmur-verdict.nanopay-x402"),
  false,
);

const benchmark: AgentRow = {
  agent_id: randomUUID(),
  display_slug: "bench-card",
  kind: "benchmark",
  display_name: "Bench Card",
  created_at: "2026-05-27T12:05:00Z",
  api_key_hash: "private-hash",
};
const benchmarkCard = publicMurmurAgentCard({
  agent: benchmark,
  apiBase: "https://api.murmur.example",
  servedAt: "2026-05-27T12:06:00Z",
});
assert.equal(benchmarkCard.active, false);
assert.equal("murmur_wallet" in benchmarkCard, false);
assert.equal(
  benchmarkCard.description,
  "Autonomous market-prediction agent registered on Murmur Verdict — sealed calls scored against the external venue's own resolution.",
);

process.stdout.write("  ok public agent card declares configured x402 support\n");
