import { strict as assert } from "node:assert";

import {
  PolymarketClobClient,
  PolymarketGammaClient,
  polymarketGammaAdapter,
  setDefaultPolymarketClient,
  type GammaMarketSnapshot,
} from "./index.js";

const conditionId = `0x${"12".repeat(32)}`;
const marketRef = {
  protocol: "polymarket-gamma",
  sourceId: conditionId,
  configVersion: 1,
};
const context = {
  conditionId,
  market_id: conditionId,
};

setDefaultPolymarketClient(null);
const unconfiguredErrors: string[] = [];
assert.equal(
  await polymarketGammaAdapter.observeResolution(marketRef, {
    ...context,
    onError: (code: string) => unconfiguredErrors.push(code),
  }),
  "pending",
);
assert.deepEqual(unconfiguredErrors, ["polymarket_client_unconfigured"]);

let nowMsCalls = 0;
const snapshot: GammaMarketSnapshot = {
  conditionId,
  slug: "polymarket-adapter-smoke",
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
setDefaultPolymarketClient(new PolymarketGammaClient({
  fetchFn: async () => ({
    ok: true,
    status: 200,
    headers: { get: () => "application/json" },
    text: async () => JSON.stringify([snapshot]),
  }),
  maxRetries: 1,
  nowMs: () => {
    nowMsCalls += 1;
    return Date.parse("2026-06-13T00:01:00Z");
  },
  sleepMs: async () => undefined,
}));
try {
  const resolved = await polymarketGammaAdapter.observeResolution(marketRef, context);
  if (resolved === "pending" || resolved === "disputed") {
    throw new Error(`expected binary outcome, got ${resolved}`);
  }
  assert.equal(resolved.kind, "binary");
  assert.equal(nowMsCalls > 0, true);
} finally {
  setDefaultPolymarketClient(null);
}

// ─── CLOB fallback (Gamma dropped the market after close) ──────────────────

const emptyGammaClient = () =>
  new PolymarketGammaClient({
    fetchFn: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      text: async () => JSON.stringify([]),
    }),
    maxRetries: 1,
    nowMs: () => Date.parse("2026-06-13T00:10:00Z"),
    sleepMs: async () => undefined,
  });
const clobSnapshotBody = {
  condition_id: conditionId,
  question: "Bitcoin Up or Down - smoke window",
  closed: true,
  archived: false,
  accepting_orders: false,
  is_50_50_outcome: false,
  tokens: [
    { token_id: "222", outcome: "NO", price: 1, winner: true },
    { token_id: "111", outcome: "yes", price: 0, winner: false },
  ],
};
const fallbackContext = {
  ...context,
  endDate: "2026-06-13T00:00:00Z",
  outcomes: ["Yes", "No"],
  nowMs: () => Date.parse("2026-06-13T00:10:00Z"),
};

// Pre-end Gamma failure must NOT touch CLOB.
{
  let clobFetches = 0;
  const clobClient = new PolymarketClobClient({
    fetchFn: async () => {
      clobFetches += 1;
      throw new Error("clob must not be called before endDate");
    },
    maxRetries: 1,
    nowMs: () => Date.parse("2026-06-13T00:10:00Z"),
    sleepMs: async () => undefined,
  });
  const preEnd = await polymarketGammaAdapter.observeResolution(marketRef, {
    ...fallbackContext,
    client: emptyGammaClient(),
    clobClient,
    endDate: "2026-06-14T00:00:00Z", // still in the future
  });
  assert.equal(preEnd, "pending");
  assert.equal(clobFetches, 0);
}

// Post-end Gamma [] + CLOB winner → binary outcome via the fallback,
// numerators aligned to the STORED outcomes order despite the reordered,
// case-varied CLOB tokens.
{
  const errors: string[] = [];
  const clobClient = new PolymarketClobClient({
    fetchFn: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      text: async () => JSON.stringify(clobSnapshotBody),
    }),
    maxRetries: 1,
    nowMs: () => Date.parse("2026-06-13T00:10:00Z"),
    sleepMs: async () => undefined,
  });
  const resolved = await polymarketGammaAdapter.observeResolution(marketRef, {
    ...fallbackContext,
    client: emptyGammaClient(),
    clobClient,
    onError: (code: string) => errors.push(code),
  });
  if (resolved === "pending" || resolved === "disputed") {
    throw new Error(`expected CLOB fallback outcome, got ${resolved}`);
  }
  assert.equal(resolved.kind, "binary");
  assert.deepEqual(resolved.payoutNumerators, [0n, 1n]); // No wins
  assert.equal(resolved.payoutDenominator, 1n);
  assert.equal(resolved.evidence.sourceProtocol, "polymarket-clob-fallback");
  assert.equal(resolved.resolvedAt, Math.floor(Date.parse("2026-06-13T00:00:00Z") / 1000));
  assert.deepEqual(errors, ["http_404"]); // Gamma's [] — CLOB itself was clean
}

// CLOB failure (network) stays pending with an error-coded log line.
{
  const errors: string[] = [];
  const clobClient = new PolymarketClobClient({
    fetchFn: async () => {
      throw new Error("connection refused");
    },
    maxRetries: 1,
    nowMs: () => Date.parse("2026-06-13T00:10:00Z"),
    sleepMs: async () => undefined,
  });
  const stillPending = await polymarketGammaAdapter.observeResolution(marketRef, {
    ...fallbackContext,
    client: emptyGammaClient(),
    clobClient,
    onError: (code: string) => errors.push(code),
  });
  assert.equal(stillPending, "pending");
  assert.deepEqual(errors, ["http_404", "clob:network:connection refused"]);
}

console.log("polymarket-gamma adapter smoke ok");
