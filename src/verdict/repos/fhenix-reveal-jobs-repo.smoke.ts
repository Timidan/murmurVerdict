import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  agentsRepo,
  fhenixSealedCallsRepo,
  openDb,
  submissionsRepo,
} from "../db.js";
import { fhenixRevealJobsRepo } from "./fhenix-reveal-jobs-repo.js";

process.stdout.write("murmur fhenix reveal jobs repo smoke\n");

const CHAIN_ID = 84532;
const CONTRACT = "0x2222222222222222222222222222222222222222";

const tmp = mkdtempSync(join(tmpdir(), "reveal-jobs-"));
const db = openDb({ path: join(tmp, `${randomUUID()}.db`) });
const agentId = randomUUID();
agentsRepo.insert(db, {
  agent_id: agentId,
  display_slug: "reveal-jobs-smoke",
  kind: "agent",
  display_name: "Reveal Jobs Smoke",
  created_at: "2026-05-14T12:00:00Z",
  wallet_address: "0x1111111111111111111111111111111111111111",
  chain_id: `eip155:${CHAIN_ID}`,
});

let seq = 0;
function seed(callId: string, revealOpenAt: string): void {
  seq += 1;
  submissionsRepo.acceptSealedFhenixCall(db, {
    call_id: callId,
    agent_id: agentId,
    client_order_id: `order-${callId}`,
    horizon_seconds: 3600,
    submitted_at: "2026-05-14T12:00:00Z",
    accepted_at: "2026-05-14T12:00:00Z",
    rationale: null,
    strategy_tag: "momentum",
    schema_version: 1,
    scoring_version: 1,
    dedup_key: `${callId}:dedup`,
    commit_hash: "0x" + "11".repeat(32),
    commit_scheme: "fhenix-sealed-v1",
    market_id: "eth.1h",
    market_config_version: 1,
    adapter_id: "native-price",
    market_family: "financial-direction",
  });
  fhenixSealedCallsRepo.insert(db, {
    call_id: callId,
    chain_id: CHAIN_ID,
    contract_address: CONTRACT,
    onchain_call_id: "0x" + seq.toString(16).padStart(64, "0"),
    submit_tx_hash: "0x" + (seq + 1000).toString(16).padStart(64, "0"),
    submit_log_index: 0,
    binary_index_ct_hash: "0x" + "aa".repeat(32),
    confidence_ct_hash: "0x" + "bb".repeat(32),
    reveal_open_at: revealOpenAt,
    created_at: "2026-05-14T12:00:00Z",
  });
}

const callA = randomUUID();
seed(callA, "2026-05-14T13:00:00Z");

// ensure() is idempotent — a second call never resets an advanced job.
fhenixRevealJobsRepo.ensure(db, {
  call_id: callA,
  chain_id: CHAIN_ID,
  contract_address: CONTRACT,
  onchain_call_id: "0x" + (1).toString(16).padStart(64, "0"),
  reveal_open_at: "2026-05-14T13:00:00Z",
  now: "2026-05-14T14:00:00Z",
});
fhenixRevealJobsRepo.update(db, callA, {
  phase: "open_tx_pending",
  open_tx_hash: "0xopen",
  tx_broadcast_at: "2026-05-14T14:00:01Z",
  next_attempt_at: "2026-05-14T14:05:00Z",
  now: "2026-05-14T14:00:01Z",
});
assert.equal(
  fhenixRevealJobsRepo.byCallId(db, callA)?.tx_broadcast_at,
  "2026-05-14T14:00:01Z",
);
fhenixRevealJobsRepo.ensure(db, {
  call_id: callA,
  chain_id: CHAIN_ID,
  contract_address: CONTRACT,
  onchain_call_id: "0x" + (1).toString(16).padStart(64, "0"),
  reveal_open_at: "2026-05-14T13:00:00Z",
  now: "2026-05-14T14:10:00Z",
});
assert.equal(fhenixRevealJobsRepo.byCallId(db, callA)?.phase, "open_tx_pending");
assert.equal(fhenixRevealJobsRepo.byCallId(db, callA)?.open_tx_hash, "0xopen");
process.stdout.write("  ok ensure() is idempotent\n");

// COALESCE update: omitting open_tx_hash keeps the prior value.
fhenixRevealJobsRepo.update(db, callA, {
  phase: "opened_confirmed",
  binary_index_value: 1,
  binary_index_signature: "0xsig",
  now: "2026-05-14T14:11:00Z",
});
const advanced = fhenixRevealJobsRepo.byCallId(db, callA);
assert.equal(advanced?.open_tx_hash, "0xopen"); // preserved
assert.equal(advanced?.tx_broadcast_at, "2026-05-14T14:00:01Z"); // preserved
assert.equal(advanced?.binary_index_value, 1);
process.stdout.write("  ok update() preserves omitted fields\n");

