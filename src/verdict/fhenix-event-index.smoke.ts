import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  fhenixEventPayloadJson,
  storedFhenixEventPayload,
} from "./fhenix-event-index.js";
import { fhenixEventsRepo, openDb } from "./db.js";

const payload = {
  callId: "0x" + "11".repeat(32),
  revealedAt: 1_797_000_000n,
  nested: { confidenceBps: 7200n, omitted: undefined },
  tuple: [0n, "kept"],
};

const stored = {
  callId: "0x" + "11".repeat(32),
  revealedAt: "1797000000",
  nested: { confidenceBps: "7200" },
  tuple: ["0", "kept"],
};

assert.deepEqual(storedFhenixEventPayload(payload), stored);
assert.equal(fhenixEventPayloadJson(payload), JSON.stringify(stored));

const tmp = mkdtempSync(join(tmpdir(), "murmur-fhenix-event-index-smoke-"));
const dbPath = join(tmp, "test.db");

try {
  const db = openDb({ path: dbPath });
  fhenixEventsRepo.upsertEvent(db, {
    chain_id: 84532,
    contract_address: "0x2222222222222222222222222222222222222222",
    event_name: "VerdictRevealed",
    tx_hash: "0x" + "33".repeat(32),
    log_index: 7,
    block_number: 99,
    block_hash: "0x" + "44".repeat(32),
    payload,
    observed_at: "2026-05-14T14:00:00Z",
  });

  fhenixEventsRepo.upsertEvent(db, {
    chain_id: 84532,
    contract_address: "0x2222222222222222222222222222222222222222",
    event_name: "VerdictRevealed",
    tx_hash: "0x" + "33".repeat(32),
    log_index: 7,
    block_number: 100,
    block_hash: "0x" + "55".repeat(32),
    payload: { ...payload, revealedAt: 1_797_000_001n },
    observed_at: "2026-05-14T14:01:00Z",
  });

  const row = db
    .prepare(
      `SELECT block_number, payload_json
       FROM fhenix_events
       WHERE chain_id = ? AND tx_hash = ? AND log_index = ?`,
    )
    .get(84532, "0x" + "33".repeat(32), 7) as
    | { block_number: number; payload_json: string }
    | undefined;

  assert.equal(row?.block_number, 100);
  assert.deepEqual(JSON.parse(row?.payload_json ?? "{}"), {
    ...stored,
    revealedAt: "1797000001",
  });
  db.close();
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log("fhenix-event-index smoke ok");
