import { strict as assert } from "node:assert";

import {
  PolymarketGammaClient,
  type PolymarketGammaTimers,
} from "./client.js";
import type { GammaMarketSnapshot } from "./transform.js";

process.stdout.write("murmur Polymarket Gamma client smoke\n");

const conditionId = `0x${"34".repeat(32)}`;
const snapshot: GammaMarketSnapshot = {
  conditionId,
  slug: "gamma-client-smoke",
  outcomes: JSON.stringify(["Yes", "No"]),
  outcomePrices: JSON.stringify(["1", "0"]),
  umaResolutionStatus: "resolved",
  umaResolutionStatuses: JSON.stringify(["resolved"]),
  closed: true,
  active: false,
  archived: false,
  endDate: "2026-06-13T00:00:00Z",
  closedTime: "2026-06-13T00:00:00Z",
};

type TimerHandle = {
  callback: () => void;
  ms: number;
};

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

const sleeps: number[] = [];
const jitter = [7, 11];
let fetchCalls = 0;
const requestedUrls: string[] = [];
const client = new PolymarketGammaClient({
  baseUrl: "https://gamma.example",
  fetchFn: async (url, init) => {
    fetchCalls += 1;
    requestedUrls.push(url);

    if (fetchCalls === 1) {
      timerHandles[timerHandles.length - 1]?.callback();
      assert.equal(init?.signal?.aborted, true);
      throw new Error("abort");
    }

    if (fetchCalls === 2) {
      return {
        ok: false,
        status: 503,
        headers: { get: () => "application/json" },
        text: async () => "",
      };
    }

    return {
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      text: async () => JSON.stringify([snapshot]),
    };
  },
  maxRetries: 3,
  nowMs: () => Date.parse("2026-06-13T00:01:00Z"),
  retryJitterMs: () => jitter.shift() ?? 0,
  sleepMs: async (ms) => {
    sleeps.push(ms);
  },
  timeoutMs: 1_234,
  timers,
});

const result = await client.fetchMarketByConditionId(conditionId.toUpperCase());
assert.equal(result.source, "fresh");
assert.equal(result.error, null);
assert.equal(result.snapshot?.conditionId, conditionId);
assert.deepEqual(sleeps, [207, 411]);
assert.equal(fetchCalls, 3);
assert.deepEqual(timerHandles.map((handle) => handle.ms), [1_234, 1_234, 1_234]);
assert.deepEqual(clearedTimers, timerHandles);
assert.deepEqual(requestedUrls, [
  `https://gamma.example/markets?condition_ids=${encodeURIComponent(conditionId.toLowerCase())}&limit=1`,
  `https://gamma.example/markets?condition_ids=${encodeURIComponent(conditionId.toLowerCase())}&limit=1`,
  `https://gamma.example/markets?condition_ids=${encodeURIComponent(conditionId.toLowerCase())}&limit=1`,
]);

const cached = await client.fetchMarketByConditionId(conditionId);
assert.equal(cached.source, "lru");
assert.equal(cached.snapshot?.conditionId, conditionId);
assert.equal(fetchCalls, 3);

const wrongConditionId = `0x${"56".repeat(32)}`;
const mismatchClient = new PolymarketGammaClient({
  fetchFn: async () => ({
    ok: true,
    status: 200,
    headers: { get: () => "application/json" },
    text: async () => JSON.stringify([{ ...snapshot, conditionId: wrongConditionId }]),
  }),
  maxRetries: 1,
  nowMs: () => Date.parse("2026-06-13T00:01:00Z"),
  timers,
});
const mismatch = await mismatchClient.fetchMarketByConditionId(conditionId);
assert.equal(mismatch.snapshot, null);
assert.equal(mismatch.error, "schema_drift:condition_id_mismatch");

const matchingRowClient = new PolymarketGammaClient({
  fetchFn: async () => ({
    ok: true,
    status: 200,
    headers: { get: () => "application/json" },
    text: async () => JSON.stringify([
      { ...snapshot, conditionId: wrongConditionId },
      { ...snapshot, conditionId: conditionId.toUpperCase() },
    ]),
  }),
  maxRetries: 1,
  nowMs: () => Date.parse("2026-06-13T00:01:00Z"),
  timers,
});
const matchingRow = await matchingRowClient.fetchMarketByConditionId(conditionId);
assert.equal(matchingRow.error, null);
assert.equal(matchingRow.snapshot?.conditionId, conditionId.toUpperCase());

process.stdout.write("Polymarket Gamma client smoke ok\n");
