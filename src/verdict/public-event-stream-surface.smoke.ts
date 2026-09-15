import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { agentsRepo, marketsRepo, submissionsRepo, resolutionsRepo, openDb } from "./db.js";
import { providerPayoutsRepo } from "./repos/provider-payouts-repo.js";
import { VerdictEventBus } from "./events.js";
import {
  openPublicEventStream,
  PUBLIC_EVENT_STREAM_UNAVAILABLE_BODY,
  type PublicEventStreamRequest,
  type PublicEventStreamResponse,
} from "./public-event-stream-surface.js";

process.stdout.write("murmur public event stream surface smoke\n");

class FakeRequest implements PublicEventStreamRequest {
  private readonly handlers = new Map<"close" | "error", Array<() => void>>();

  on(event: "close" | "error", handler: () => void): FakeRequest {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
    return this;
  }

  emit(event: "close" | "error"): void {
    for (const handler of this.handlers.get(event) ?? []) {
      handler();
    }
  }
}

class FakeResponse implements PublicEventStreamResponse {
  statusCode = 200;
  body: unknown;
  flushed = false;
  endCount = 0;
  readonly headers = new Map<string, string>();
  readonly chunks: string[] = [];

  status(code: number): FakeResponse {
    this.statusCode = code;
    return this;
  }

  json(body: unknown): void {
    this.body = body;
  }

  setHeader(name: string, value: string): void {
    this.headers.set(name, value);
  }

  flushHeaders(): void {
    this.flushed = true;
  }

  write(chunk: string): void {
    this.chunks.push(chunk);
  }

  end(): void {
    this.endCount += 1;
  }
}

interface FakeTimer {
  handler: () => void;
  ms: number;
  cleared: boolean;
}

const tmp = mkdtempSync(join(tmpdir(), "murmur-public-event-stream-"));
const dbPath = join(tmp, "test.db");

