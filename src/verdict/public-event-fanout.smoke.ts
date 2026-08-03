import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  agentsRepo,
  marketsRepo,
  openDb,
  resolutionsRepo,
  submissionsRepo,
} from "./db.js";
import {
  VerdictEventBus,
  type VerdictEvent,
} from "./events.js";
import {
  publicAcceptedCallEvent,
  publicLeaderboardUpdateEvent,
  publicMarketsUpdateEvent,
  publicResolutionFanoutEvents,
  publicResolvedCallEvent,
  publicWebhookFanoutEvent,
} from "./public-event-fanout.js";
import { createResolutionFanout } from "./resolution-fanout.js";

const tmp = mkdtempSync(join(tmpdir(), "murmur-public-event-fanout-"));
const dbPath = join(tmp, "test.db");

try {
  process.stdout.write("murmur public event fanout smoke\n");
  const db = openDb({ path: dbPath });
  const agentId = randomUUID();
  const nativeCallId = randomUUID();
  const eventCallId = randomUUID();
  const eventMarketId = `0x${"2".repeat(64)}`;
  const acceptedAt = "2026-05-17T10:00:00Z";

  agentsRepo.insert(db, {
    agent_id: agentId,
    display_slug: "fanout-smoke",
    kind: "agent",
    display_name: "Fanout Smoke",
    bio: "Public event fanout fixture",
    created_at: acceptedAt,
  });
  const agent = agentsRepo.byId(db, agentId);
  assert.ok(agent);

  marketsRepo.upsertExternalMarket(db, {
    market_id: eventMarketId,
    asset_id: "polymarket:event",
    market_kind: "event_binary",
    horizon_seconds: 3600,
    primary_oracle_id: "polymarket-gamma-oracle",
    adapter_id: "polymarket-gamma",
    market_family: "prediction-market-binary",
    scoring_kind: "multinomial_brier",
    config_json: JSON.stringify({ conditionId: eventMarketId }),
    void_band: "0",
    status: "listed",
    created_at: acceptedAt,
  });
  const eventMarket = marketsRepo.get(db, eventMarketId);
  assert.ok(eventMarket);

  submissionsRepo.acceptSealedFhenixCall(db, {
    call_id: nativeCallId,
    agent_id: agentId,
    client_order_id: "native-event-order",
    horizon_seconds: 3600,
    submitted_at: acceptedAt,
    accepted_at: acceptedAt,
    schema_version: 1,
    scoring_version: 1,
    dedup_key: `dedup-${nativeCallId}`,
    commit_hash: "a".repeat(64),
    commit_scheme: "fhenix-sealed-v1",
    market_id: "eth.1h",
    market_config_version: 1,
    adapter_id: "native-price",
    market_family: "financial-direction",
  });
  resolutionsRepo.setResolution(db, {
    call_id: nativeCallId,
    t1: "2026-05-17T11:00:00Z",
    p1: "101",
    t1_feed: "chainlink:base:ETH-USD",
    signed_return: "0.01",
    outcome: "win",
    call_score: 1,
    resolved_at: "2026-05-17T11:00:05Z",
    resolved_outcome_json: JSON.stringify({ kind: "binary" }),
    payout_vector_json: JSON.stringify(["1", "0"]),
  });
  submissionsRepo.setStatus(db, nativeCallId, "resolved");

  submissionsRepo.acceptSealedFhenixCall(db, {
    call_id: eventCallId,
    agent_id: agentId,
    client_order_id: "event-order",
    horizon_seconds: 3600,
    submitted_at: acceptedAt,
    accepted_at: "2026-05-17T10:05:00Z",
    schema_version: 1,
    scoring_version: 1,
    dedup_key: `dedup-${eventCallId}`,
    commit_hash: "b".repeat(64),
    commit_scheme: "fhenix-sealed-v1",
    market_id: eventMarketId,
    market_config_version: 1,
    adapter_id: "polymarket-gamma",
    market_family: "prediction-market-binary",
  });
  resolutionsRepo.setResolution(db, {
    call_id: eventCallId,
    t1: "2026-05-17T11:05:00Z",
    p1: "YES",
    t1_feed: "polymarket-gamma-oracle",
    signed_return: "999",
    outcome: "loss",
    call_score: 0,
    resolved_at: "2026-05-17T11:05:05Z",
    resolved_outcome_json: JSON.stringify({ kind: "external" }),
    payout_vector_json: JSON.stringify(["0", "1"]),
  });
  submissionsRepo.setStatus(db, eventCallId, "resolved");

  const nativeFull = resolutionsRepo.loadFullCall(db, nativeCallId);
  assert.ok(nativeFull);
  const nativeEvent = publicResolvedCallEvent({
    full: nativeFull,
    agent,
  });
  // A LEGACY row (native-price adapter, stored signed_return) still projects
  // its payout vector and adapter identity, but price evidence is no longer
  // part of any public event — murmur publishes venue outcomes, not price
  // anchors, so signed_return must be absent here exactly as it is for a
  // current external-venue call.
  assert.equal("signed_return" in (nativeEvent ?? {}), false);
  assert.deepEqual(nativeEvent?.payout_vector, ["1", "0"]);
  assert.equal(nativeEvent?.adapter_id, "native-price");

  const eventFull = resolutionsRepo.loadFullCall(db, eventCallId);
  assert.ok(eventFull);
  const nonNativeEvent = publicResolvedCallEvent({
    full: eventFull,
    agent,
  });
  assert.ok(nonNativeEvent);
  assert.equal(nonNativeEvent.adapter_id, "polymarket-gamma");
  assert.equal(nonNativeEvent.market_family, "prediction-market-binary");
  assert.equal(nonNativeEvent.market_id, eventMarketId);
  assert.equal("signed_return" in nonNativeEvent, false);
  assert.deepEqual(nonNativeEvent.payout_vector, ["0", "1"]);

  const acceptedEvent = publicAcceptedCallEvent({
    db,
    call_id: eventCallId,
    agent_id: agentId,
    accepted_at: acceptedAt,
    commit_hash: "c".repeat(64),
    market: eventMarket,
  });
  assert.equal(acceptedEvent.type, "call.accepted");
  assert.equal(acceptedEvent.agent_slug, "fanout-smoke");
  assert.equal(acceptedEvent.privacy_mode, "sealed_fhenix");
  assert.equal(acceptedEvent.adapter_id, "polymarket-gamma");
  assert.equal(acceptedEvent.market_family, "prediction-market-binary");
  assert.equal(acceptedEvent.market_id, eventMarketId);
  assert.equal("side" in acceptedEvent, false);
  assert.equal("confidence" in acceptedEvent, false);

  const snapshot = publicLeaderboardUpdateEvent({
    db,
    servedAt: new Date("2026-05-17T12:00:00Z"),
    limit: 20,
  });
  assert.equal(snapshot.type, "leaderboard.update");
  assert.equal(snapshot.served_at, "2026-05-17T12:00:00Z");
  assert.ok(snapshot.rows.some((row) => row.display_slug === "fanout-smoke"));
  assert.equal("verdict_score_lb" in snapshot.rows[0], false);

  const marketSnapshot = publicMarketsUpdateEvent({
    db,
    market_id: eventMarketId,
    servedAt: new Date("2026-05-17T12:01:00Z"),
    limit: 5,
  });
  assert.equal(marketSnapshot.type, "markets.update");
  assert.equal(marketSnapshot.market_id, eventMarketId);
  assert.equal(marketSnapshot.served_at, "2026-05-17T12:01:00Z");
  const marketRow = marketSnapshot.agents.find(
    (row) => row.display_slug === "fanout-smoke",
  );
  assert.ok(marketRow);
  assert.equal(marketRow.market_id, eventMarketId);
  assert.equal("verdict_score_lb" in marketRow, false);
  assert.equal("last_resolved_at" in marketRow, false);
  // Lean wire row carries no REST-only sparkline series either — the
  // dashboard fold projects these as absent (MarketDetailPage / MarketsGrid).
  assert.equal("call_scores" in marketRow, false);

  const webhookEvent = publicWebhookFanoutEvent(nonNativeEvent);
  assert.ok(webhookEvent);
  assert.equal(webhookEvent.agent_slug, "fanout-smoke");
  assert.equal(webhookEvent.event.type, "call.resolved");
  const acceptedWebhookEvent = publicWebhookFanoutEvent(acceptedEvent);
  assert.ok(acceptedWebhookEvent);
  assert.equal(acceptedWebhookEvent.event.type, "call.accepted");
  assert.equal(publicWebhookFanoutEvent(snapshot), null);
  assert.equal(publicWebhookFanoutEvent(marketSnapshot), null);

  const fanoutEvents = publicResolutionFanoutEvents({
    db,
    call_id: eventCallId,
    servedAt: new Date("2026-05-17T12:02:00Z"),
  });
  assert.deepEqual(fanoutEvents.map((event) => event.type), [
    "call.resolved",
    "leaderboard.update",
    "markets.update",
  ]);
  const fanoutResolved = fanoutEvents[0];
  assert.equal(fanoutResolved?.type, "call.resolved");
  if (fanoutResolved?.type !== "call.resolved") {
    throw new Error("expected call.resolved fanout event");
  }
  assert.equal(fanoutResolved.market_id, eventMarketId);

  const fanoutLeaderboard = fanoutEvents[1];
  assert.equal(fanoutLeaderboard?.type, "leaderboard.update");
  if (fanoutLeaderboard?.type !== "leaderboard.update") {
    throw new Error("expected leaderboard.update fanout event");
  }
  assert.equal(fanoutLeaderboard.served_at, "2026-05-17T12:02:00Z");

  const fanoutMarket = fanoutEvents[2];
  assert.equal(fanoutMarket?.type, "markets.update");
  if (fanoutMarket?.type !== "markets.update") {
    throw new Error("expected markets.update fanout event");
  }
  assert.equal(fanoutMarket.market_id, eventMarketId);
  assert.equal(fanoutMarket.served_at, "2026-05-17T12:02:00Z");

  assert.deepEqual(
    publicResolutionFanoutEvents({
      db,
      call_id: randomUUID(),
      servedAt: new Date("2026-05-17T12:03:00Z"),
    }),
    [],
  );

  const bus = new VerdictEventBus();
  const emitted: VerdictEvent[] = [];
  const unsubscribe = bus.subscribe((event) => emitted.push(event));
  await createResolutionFanout({
    db,
    events: bus,
    now: () => new Date("2026-05-17T12:04:00Z"),
  })(eventCallId);
  unsubscribe();
  assert.deepEqual(emitted.map((event) => event.type), [
    "call.resolved",
    "leaderboard.update",
    "markets.update",
  ]);
  const emittedLeaderboard = emitted[1];
  assert.equal(emittedLeaderboard?.type, "leaderboard.update");
  if (emittedLeaderboard?.type !== "leaderboard.update") {
    throw new Error("expected emitted leaderboard.update event");
  }
  assert.equal(emittedLeaderboard.served_at, "2026-05-17T12:04:00Z");

  db.close();
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

process.stdout.write("public event fanout smoke ok\n");