// listDue: due, non-terminal, ordered by next_attempt_at; terminal excluded.
const callB = randomUUID();
seed(callB, "2026-05-14T13:30:00Z");
fhenixRevealJobsRepo.ensure(db, {
  call_id: callB,
  chain_id: CHAIN_ID,
  contract_address: CONTRACT,
  onchain_call_id: "0x" + (2).toString(16).padStart(64, "0"),
  reveal_open_at: "2026-05-14T13:30:00Z",
  now: "2026-05-14T13:59:00Z",
});
const callC = randomUUID();
seed(callC, "2026-05-14T13:40:00Z");
fhenixRevealJobsRepo.ensure(db, {
  call_id: callC,
  chain_id: CHAIN_ID,
  contract_address: CONTRACT,
  onchain_call_id: "0x" + (3).toString(16).padStart(64, "0"),
  reveal_open_at: "2026-05-14T13:40:00Z",
  now: "2026-05-14T13:58:00Z",
});
fhenixRevealJobsRepo.update(db, callC, { phase: "terminal_daemon", now: "2026-05-14T14:00:00Z" });

const due = fhenixRevealJobsRepo.listDue(db, {
  chain_id: CHAIN_ID,
  contract_address: CONTRACT,
  now: "2026-05-14T14:20:00Z",
  limit: 10,
});
const dueIds = due.map((j) => j.call_id);
assert.ok(dueIds.includes(callA) && dueIds.includes(callB), "non-terminal due jobs returned");
assert.ok(!dueIds.includes(callC), "terminal job excluded");
// callB (next_attempt 13:59) before callA (14:05).
assert.ok(dueIds.indexOf(callB) < dueIds.indexOf(callA), "ordered by next_attempt_at");
// A not-yet-due job is excluded.
const none = fhenixRevealJobsRepo.listDue(db, {
  chain_id: CHAIN_ID,
  contract_address: CONTRACT,
  now: "2026-05-14T14:00:00Z",
  limit: 10,
});
assert.ok(!none.map((j) => j.call_id).includes(callA), "future next_attempt excluded");
process.stdout.write("  ok listDue orders/excludes correctly\n");


// listNonTerminalOlderThan for the health scan.
const stale = fhenixRevealJobsRepo.listNonTerminalOlderThan(db, {
  chain_id: CHAIN_ID,
  contract_address: CONTRACT,
  reveal_open_before: "2026-05-14T13:35:00Z",
  limit: 10,
});
const staleIds = stale.map((j) => j.call_id);
assert.ok(staleIds.includes(callA) && staleIds.includes(callB));
assert.ok(!staleIds.includes(callC)); // terminal excluded
process.stdout.write("  ok listNonTerminalOlderThan excludes terminal jobs\n");

const counts = fhenixRevealJobsRepo.counts(db);
assert.equal(counts.terminal_daemon, 1);
assert.equal(counts.opened_confirmed, 1);
assert.equal(counts.eligible, 1);
process.stdout.write("  ok counts by phase\n");

// REGRESSION: a worker is bound to ONE deployed contract. A job persisted
// against a previous deployment must never be handed to it — opening or
// publishing that call at the wrong address would revert (or worse, hit an
// unrelated call id).
const OTHER_CONTRACT = "0x" + "cd".repeat(20);
const callOther = randomUUID();
seed(callOther, "2026-05-14T13:40:00Z");
fhenixRevealJobsRepo.ensure(db, {
  call_id: callOther,
  chain_id: CHAIN_ID,
  contract_address: OTHER_CONTRACT,
  onchain_call_id: "0x" + (9).toString(16).padStart(64, "0"),
  reveal_open_at: "2026-05-14T13:40:00Z",
  now: "2026-05-14T13:41:00Z",
});
const scoped = fhenixRevealJobsRepo.listDue(db, {
  chain_id: CHAIN_ID,
  contract_address: CONTRACT,
  now: "2026-05-14T14:20:00Z",
  limit: 10,
});
assert.ok(
  !scoped.map((j) => j.call_id).includes(callOther),
  "job from another contract deployment must not be returned",
);
const otherScoped = fhenixRevealJobsRepo.listDue(db, {
  chain_id: CHAIN_ID,
  contract_address: OTHER_CONTRACT,
  now: "2026-05-14T14:20:00Z",
  limit: 10,
});
assert.ok(
  otherScoped.map((j) => j.call_id).includes(callOther),
  "the other contract's own worker still sees its job",
);
const staleScoped = fhenixRevealJobsRepo.listNonTerminalOlderThan(db, {
  chain_id: CHAIN_ID,
  contract_address: CONTRACT,
  reveal_open_before: "2026-05-14T14:00:00Z",
  limit: 10,
});
assert.ok(
  !staleScoped.map((j) => j.call_id).includes(callOther),
  "health scan is contract-scoped too",
);
process.stdout.write("  ok jobs are scoped to their own contract deployment\n");

db.close();
rmSync(tmp, { recursive: true, force: true });
process.stdout.write("fhenix reveal jobs repo smoke ok\n");
