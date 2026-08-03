import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { openDb } from "../db.js";
import { feedPacketRevealJobsRepo } from "./fhenix-feed-packet-reveal-jobs-repo.js";

process.stdout.write("murmur fhenix feed-packet reveal jobs repo smoke\n");

const tmp = mkdtempSync(join(tmpdir(), "murmur-feed-reveal-jobs-"));
const db = openDb({ path: join(tmp, "t.db") });

const CHAIN_ID = 84532;
const CONTRACT = "0x" + "ab".repeat(20);
const OTHER_CONTRACT = "0x" + "cd".repeat(20);

// feed_packets rows are FK parents of the jobs table.
const agentId = randomUUID();
const feedId = randomUUID();
db.prepare(
  `INSERT INTO agents (agent_id, display_slug, kind, display_name, bio, created_at,
     api_key_hash, wallet_address, chain_id)
   VALUES (?, 'feed-reveal-smoke', 'agent', 'Feed Reveal Smoke', NULL, ?, NULL, NULL, NULL)`,
).run(agentId, "2026-05-14T12:00:00Z");
db.prepare(
  `INSERT INTO feed_contracts (feed_id, agent_id, name, description, status, venue,
     resolution_classes_json, edge_classes_json, covered_market_ids_json,
     delivery_cadence_seconds, trigger_rules_json, max_latency_seconds,
     subscriber_capacity, commercial_template, reveal_policy_json,
     refund_rule_json, slash_rule_json, created_at, updated_at)
   VALUES (?, ?, 'smoke feed', 'd', 'listed', 'polymarket',
     '[]', '[]', '[]', 300, '[]', 60, 10, 'basket_subscription', '{}', '{}', '{}', ?, ?)`,
).run(feedId, agentId, "2026-05-14T12:00:00Z", "2026-05-14T12:00:00Z");

let seqCounter = 1;
function seedPacket(packetId: string, revealAfter: string): void {
  const oc = "0x" + packetId.replace(/-/g, "").padEnd(64, "0").slice(0, 64);
  const seq = seqCounter++;
  db.prepare(
    `INSERT INTO feed_packets (packet_id, feed_id, agent_id, market_id, packet_kind,
       sequence, payload_schema, submitted_at, accepted_at, reveal_after,
       delivery_deadline_at, sla_status, chain_id, contract_address,
       onchain_packet_id, submit_tx_hash, submit_log_index, packet_ct_hash,
       binary_index_ct_hash, confidence_ct_hash, created_at)
     VALUES (?, ?, ?, NULL, 'verdict', ?, 'verdict-v1', ?, ?, ?, ?, 'on_time', ?, ?, ?,
       ?, ?, ?, ?, ?, ?)`,
  ).run(
    packetId, feedId, agentId, seq,
    "2026-05-14T12:00:00Z", "2026-05-14T12:00:00Z", revealAfter,
    "2026-05-14T13:00:00Z", CHAIN_ID, CONTRACT, oc,
    oc, seq,
    "0x" + "01".repeat(32), "0x" + "02".repeat(32), "0x" + "03".repeat(32),
    "2026-05-14T12:00:00Z",
  );
}

// ── ensure() is idempotent ──────────────────────────────────────────────────
const packetA = randomUUID();
seedPacket(packetA, "2026-05-14T13:00:00Z");
const seedA = {
  packet_id: packetA,
  chain_id: CHAIN_ID,
  contract_address: CONTRACT,
  onchain_packet_id: "0x" + "11".repeat(32),
  reveal_after: "2026-05-14T13:00:00Z",
  now: "2026-05-14T13:05:00Z",
};
feedPacketRevealJobsRepo.ensure(db, seedA);
feedPacketRevealJobsRepo.update(db, packetA, {
  phase: "opened_confirmed",
  open_tx_hash: "0x" + "aa".repeat(32),
  now: "2026-05-14T13:06:00Z",
});
feedPacketRevealJobsRepo.ensure(db, seedA); // must NOT reset the phase
assert.equal(feedPacketRevealJobsRepo.byPacketId(db, packetA)?.phase, "opened_confirmed");
process.stdout.write("  ok ensure() is idempotent\n");

