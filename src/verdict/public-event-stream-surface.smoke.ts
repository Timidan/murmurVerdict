import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb } from "./db.js";
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

  bus.emit({
    type: "stats.tick",
    served_at: "2026-05-27T10:00:05Z",
    accepted_24h: 1,
    resolved_24h: 2,
    wins_24h: 1,
    losses_24h: 1,
    void_24h: 0,
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
