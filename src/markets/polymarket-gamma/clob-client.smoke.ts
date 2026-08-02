import { strict as assert } from "node:assert";

import {
  PolymarketClobClient,
  type ClobMarketSnapshot,
} from "./clob-client.js";
import type { PolymarketGammaTimers } from "./client.js";

process.stdout.write("murmur Polymarket CLOB client smoke\n");

const conditionId = `0x${"34".repeat(32)}`;
const snapshotBody = {
  condition_id: conditionId,
  question: "Bitcoin Up or Down - smoke window",
  closed: true,
  archived: false,
  accepting_orders: false,
  end_date_iso: "2026-06-13T00:00:00Z",
  is_50_50_outcome: false,
  tokens: [
    { token_id: "111", outcome: "Up", price: 0, winner: false },
    { token_id: "222", outcome: "Down", price: 1, winner: true },
  ],
  future_field: "passthrough survives",
};

type TimerHandle = { callback: () => void; ms: number };
const timerHandles: TimerHandle[] = [];
const clearedTimers: TimerHandle[] = [];
const timers: PolymarketGammaTimers = {
  setTimeout(callback, ms) {
    const handle = { callback, ms };
    timerHandles.push(handle);
    return handle;
  },
  clearTimeout(handle) {
    clearedTimers.push(handle as TimerHandle);
  },
};

// ── valid response + timeout/retry (default policy: 2s timeout, 1 retry) ──
const sleeps: number[] = [];
let fetchCalls = 0;
const requestedUrls: string[] = [];
const client = new PolymarketClobClient({
  baseUrl: "https://clob.example",
  fetchFn: async (url, init) => {
    fetchCalls += 1;
    requestedUrls.push(url);
    if (fetchCalls === 1) {
      timerHandles[timerHandles.length - 1]?.callback();
      assert.equal(init?.signal?.aborted, true);
      throw new Error("abort");
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      text: async () => JSON.stringify(snapshotBody),
    };
  },
  nowMs: () => Date.parse("2026-06-13T00:01:00Z"),
  retryJitterMs: () => 7,
  sleepMs: async (ms) => {
    sleeps.push(ms);
  },
  timers,
});

const result = await client.fetchMarketByConditionId(conditionId.toUpperCase());
assert.equal(result.source, "fresh");
assert.equal(result.error, null);
assert.equal(result.snapshot?.condition_id, conditionId);
assert.equal(
  (result.snapshot as ClobMarketSnapshot & { future_field?: unknown })
    .future_field,
  "passthrough survives",
);
assert.equal(fetchCalls, 2); // 1 timeout + 1 retry succeeds
assert.deepEqual(sleeps, [207]);
assert.deepEqual(timerHandles.map((handle) => handle.ms), [2_000, 2_000]);
assert.deepEqual(clearedTimers, timerHandles);
assert.deepEqual(requestedUrls, [
  `https://clob.example/markets/${conditionId.toLowerCase()}`,
  `https://clob.example/markets/${conditionId.toLowerCase()}`,
]);

// ── LRU cache: terminal snapshot served without another fetch ──
const cached = await client.fetchMarketByConditionId(conditionId);
assert.equal(cached.source, "lru");
assert.equal(cached.snapshot?.condition_id, conditionId);
assert.equal(fetchCalls, 2);

// ── single-flight: concurrent misses share one request ──
let singleFlightFetches = 0;
let releaseFetch!: () => void;
const gate = new Promise<void>((resolve) => {
  releaseFetch = resolve;
});
const singleFlightClient = new PolymarketClobClient({
  fetchFn: async () => {
    singleFlightFetches += 1;
    await gate;
    return {
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      text: async () => JSON.stringify(snapshotBody),
    };
  },
  nowMs: () => Date.parse("2026-06-13T00:01:00Z"),
  timers,
});
const inflightA = singleFlightClient.fetchMarketByConditionId(conditionId);
const inflightB = singleFlightClient.fetchMarketByConditionId(conditionId);
releaseFetch();
const [flightA, flightB] = await Promise.all([inflightA, inflightB]);
assert.equal(singleFlightFetches, 1);
assert.equal(flightA.snapshot?.condition_id, conditionId);
assert.equal(flightB.snapshot?.condition_id, conditionId);