// ── update() preserves omitted fields ───────────────────────────────────────
feedPacketRevealJobsRepo.update(db, packetA, {
  phase: "partially_decrypted",
  action_value: 1,
  action_signature: "0x" + "bb".repeat(65),
  now: "2026-05-14T13:07:00Z",
});
feedPacketRevealJobsRepo.update(db, packetA, {
  phase: "ready_to_publish",
  signal_bps_value: 7400,
  signal_bps_signature: "0x" + "cc".repeat(65),
  now: "2026-05-14T13:08:00Z",
});
const afterPartial = feedPacketRevealJobsRepo.byPacketId(db, packetA);
assert.equal(afterPartial?.open_tx_hash, "0x" + "aa".repeat(32), "tx hash preserved");
assert.equal(afterPartial?.action_value, 1, "earlier decrypt result preserved");
assert.equal(afterPartial?.signal_bps_value, 7400);
process.stdout.write("  ok update() preserves omitted fields\n");

// ── listDue: ordering, terminal exclusion, not-yet-due exclusion ────────────
const packetB = randomUUID();
seedPacket(packetB, "2026-05-14T13:00:00Z");
feedPacketRevealJobsRepo.ensure(db, {
  ...seedA, packet_id: packetB,
  onchain_packet_id: "0x" + "22".repeat(32),
  now: "2026-05-14T12:59:00Z",
});
const packetTerminal = randomUUID();
seedPacket(packetTerminal, "2026-05-14T13:00:00Z");
feedPacketRevealJobsRepo.ensure(db, {
  ...seedA, packet_id: packetTerminal,
  onchain_packet_id: "0x" + "33".repeat(32),
  now: "2026-05-14T12:58:00Z",
});
feedPacketRevealJobsRepo.update(db, packetTerminal, {
  phase: "terminal_daemon",
  now: "2026-05-14T13:10:00Z",
});
const due = feedPacketRevealJobsRepo.listDue(db, {
  chain_id: CHAIN_ID, contract_address: CONTRACT,
  now: "2026-05-14T14:00:00Z", limit: 10,
});
const dueIds = due.map((j) => j.packet_id);
assert.ok(dueIds.includes(packetA) && dueIds.includes(packetB), "non-terminal due jobs returned");
assert.ok(!dueIds.includes(packetTerminal), "terminal job excluded");
assert.ok(dueIds.indexOf(packetB) < dueIds.indexOf(packetA), "ordered by next_attempt_at");
process.stdout.write("  ok listDue orders/excludes correctly\n");

// ── contract scoping: a job from another deployment is never returned ───────
const packetOther = randomUUID();
seedPacket(packetOther, "2026-05-14T13:00:00Z");
feedPacketRevealJobsRepo.ensure(db, {
  packet_id: packetOther,
  chain_id: CHAIN_ID,
  contract_address: OTHER_CONTRACT,
  onchain_packet_id: "0x" + "99".repeat(32),
  reveal_after: "2026-05-14T13:00:00Z",
  now: "2026-05-14T13:01:00Z",
});
const scoped = feedPacketRevealJobsRepo.listDue(db, {
  chain_id: CHAIN_ID, contract_address: CONTRACT,
  now: "2026-05-14T14:00:00Z", limit: 10,
});
assert.ok(
  !scoped.map((j) => j.packet_id).includes(packetOther),
  "job from another contract deployment must not be returned",
);
const otherScoped = feedPacketRevealJobsRepo.listDue(db, {
  chain_id: CHAIN_ID, contract_address: OTHER_CONTRACT,
  now: "2026-05-14T14:00:00Z", limit: 10,
});
assert.ok(
  otherScoped.map((j) => j.packet_id).includes(packetOther),
  "that contract's own worker still sees its job",
);
process.stdout.write("  ok jobs are scoped to their own contract deployment\n");

// ── health scan + counts ───────────────────────────────────────────────────
const stale = feedPacketRevealJobsRepo.listNonTerminalOlderThan(db, {
  chain_id: CHAIN_ID, contract_address: CONTRACT,
  reveal_after_before: "2026-05-14T13:30:00Z", limit: 10,
});
const staleIds = stale.map((j) => j.packet_id);
assert.ok(staleIds.includes(packetA) && staleIds.includes(packetB));
assert.ok(!staleIds.includes(packetTerminal), "terminal excluded from health scan");
process.stdout.write("  ok listNonTerminalOlderThan excludes terminal jobs\n");

const counts = feedPacketRevealJobsRepo.counts(db);
assert.equal(counts.terminal_daemon, 1);
assert.equal(counts.ready_to_publish, 1);
assert.equal(counts.eligible, 2);
process.stdout.write("  ok counts by phase\n");

db.close();
rmSync(tmp, { recursive: true, force: true });
process.stdout.write("fhenix feed-packet reveal jobs repo smoke ok\n");
