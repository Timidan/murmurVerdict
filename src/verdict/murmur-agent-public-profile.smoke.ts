import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";

import {
  publicMurmurAgentListRow,
  publicMurmurAgentProfile,
} from "./murmur-agent-public-profile.js";
import type { AgentRow } from "./repos/agents-repo.js";

process.stdout.write("murmur agent public profile smoke\n");

const agent: AgentRow = {
  agent_id: randomUUID(),
  display_slug: "profile-smoke",
  kind: "agent",
  display_name: "Profile Smoke",
  bio: "Public profile bio",
  created_at: "2026-05-27T12:00:00Z",
  api_key_hash: "private-hash",
  retired_at: null,
  wallet_address: "0x1111111111111111111111111111111111111111",
  chain_id: "eip155:8453",
};

const profile = publicMurmurAgentProfile(agent);
assert.ok(profile);
assert.equal(profile.agent_id, agent.agent_id);
assert.equal(profile.display_slug, "profile-smoke");
assert.equal(profile.bio, "Public profile bio");
assert.equal(profile.wallet_address, "0x1111111111111111111111111111111111111111");
assert.equal(profile.chain_id, "eip155:8453");
assert.equal("api_key_hash" in profile, false);

const sparseAgent: AgentRow = {
  agent_id: randomUUID(),
  display_slug: "sparse-profile",
  kind: "benchmark",
  display_name: "Sparse Profile",
  created_at: "2026-05-27T12:05:00Z",
  api_key_hash: "private-hash",
  retired_at: null,
};
const sparseProfile = publicMurmurAgentProfile(sparseAgent);
assert.ok(sparseProfile);
assert.equal("bio" in sparseProfile, false);
assert.equal("wallet_address" in sparseProfile, false);
assert.equal("chain_id" in sparseProfile, false);
assert.equal("api_key_hash" in sparseProfile, false);

const listRow = publicMurmurAgentListRow(sparseAgent);
assert.deepEqual(listRow, {
  agent_id: sparseAgent.agent_id,
  display_slug: "sparse-profile",
  display_name: "Sparse Profile",
  kind: "benchmark",
  bio: null,
  created_at: "2026-05-27T12:05:00Z",
});
assert.equal("api_key_hash" in listRow, false);
assert.equal(publicMurmurAgentProfile(null), null);

process.stdout.write("  ok public profile hides private auth state\n");