// ── condition mismatch is schema drift, never accepted ──
const wrongConditionId = `0x${"56".repeat(32)}`;
const mismatchClient = new PolymarketClobClient({
  fetchFn: async () => ({
    ok: true,
    status: 200,
    headers: { get: () => "application/json" },
    text: async () =>
      JSON.stringify({ ...snapshotBody, condition_id: wrongConditionId }),
  }),
  maxRetries: 1,
  nowMs: () => Date.parse("2026-06-13T00:01:00Z"),
  timers,
});
const mismatch = await mismatchClient.fetchMarketByConditionId(conditionId);
assert.equal(mismatch.snapshot, null);
assert.equal(mismatch.error, "schema_drift:condition_id_mismatch");

// ── schema drift: missing tokens array ──
const driftClient = new PolymarketClobClient({
  fetchFn: async () => ({
    ok: true,
    status: 200,
    headers: { get: () => "application/json" },
    text: async () =>
      JSON.stringify({ condition_id: conditionId, closed: true }),
  }),
  maxRetries: 1,
  nowMs: () => Date.parse("2026-06-13T00:01:00Z"),
  timers,
});
const drift = await driftClient.fetchMarketByConditionId(conditionId);
assert.equal(drift.snapshot, null);
assert.match(drift.error ?? "", /^schema_drift:/);

// ── 404 → negative cache, then negative-cache hit without a fetch ──
let notFoundFetches = 0;
const notFoundClient = new PolymarketClobClient({
  fetchFn: async () => {
    notFoundFetches += 1;
    return {
      ok: false,
      status: 404,
      headers: { get: () => "application/json" },
      text: async () => "",
    };
  },
  maxRetries: 1,
  nowMs: () => Date.parse("2026-06-13T00:01:00Z"),
  timers,
});
const notFound = await notFoundClient.fetchMarketByConditionId(conditionId);
assert.equal(notFound.snapshot, null);
assert.equal(notFound.error, "http_404");
assert.equal(notFoundFetches, 1);
const negativeHit = await notFoundClient.fetchMarketByConditionId(conditionId);
assert.equal(negativeHit.source, "negative_cache");
assert.equal(negativeHit.error, "negative_cache_hit");
assert.equal(notFoundFetches, 1);

// ── circuit breaker: 5 transport failures open it for 60s ──
let breakerNowMs = Date.parse("2026-06-13T00:01:00Z");
let breakerFetches = 0;
const breakerClient = new PolymarketClobClient({
  fetchFn: async () => {
    breakerFetches += 1;
    throw new Error("network down");
  },
  maxRetries: 1,
  nowMs: () => breakerNowMs,
  sleepMs: async () => undefined,
  timers,
});
for (let i = 0; i < 5; i++) {
  const failed = await breakerClient.fetchMarketByConditionId(
    `0x${String(i).repeat(64)}`,
  );
  assert.equal(failed.snapshot, null);
  assert.match(failed.error ?? "", /^network:/);
}
assert.equal(breakerFetches, 5);
const shortCircuited = await breakerClient.fetchMarketByConditionId(
  `0x${"9".repeat(64)}`,
);
assert.equal(shortCircuited.source, "circuit_open");
assert.equal(shortCircuited.error, "circuit_open");
assert.equal(breakerFetches, 5); // no network call while open
breakerNowMs += 61_000; // breaker window elapsed → half-open attempt
const retried = await breakerClient.fetchMarketByConditionId(
  `0x${"9".repeat(64)}`,
);
assert.match(retried.error ?? "", /^network:/);
assert.equal(breakerFetches, 6);

process.stdout.write("Polymarket CLOB client smoke ok\n");