try {
  const db = openDb({ path: dbPath });

  const unavailableRes = new FakeResponse();
  const unavailable = openPublicEventStream(new FakeRequest(), unavailableRes, {
    db,
    now: () => new Date("2026-05-27T10:00:00Z"),
  });
  assert.equal(unavailable.status, 503);
  assert.equal(unavailableRes.statusCode, 503);
  assert.deepEqual(unavailableRes.body, PUBLIC_EVENT_STREAM_UNAVAILABLE_BODY);

  agentsRepo.insert(db, {
    agent_id: "replay-agent", display_slug: "replay-agent", kind: "agent",
    display_name: "Replay Agent", bio: "", created_at: "2026-05-27T09:00:00Z",
  });
  // Record strip: benchmark excluded, deleted agent still counted, USDC net exact past 2^53.
  agentsRepo.insert(db, {
    agent_id: "bench-agent", display_slug: "bench-agent", kind: "benchmark",
    display_name: "Bench", bio: "", created_at: "2026-05-27T09:00:00Z",
  });
  agentsRepo.insert(db, {
    agent_id: "gone-agent", display_slug: "gone-agent", kind: "agent",
    display_name: "Gone", bio: "", created_at: "2026-05-27T09:00:00Z",
  });
  db.prepare("UPDATE agents SET deleted_at = ? WHERE agent_id = ?").run("2026-05-27T09:30:00Z", "gone-agent");
  for (const [entry_type, amount_atoms] of [["payout", "9007199254740993"], ["reversal", "1"]] as const) {
    providerPayoutsRepo.insert(db, {
      producer_agent_id: "replay-agent", entry_type, currency: "USDC", amount_atoms,
      tx_ref: entry_type, payout_method: "manual", destination_ref: "0xdest", note: null,
      earnings_cutoff_at: "2026-05-27T09:00:00Z", created_at: "2026-05-27T09:00:00Z",
    });
  }
  marketsRepo.upsertExternalMarket(db, {
    market_id: "replay-market", asset_id: "polymarket:event", market_kind: "event_binary",
    horizon_seconds: 3600, primary_oracle_id: "polymarket-gamma-oracle",
    adapter_id: "polymarket-gamma", market_family: "prediction-market-binary",
    scoring_kind: "multinomial_brier", config_json: "{}", void_band: "0",
    status: "listed", created_at: "2026-05-27T09:00:00Z",
  });
  submissionsRepo.acceptSealedFhenixCall(db, {
    call_id: "replay-call", agent_id: "replay-agent", client_order_id: "replay",
    horizon_seconds: 3600, submitted_at: "2026-05-27T09:00:00Z",
    accepted_at: "2026-05-27T09:00:00Z", schema_version: 1, scoring_version: 1,
    dedup_key: "replay", commit_hash: "a".repeat(64), commit_scheme: "fhenix-sealed-v1",
    market_id: "replay-market", market_config_version: 1,
    adapter_id: "native-price", market_family: "financial-direction",
  });
  resolutionsRepo.setResolution(db, {
    call_id: "replay-call", t1: "2026-05-27T09:59:00Z", p1: null,
    t1_feed: null, signed_return: null, outcome: "win", call_score: 1,
    resolved_at: "2026-05-27T09:59:00Z",
  });
  const bus = new VerdictEventBus();
  const req = new FakeRequest();
  const res = new FakeResponse();
  const timers: FakeTimer[] = [];
  const opened = openPublicEventStream(req, res, {
    db,
    events: bus,
    now: () => new Date("2026-05-27T10:00:00Z"),
    heartbeatMs: 123,
    setInterval: (handler, ms) => {
      const timer = { handler, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearInterval: (handle) => {
      (handle as FakeTimer).cleared = true;
    },
  });

  assert.equal(opened.status, 200);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers.get("Content-Type"), "text/event-stream");
  assert.equal(res.headers.get("Cache-Control"), "no-cache, no-transform");
  assert.equal(res.headers.get("Connection"), "keep-alive");
  assert.equal(res.headers.get("X-Accel-Buffering"), "no");
  assert.equal(res.flushed, true);
  assert.equal(timers.length, 1);
  assert.equal(timers[0]?.ms, 123);
  assert.match(res.chunks.join(""), /event: leaderboard\.update\n/);
  assert.match(res.chunks.join(""), /"served_at":"2026-05-27T10:00:00Z"/);

  const frames = res.chunks.filter((chunk) => chunk.startsWith("data: "))
    .map((chunk) => JSON.parse(chunk.slice(6)));
  const replay = frames.filter((event) => event.call_id === "replay-call");
  assert.deepEqual(replay.map((event) => event.type), ["call.accepted", "call.resolved"]);
  assert.equal(replay[0].privacy_mode, "sealed_fhenix");
  for (const event of replay) {
    for (const field of ["rationale", "confidence", "binary_index", "side"]) {
      assert.equal(field in event, false);
    }
  }
  const statsFrame = frames.find((event) => event.type === "stats.tick");
  assert.equal(statsFrame.accepted_24h, 1);
  assert.equal(statsFrame.agents_registered, 2);
  assert.equal(statsFrame.calls_sealed, 1);
  assert.equal(statsFrame.provider_paid_usdc_atoms, "9007199254740992");

  bus.emit({
    type: "stats.tick",
    served_at: "2026-05-27T10:00:05Z",
    accepted_24h: 1,
    resolved_24h: 2,
    wins_24h: 1,
    losses_24h: 1,
    void_24h: 0,
    provider_paid_usdc_atoms: "0",
    agents_registered: 1,
    calls_sealed: 1,
  });
  assert.match(res.chunks.join(""), /event: stats\.tick\n/);
  assert.match(res.chunks.join(""), /"accepted_24h":1/);

  timers[0]?.handler();
  assert.equal(res.chunks.at(-1), ": heartbeat\n\n");

  req.emit("close");
  assert.equal(timers[0]?.cleared, true);
  assert.equal(res.endCount, 1);
  assert.equal(bus.subscriberCount(), 0);

  const chunkCountAfterClose = res.chunks.length;
  bus.emit({
    type: "stats.tick",
    served_at: "2026-05-27T10:00:10Z",
    accepted_24h: 9,
    resolved_24h: 9,
    wins_24h: 9,
    losses_24h: 0,
    void_24h: 0,
    provider_paid_usdc_atoms: "0",
    agents_registered: 1,
    calls_sealed: 1,
  });
  assert.equal(res.chunks.length, chunkCountAfterClose);

  req.emit("error");
  assert.equal(res.endCount, 1);
  if (opened.status === 200) opened.close();
  assert.equal(res.endCount, 1);

  db.close();
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

process.stdout.write("  ok stream headers, frames, heartbeat, and cleanup stay together\n");
