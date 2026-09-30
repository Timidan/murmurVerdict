import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { openDb } from "../db.js";
import { findEncryptedInputReuse } from "./encrypted-input-reuse-repo.js";
import { fhenixGatewayTxRepo } from "./fhenix-gateway-tx-repo.js";

// Audit F-1: CoFHE proofs bind the relayer, not the agent, so a copied
// ciphertext pair verifies on-chain under any agent. This lookup is the
// daemon's defense; the rule under test is "a handle seen for ANOTHER agent
// is reuse; the submitting agent's own attempts stay retryable".
process.stdout.write("murmur encrypted-input reuse repo smoke\n");

const tmp = mkdtempSync(join(tmpdir(), "murmur-ct-reuse-"));
const db = openDb({ path: join(tmp, "t.db") });

const ownerAgent = randomUUID();
const copycatAgent = randomUUID();
const accountId = randomUUID();
const ts = "2026-09-30T12:00:00Z";

db.prepare(
  `INSERT INTO accounts (account_id, privy_user_id, created_at, last_seen_at)
   VALUES (?, ?, ?, ?)`,
).run(accountId, "did:privy:ct-reuse-smoke", ts, ts);
db.prepare(
  `INSERT INTO agents (agent_id, display_slug, kind, display_name, bio,
     created_at, api_key_hash, wallet_address, chain_id)
   VALUES (?, 'ct-reuse-owner', 'agent', 'Reuse Owner', NULL, ?, NULL, NULL, NULL)`,
).run(ownerAgent, ts);
db.prepare(
  `INSERT INTO account_agents (account_id, agent_id, created_at)
   VALUES (?, ?, ?)`,
).run(accountId, ownerAgent, ts);
const HASH_A = `0x${"11".repeat(32)}`;
const HASH_B = `0x${"22".repeat(32)}`;
const FRESH_1 = `0x${"33".repeat(32)}`;
const FRESH_2 = `0x${"44".repeat(32)}`;

fhenixGatewayTxRepo.insert(db, {
  attempt_id: randomUUID(),
  status: "queued",
  runtime_key_id: null,
  runtime_key_policy_hash: "policy-hash",
  runtime_key_policy_json: "{}",
  account_id: accountId,
  agent_id: ownerAgent,
  chain_id: 84532,
  contract_address: "0x" + "ab".repeat(20),
  relayer_address: "0x" + "cd".repeat(20),
  agent_wallet_address: "0x" + "ef".repeat(20),
  market_id: "smoke-market",
  market_id_hash: `0x${"55".repeat(32)}`,
  market_ref_protocol: "polymarket",
  market_config_version: 1,
  client_order_id: "ct-reuse-smoke-order-1",
  client_nonce: `0x${"66".repeat(32)}`,
  submitted_at: ts,
  rationale: null,
  strategy_tag: "momentum",
  binary_index_input_json: "{}",
  confidence_input_json: "{}",
  binary_index_ct_hash: HASH_A,
  confidence_ct_hash: HASH_B,
  request_fingerprint: null,
  auth_proof: null,
  next_attempt_at: ts,
  created_at: ts,
  updated_at: ts,
});

// A different agent presenting either of the owner's handles is reuse —
// including one copied handle paired with a fresh one.
const copied = findEncryptedInputReuse(db, {
  ctHashes: [HASH_A, FRESH_1],
  exceptAgentId: copycatAgent,
});
assert.equal(copied?.pool, "gateway_call_attempt");
assert.equal(
  findEncryptedInputReuse(db, { ctHashes: [FRESH_1, HASH_B], exceptAgentId: copycatAgent })?.pool,
  "gateway_call_attempt",
);

// The owner retrying its own submission under a fresh order id is NOT reuse.
assert.equal(
  findEncryptedInputReuse(db, { ctHashes: [HASH_A, HASH_B], exceptAgentId: ownerAgent }),
  null,
);

// Never-seen handles are clean for anyone.
assert.equal(
  findEncryptedInputReuse(db, { ctHashes: [FRESH_1, FRESH_2], exceptAgentId: copycatAgent }),
  null,
);

db.close();
rmSync(tmp, { recursive: true, force: true });
process.stdout.write("OK encrypted-input reuse repo smoke\n");
