import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  agentsRepo,
  fhenixSealedCallsRepo,
  openDb,
  resolutionsRepo,
  submissionsRepo,
} from "./db.js";
import {
  listPublicAgentCallProjections,
  loadPublicSealedCallView,
  projectPublicCallRow,
  publicRssCallRow,
} from "./sealed-call-public-projection.js";

const tmp = mkdtempSync(join(tmpdir(), "murmur-sealed-call-public-projection-"));
const dbPath = join(tmp, "test.db");

try {
  process.stdout.write("murmur sealed call public projection smoke\n");
  const db = openDb({ path: dbPath });
  const agentId = randomUUID();
  const nativeCallId = randomUUID();
  const eventCallId = randomUUID();
  const acceptedAt = "2026-05-16T10:00:00Z";

  agentsRepo.insert(db, {
    agent_id: agentId,
    display_slug: "projection-smoke",
    kind: "agent",
    display_name: "Projection Smoke",
    bio: "Public projection fixture",
    created_at: acceptedAt,
  });

  submissionsRepo.acceptSealedFhenixCall(db, {
    call_id: nativeCallId,
    agent_id: agentId,
    client_order_id: "native-private-order",
    horizon_seconds: 3600,
    submitted_at: acceptedAt,
    accepted_at: acceptedAt,
    rationale: "native secret rationale",
    strategy_tag: "native-secret-tag",
    schema_version: 1,
    scoring_version: 1,
    dedup_key: `dedup-${nativeCallId}`,
    commit_hash: "a".repeat(64),
    commit_scheme: "fhenix-sealed-v1",
    market_id: `0x${"ab".repeat(32)}`,
    market_config_version: 1,
    adapter_id: "polymarket-gamma",
    market_family: "prediction-market-binary",
  });
  resolutionsRepo.setResolution(db, {
    call_id: nativeCallId,
    t1: "2026-05-16T11:00:00Z",
    // Legacy price-anchor columns: always NULL now.
    p1: null,
    t1_feed: null,
    signed_return: null,
    outcome: "win",
    call_score: 1,
    resolved_at: "2026-05-16T11:00:05Z",
  });
  submissionsRepo.setStatus(db, nativeCallId, "resolved");
  fhenixSealedCallsRepo.insert(db, {
    call_id: nativeCallId,
    chain_id: 8453,
    contract_address: "0x" + "1".repeat(40),
    onchain_call_id: "0x" + "2".repeat(64),
    submit_tx_hash: "0x" + "3".repeat(64),
    submit_log_index: 7,
    binary_index_ct_hash: "0x" + "4".repeat(64),
    confidence_ct_hash: "0x" + "5".repeat(64),
    reveal_open_at: "2026-05-16T11:00:00Z",
    submission_class: 1,
    created_at: acceptedAt,
  });
  fhenixSealedCallsRepo.attachReveal(db, {
    call_id: nativeCallId,
    revealed_binary_index: 1,
    revealed_confidence: 0.72,
    revealed_confidence_bps: 7200,
    revealed_at: "2026-05-16T11:00:01Z",
    reveal_tx_hash: "0x" + "6".repeat(64),
    reveal_log_index: 8,
    reveal_block_number: 12_345,
  });

  submissionsRepo.acceptSealedFhenixCall(db, {
    call_id: eventCallId,
    agent_id: agentId,
    client_order_id: "event-private-order",
    horizon_seconds: 7200,
    submitted_at: acceptedAt,
    accepted_at: "2026-05-16T10:05:00Z",
    rationale: "event secret rationale",
    strategy_tag: "event-secret-tag",
    schema_version: 1,
    scoring_version: 1,
    dedup_key: `dedup-${eventCallId}`,
    commit_hash: "b".repeat(64),
    commit_scheme: "fhenix-sealed-v1",
    market_id: `0x${"1".repeat(64)}`,
    market_config_version: 1,
    adapter_id: "polymarket-gamma",
    market_family: "prediction-market-binary",
  });
  resolutionsRepo.setResolution(db, {
    call_id: eventCallId,
    t1: "2026-05-16T12:00:00Z",
    p1: "YES",
    t1_feed: "polymarket-gamma-oracle",
    signed_return: "999",
    outcome: "loss",
    call_score: 0,
    resolved_at: "2026-05-16T12:00:05Z",
  });
  submissionsRepo.setStatus(db, eventCallId, "resolved");

  const rows = listPublicAgentCallProjections({
    db,
    agent_id: agentId,
    agent_slug: "projection-smoke",
    limit: 10,
  });
  assert.equal(rows.length, 2);
  const asText = JSON.stringify(rows);
  assert.equal(asText.includes("secret rationale"), false);
  assert.equal(asText.includes("secret-tag"), false);
  assert.equal(asText.includes("confidence"), false);

  const native = rows.find((row) => row.call_id === nativeCallId);
  assert.ok(native);
  assert.equal(native.adapter_id, "polymarket-gamma");
  // signed_return is gone from every public projection — no venue-settled
  // market has a scalar return.
  assert.equal("signed_return" in native, false);
  assert.equal(native.agent_slug, "projection-smoke");

  const event = rows.find((row) => row.call_id === eventCallId);
  assert.ok(event);
  assert.equal(event.adapter_id, "polymarket-gamma");
  assert.equal(event.market_family, "prediction-market-binary");
  assert.equal("signed_return" in event, false);
  const eventRssRow = publicRssCallRow(event);
  assert.equal("signed_return" in eventRssRow, false);
  assert.equal(eventRssRow.is_sealed_scrubbed, true);
  assert.equal("asset_id" in eventRssRow, false);
  assert.equal("confidence" in eventRssRow, false);

  const acceptedOnly = projectPublicCallRow({
    call_id: randomUUID(),
    status: "accepted",
    accepted_at: acceptedAt,
    privacy_mode: "sealed_fhenix",
    commit_hash: "c".repeat(64),
    submitted_at: acceptedAt,
    adapter_id: null,
    market_family: null,
  });
  assert.equal("outcome" in acceptedOnly, false);
  // A row with no stamped adapter identity gets the neutral display-only
  // sentinel, never a native-price default.
  assert.equal(acceptedOnly.adapter_id, "unknown");
  assert.equal(acceptedOnly.market_family, "unknown");

  const launchpadView = loadPublicSealedCallView({
    db,
    call_id: nativeCallId,
  });
  assert.ok(launchpadView);
  assert.equal(launchpadView.submission.call_id, nativeCallId);
  assert.equal(launchpadView.submission.market_id, `0x${"ab".repeat(32)}`);
  assert.equal(launchpadView.submission.horizon_seconds, 3600);
  assert.equal(launchpadView.submission.commit_hash, "a".repeat(64));
  assert.equal("client_order_id" in launchpadView.submission, false);
  assert.equal("fhenix" in launchpadView, false);
  assert.equal(JSON.stringify(launchpadView).includes("native secret rationale"), false);
  assert.equal(JSON.stringify(launchpadView).includes("native-secret-tag"), false);

  const restView = loadPublicSealedCallView({
    db,
    call_id: nativeCallId,
    audience: "public-call-detail",
  });
  assert.ok(restView);
  assert.equal(restView.submission.client_order_id, "native-private-order");
  assert.equal(restView.fhenix?.revealed_verdict?.binary_index, 1);
  assert.equal(restView.fhenix?.revealed_verdict?.confidence_bps, 7200);
  assert.equal(restView.fhenix?.revealed_verdict?.confidence, 0.72);

  db.close();
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

process.stdout.write("sealed call public projection smoke ok\n");
