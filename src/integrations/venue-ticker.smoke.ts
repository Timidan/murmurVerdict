// ─── Venue ticker smoke ─────────────────────────────────────────────────────
// Drives the real `ws` client against a local server replaying frames captured
// from the live Polymarket CLOB feed (2026-08-10). Pins:
//   · the tracked-set predicate (frozen lookback, operator-halt exclusion,
//     horizon bound) and the token-signature reconnect
//   · per-outcome quotes — both tokens independently, never 1 − the other
//   · coalescing: a burst of frames yields ONE batched SSE tick
//   · resolution through the pure transforms, Gamma first and the read-only
//     CLOB fallback when Gamma has dropped the closed micro-market
//   · venue_resolution is emitted once per market and is idempotent
//   · snapshot validation, dedupe, cap, and unknown-id answers
//   · stop() releases everything — this file must exit without a force kill

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";

import { openDb } from "../verdict/db.js";
import {
  VenueTicker,
  parseTrackedRow,
  probabilityField,
  trackedSignature,
  venueTimestampMs,
  type VenueMarketRow,
  type VenueTickerEvent,
} from "./venue-ticker.js";
import {
  normalizeMarketParam,
  openVenueStream,
  venueLiveSnapshot,
  venueTickerRouter,
  VENUE_INVALID_MARKET_BODY,
  VENUE_TICKER_UNAVAILABLE_BODY,
  type VenueStreamRequest,
  type VenueStreamResponse,
} from "./venue-ticker-surface.js";

process.stdout.write("murmur venue ticker smoke\n");

// ─── Recorded live frames (Polymarket CLOB, 2026-08-10T04:31Z) ─────────────

const BTC_CONDITION =
  "0xbf971f1b40adc01ce7a420a905face0329339e85662e516e4faf96f748f183c5";
const BTC_UP =
  "110946410287651036771158071377916013486318949090801145861604461568038530925703";
const BTC_DOWN =
  "33213640639388414224334472767399839721593553019418308983577726325454127865259";

/** Verified: the initial answer is an ARRAY with one `book` per asset. */
const RECORDED_BOOK = [
  {
    market: BTC_CONDITION,
    asset_id: BTC_DOWN,
    timestamp: "1786336279819",
    hash: "c0998bd16b82622a3ad6b1ec9022c733dc612549",
    bids: [
      { price: "0.47", size: "453.91" },
      { price: "0.48", size: "156.87" },
      { price: "0.49", size: "299.97" },
    ],
    asks: [
      { price: "0.52", size: "156.87" },
      { price: "0.51", size: "114.74" },
      { price: "0.5", size: "298.05" },
    ],
    tick_size: "0.01",
    event_type: "book",
    last_trade_price: "0.500",
  },
  {
    market: BTC_CONDITION,
    asset_id: BTC_UP,
    timestamp: "1786336279819",
    hash: "5ceb9f390cf388e510931d80944f455d443e165e",
    bids: [
      { price: "0.48", size: "156.87" },
      { price: "0.49", size: "114.74" },
      { price: "0.5", size: "298.05" },
    ],
    asks: [
      { price: "0.53", size: "453.91" },
      { price: "0.52", size: "156.87" },
      { price: "0.51", size: "299.97" },
    ],
    tick_size: "0.01",
    event_type: "book",
    last_trade_price: "0.500",
  },
];

/** Verified: a single OBJECT batching both sides of one market. */
const RECORDED_PRICE_CHANGE = {
  market: BTC_CONDITION,
  price_changes: [
    {
      asset_id: BTC_UP,
      price: "0.47",
      size: "477.91",
      side: "BUY",
      hash: "900529d1d301f5d4777b6be46af59165fb806542",
      best_bid: "0.62",
      best_ask: "0.64",
    },
    {
      asset_id: BTC_DOWN,
      price: "0.53",
      size: "477.91",
      side: "SELL",
      hash: "710f8fa0b0ca9ef105ff91370534450d9e6a62b5",
      best_bid: "0.30",
      best_ask: "0.34",
    },
  ],
  timestamp: "1786336381198",
  event_type: "price_change",
};

const RECORDED_LAST_TRADE = {
  market: BTC_CONDITION,
  asset_id: BTC_UP,
  price: "0.51",
  size: "9.80392",
  fee_rate_bps: "0",
  side: "BUY",
  timestamp: "1786336507696",
  event_type: "last_trade_price",
  transaction_hash:
    "0x3fdf09e02ce9ca4e0bfac8befb0b9d5c0bae791cfa061a49ddb5087703713b86",
};

// ─── Fixtures ───────────────────────────────────────────────────────────────

const NOW_MS = Date.parse("2026-08-10T04:40:00.000Z");
let clockMs = NOW_MS;
const nowMs = (): number => clockMs;

const tmp = mkdtempSync(join(tmpdir(), "murmur-venue-ticker-"));
const db = openDb({ path: join(tmp, "venue.db") });

interface SeedMarket {
  id: string;
  status: "listed" | "frozen" | "retired" | "draft";
  resolutionAtMs: number;
  adapter?: string;
  halted?: boolean;
  config?: Record<string, unknown>;
}

function config(
  conditionId: string,
  upToken: string,
  downToken: string,
): Record<string, unknown> {
  return {
    conditionId,
    slug: "btc-updown-5m-1786336800",
    outcomes: ["Up", "Down"],
    // Verified shape: a normalized-label → tokenId OBJECT, not an array.
    clobTokenIds: { up: upToken, down: downToken },
    endDate: "2026-08-10T04:45:00Z",
    gamma_url: "https://polymarket.com/event/btc-updown-5m-1786336800",
  };
}

function conditionFor(index: number): string {
  return `0x${index.toString(16).padStart(64, "0")}`;
}

function seed(markets: SeedMarket[]): void {
  db.pragma("foreign_keys = OFF");
  db.prepare("DELETE FROM market_clocks").run();
  db.prepare("DELETE FROM markets").run();
  const iso = new Date(NOW_MS).toISOString();
  for (const market of markets) {
    db.prepare(
      `INSERT INTO markets (market_id, asset_id, horizon_seconds, primary_oracle_id,
         primary_max_staleness_sec, t0_grace_seconds, t0_extended_grace_seconds,
         void_band, created_at, status, adapter_id, config_json, operator_halted_at)
       VALUES (@id, 'asset-1', 300, 'oracle-1', 60, 30, 60, '0', @now,
         @status, @adapter, @config, @halted)`,
    ).run({
      id: market.id,
      now: iso,
      status: market.status,
      adapter: market.adapter ?? "polymarket-gamma",
      config: JSON.stringify(
        market.config ?? config(market.id, `${market.id}-up`, `${market.id}-down`),
      ),
      halted: market.halted === true ? iso : null,
    });
    db.prepare(
      `INSERT INTO market_clocks (market_id, series_id, arm_close_at_ms,
         submission_open_at_ms, early_access_cutoff_at_ms, submission_close_at_ms,
         resolution_at_ms, public_reveal_at_ms, derived_from_end_date_ms, created_at)
       VALUES (@id, 'series-1', @arm, @open, @cutoff, @close, @resolution,
         @reveal, @resolution, @now)`,
    ).run({
      id: market.id,
      arm: market.resolutionAtMs - 500_000,
      open: market.resolutionAtMs - 400_000,
      cutoff: market.resolutionAtMs - 300_000,
      close: market.resolutionAtMs - 1,
      resolution: market.resolutionAtMs,
      reveal: market.resolutionAtMs + 600_000,
      now: iso,
    });
  }
}

const MIN = 60_000;
const HOUR = 60 * MIN;

// ─── 1. Pure config parsing ────────────────────────────────────────────────

{
  const good = parseTrackedRow({
    market_id: BTC_CONDITION,
    config_json: JSON.stringify(config(BTC_CONDITION, BTC_UP, BTC_DOWN)),
    resolution_at_ms: NOW_MS,
  });
  assert.ok(good, "valid config parses");
  assert.deepEqual(
    good.outcomes,
    [
      { label: "Up", tokenId: BTC_UP },
      { label: "Down", tokenId: BTC_DOWN },
    ],
    "token ids resolve through the normalized-label map, in stored order",
  );
  assert.equal(good.conditionId, BTC_CONDITION);
  assert.equal(good.endDate, "2026-08-10T04:45:00Z");

  const noTokens = { ...config(BTC_CONDITION, BTC_UP, BTC_DOWN) };
  delete noTokens.clobTokenIds;
  assert.equal(
    parseTrackedRow({
      market_id: BTC_CONDITION,
      config_json: JSON.stringify(noTokens),
      resolution_at_ms: NOW_MS,
    }),
    null,
    "missing clobTokenIds is skipped",
  );
  assert.equal(
    parseTrackedRow({
      market_id: BTC_CONDITION,
      config_json: JSON.stringify({
        ...config(BTC_CONDITION, BTC_UP, BTC_DOWN),
        clobTokenIds: [BTC_UP, BTC_DOWN],
      }),
      resolution_at_ms: NOW_MS,
    }),
    null,
    "an ARRAY clobTokenIds is refused — the stored shape is a label map",
  );
  assert.equal(
    parseTrackedRow({
      market_id: BTC_CONDITION,
      config_json: "{not json",
      resolution_at_ms: NOW_MS,
    }),
    null,
    "malformed config json is skipped",
  );
  assert.equal(
    parseTrackedRow({
      market_id: BTC_CONDITION,
      config_json: JSON.stringify(config(BTC_CONDITION, BTC_UP, BTC_UP)),
      resolution_at_ms: NOW_MS,
    }),
    null,
    "duplicate token ids are refused",
  );

  const a = parseTrackedRow({
    market_id: BTC_CONDITION,
    config_json: JSON.stringify(config(BTC_CONDITION, BTC_UP, BTC_DOWN)),
    resolution_at_ms: NOW_MS,
  })!;
  const b = parseTrackedRow({
    market_id: BTC_CONDITION,
    config_json: JSON.stringify(config(BTC_CONDITION, "999", BTC_DOWN)),
    resolution_at_ms: NOW_MS,
  })!;
  assert.notEqual(
    trackedSignature([a]),
    trackedSignature([b]),
    "a rewritten token map changes the signature even though the id is stable",
  );
  console.log("  ok  config parsing + signature");
}

// ─── 2. Tracked-set predicate ──────────────────────────────────────────────

{
  const malformed = { ...config(conditionFor(9), "a", "b") };
  delete malformed.clobTokenIds;
  seed([
    { id: conditionFor(1), status: "listed", resolutionAtMs: NOW_MS + 10 * MIN },
    { id: conditionFor(2), status: "listed", resolutionAtMs: NOW_MS + 48 * HOUR },
    { id: conditionFor(3), status: "frozen", resolutionAtMs: NOW_MS - 5 * MIN },
    { id: conditionFor(4), status: "listed", resolutionAtMs: NOW_MS - 45 * MIN },
    {
      id: conditionFor(5),
      status: "listed",
      resolutionAtMs: NOW_MS + 5 * MIN,
      halted: true,
    },
    { id: conditionFor(6), status: "retired", resolutionAtMs: NOW_MS + 5 * MIN },
    {
      id: conditionFor(7),
      status: "listed",
      resolutionAtMs: NOW_MS + 5 * MIN,
      adapter: "some-other-venue",
    },
    { id: conditionFor(8), status: "listed", resolutionAtMs: NOW_MS - 5 * MIN },
    {
      id: conditionFor(9),
      status: "listed",
      resolutionAtMs: NOW_MS + 2 * MIN,
      config: malformed,
    },
  ]);

  const warnings: string[] = [];
  const ticker = new VenueTicker({
    db,
    nowMs,
    logger: { log: () => undefined, warn: (m) => warnings.push(String(m)) },
    // No socket is opened: syncTrackedSet() is called directly, and the
    // socket factory only exists after start().
  });
  ticker.syncTrackedSet();
  const tracked = ticker
    .snapshot()
    .markets.map((row) => row.market_id)
    .sort();
  assert.deepEqual(
    tracked,
    [conditionFor(1), conditionFor(3), conditionFor(8)].sort(),
    "listed-in-horizon + frozen-in-lookback + listed-in-lookback, nothing else",
  );
  assert.equal(
    warnings.filter((line) => line.includes(conditionFor(9))).length,
    1,
    "a malformed clobTokenIds market logs exactly one line",
  );
  ticker.syncTrackedSet();
  ticker.syncTrackedSet();
  assert.equal(
    warnings.filter((line) => line.includes(conditionFor(9))).length,
    1,
    "…and never logs again on later refreshes (no retry loop)",
  );
  console.log("  ok  tracked-set predicate");
}

// ─── 3. Local websocket server replaying recorded frames ───────────────────

interface ServerHandle {
  url: string;
  subscriptions: string[][];
  sockets: WsSocket[];
  broadcast: (payload: unknown) => void;
  connections: () => number;
  close: () => Promise<void>;
}

async function startServer(): Promise<ServerHandle> {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  const subscriptions: string[][] = [];
  const sockets: WsSocket[] = [];
  wss.on("connection", (socket) => {
    sockets.push(socket);
    socket.on("message", (data) => {
      const raw = data.toString();
      if (raw === "PING") {
        socket.send("PONG");
        return;
      }
      try {
        const parsed = JSON.parse(raw) as { assets_ids?: string[] };
        if (Array.isArray(parsed.assets_ids)) {
          subscriptions.push(parsed.assets_ids);
          // Mirror the venue: answer immediately with one book per asset.
          socket.send(JSON.stringify(RECORDED_BOOK));
        }
      } catch {
        socket.send("INVALID OPERATION");
      }
    });
  });
  await new Promise<void>((resolve) => wss.once("listening", resolve));
  const address = wss.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    url: `ws://127.0.0.1:${port}`,
    subscriptions,
    sockets,
    broadcast: (payload) => {
      const text = typeof payload === "string" ? payload : JSON.stringify(payload);
      for (const socket of sockets) {
        if (socket.readyState === socket.OPEN) socket.send(text);
      }
    },
    connections: () => sockets.length,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.terminate();
        wss.close(() => resolve());
      }),
  };
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function until(
  predicate: () => boolean,
  label: string,
  budgetMs = 4_000,
): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(20);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const server = await startServer();

// ─── 4. Live quotes, coalescing, and the SSE contract ──────────────────────

{
  seed([
    {
      id: BTC_CONDITION,
      status: "listed",
      resolutionAtMs: NOW_MS + 5 * MIN,
      config: config(BTC_CONDITION, BTC_UP, BTC_DOWN),
    },
  ]);
  const ticker = new VenueTicker({
    db,
    nowMs,
    logger: { log: () => undefined, warn: () => undefined },
    wsUrl: server.url,
    tickBatchMs: 200,
    trackedRefreshMs: 60_000,
    resolutionSliceMs: 60_000,
    pingMs: 60_000,
  });
  await ticker.start();

  await until(
    () => server.subscriptions.length === 1,
    "the subscribe frame",
  );
  assert.deepEqual(
    server.subscriptions[0]!.sort(),
    [BTC_UP, BTC_DOWN].sort(),
    "subscribes with CLOB token ids, not the condition id",
  );

  // The SSE surface, wired to the real reader.
  const written: string[] = [];
  let ended = false;
  const closeHandlers: Array<() => void> = [];
  const req: VenueStreamRequest = {
    on: (_event, handler) => closeHandlers.push(handler),
  };
  const res: VenueStreamResponse = {
    status: () => res,
    json: () => undefined,
    setHeader: () => undefined,
    write: (chunk) => {
      written.push(chunk);
      return true;
    },
    end: () => {
      ended = true;
    },
  };
  const stream = openVenueStream(req, res, {
    reader: ticker,
    heartbeatMs: 60_000,
  });
  assert.equal(stream.status, 200);
  assert.ok(
    written[0]!.startsWith("event: venue_tick\n"),
    "the stream paints immediately from the cache",
  );

  await until(
    () => ticker.snapshot().markets.some((r) => "freshness" in r && r.freshness === "live"),
    "the initial book",
  );
  const seeded = ticker.snapshot().markets[0] as VenueMarketRow;
  const up = seeded.outcomes.find((o) => o.label === "Up")!;
  const down = seeded.outcomes.find((o) => o.label === "Down")!;
  // Book ordering is not part of the contract; best bid is max(bid),
  // best ask is min(ask).
  assert.equal(up.best_bid, 0.5, "best bid is the highest bid, not index 0");
  assert.equal(up.best_ask, 0.51, "best ask is the lowest ask, not index 0");
  assert.equal(down.best_bid, 0.49);
  assert.equal(down.best_ask, 0.5);
  assert.equal(up.price, 0.505);
  assert.equal(up.last_trade_price, 0.5);
  assert.equal(seeded.freshness, "live");

  // Coalescing: a burst of recorded frames must yield ONE batched tick.
  const before = written.length;
  for (let i = 0; i < 40; i++) server.broadcast(RECORDED_PRICE_CHANGE);
  server.broadcast(RECORDED_LAST_TRADE);
  await until(() => written.length > before, "a batched tick");
  await sleep(350);
  const ticks = written.slice(before).filter((f) => f.startsWith("event: venue_tick\n"));
  assert.equal(
    ticks.length,
    1,
    `41 frames must coalesce into one tick, saw ${ticks.length}`,
  );

  const payload = JSON.parse(ticks[0]!.split("\ndata: ")[1]!.trim()) as {
    markets: VenueMarketRow[];
    ts: string;
  };
  const row = payload.markets[0]!;
  const liveUp = row.outcomes.find((o) => o.label === "Up")!;
  const liveDown = row.outcomes.find((o) => o.label === "Down")!;
  assert.equal(liveUp.best_bid, 0.62);
  assert.equal(liveUp.best_ask, 0.64);
  assert.equal(liveDown.best_bid, 0.3);
  assert.equal(liveDown.best_ask, 0.34);
  assert.equal(liveUp.price, 0.63);
  assert.equal(liveDown.price, 0.32);
  assert.notEqual(
    liveDown.price,
    1 - liveUp.price!,
    "both tokens are tracked independently — never 1 − the other",
  );
  assert.equal(liveUp.last_trade_price, 0.51, "last_trade_price applies too");
  assert.equal(
    row.updated_at,
    new Date(1786336507696).toISOString(),
    "updated_at is the venue's own frame stamp",
  );
  console.log("  ok  live quotes + coalescing + SSE frames");

  // Token-signature change forces a reconnect (the venue refuses resubscribe).
  const connectionsBefore = server.connections();
  seed([
    {
      id: BTC_CONDITION,
      status: "listed",
      resolutionAtMs: NOW_MS + 5 * MIN,
      config: config(BTC_CONDITION, "rewritten-up-token", BTC_DOWN),
    },
  ]);
  ticker.syncTrackedSet();
  await until(
    () => server.connections() > connectionsBefore,
    "a reconnect after the token map changed",
  );
  await until(
    () => server.subscriptions.length >= 2,
    "the re-subscribe on the new socket",
  );
  assert.ok(
    server.subscriptions[server.subscriptions.length - 1]!.includes(
      "rewritten-up-token",
    ),
    "the new socket subscribes to the rewritten token",
  );
  const rewritten = ticker.snapshot().markets[0] as VenueMarketRow;
  assert.equal(
    rewritten.freshness,
    "warming",
    "quotes keyed on retired tokens are dropped, not relabelled",
  );
  console.log("  ok  token-signature reconnect");

  // stop() must end the SSE client; closing the HTTP server would not.
  await ticker.stop();
  assert.equal(ended, true, "stop() ends every open venue SSE response");
  assert.equal(ticker.running(), false);
  const afterStop = written.length;
  server.broadcast(RECORDED_PRICE_CHANGE);
  await sleep(250);
  assert.equal(written.length, afterStop, "no emission survives stop()");
  for (const handler of closeHandlers) handler();
  console.log("  ok  stop() closes the stream");
}

// ─── 5. Resolution — Gamma path, then the Gamma-absent CLOB fallback ───────

interface FakeResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

function jsonResponse(status: number, body: unknown): FakeResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => "application/json" },
    text: async () => JSON.stringify(body),
  };
}

async function resolutionRun(input: {
  gamma: (url: string) => FakeResponse;
  clob: (url: string) => FakeResponse;
}): Promise<{ events: VenueTickerEvent[]; ticker: VenueTicker; calls: string[] }> {
  seed([
    {
      id: BTC_CONDITION,
      // Already resolved and frozen — exactly the lookback case.
      status: "frozen",
      resolutionAtMs: NOW_MS - 2 * MIN,
      config: config(BTC_CONDITION, BTC_UP, BTC_DOWN),
    },
  ]);
  const calls: string[] = [];
  const ticker = new VenueTicker({
    db,
    nowMs,
    logger: { log: () => undefined, warn: () => undefined },
    wsUrl: server.url,
    gammaBaseUrl: "https://gamma.test",
    clobBaseUrl: "https://clob.test",
    fetchFn: async (url) => {
      calls.push(url);
      return url.startsWith("https://gamma.test")
        ? input.gamma(url)
        : input.clob(url);
    },
    tickBatchMs: 60_000,
    trackedRefreshMs: 60_000,
    resolutionSliceMs: 20,
    resolutionIntervalMs: 20,
    pingMs: 60_000,
  });
  const events: VenueTickerEvent[] = [];
  ticker.subscribe({ onEvent: (e) => events.push(e), onClose: () => undefined });
  ticker.syncTrackedSet();
  ticker.pumpResolutionPolls();
  await until(
    () => events.some((e) => e.type === "venue_resolution"),
    "a venue_resolution",
  );
  return { events, ticker, calls };
}

{
  // Gamma present, closed + UMA-resolved → the pure Gamma transform decides.
  const { events, ticker } = await resolutionRun({
    gamma: () =>
      jsonResponse(200, [
        {
          conditionId: BTC_CONDITION,
          outcomes: JSON.stringify(["Up", "Down"]),
          outcomePrices: JSON.stringify(["1", "0"]),
          umaResolutionStatus: "resolved",
          umaResolutionStatuses: JSON.stringify(["proposed", "resolved"]),
          closed: true,
          // ISO form; Gamma's "2026-08-10 04:45:03+00" form fails Date.parse and
          // falls back to endDate, which this test is not about.
          closedTime: "2026-08-10T04:45:03Z",
          endDate: "2026-08-10T04:45:00Z",
        },
      ]),
    clob: () => jsonResponse(404, {}),
  });
  const resolution = events.find((e) => e.type === "venue_resolution")!;
  assert.equal(resolution.type, "venue_resolution");
  assert.equal(resolution.market_id, BTC_CONDITION);
  assert.deepEqual(resolution.outcome_labels, ["Up", "Down"]);
  assert.deepEqual(resolution.outcome_prices, [1, 0]);
  assert.equal(resolution.winning_label, "Up");
  assert.equal(resolution.source, "gamma");
  assert.equal(
    resolution.resolved_at,
    "2026-08-10T04:45:03Z",
    "resolved_at is the venue's own close stamp, never the poll time",
  );

  // Idempotent: further pumps re-poll nothing and re-emit nothing.
  const before = events.filter((e) => e.type === "venue_resolution").length;
  ticker.pumpResolutionPolls();
  ticker.pumpResolutionPolls();
  await sleep(120);
  assert.equal(
    events.filter((e) => e.type === "venue_resolution").length,
    before,
    "venue_resolution is emitted once per market per process",
  );
  const snapshot = ticker.snapshot({ marketIds: [BTC_CONDITION] });
  assert.equal(snapshot.resolutions.length, 1, "and is replayed by snapshot()");
  await ticker.stop();
  console.log("  ok  resolution via the Gamma transform");
}

{
  // Gamma 404 after close is NORMAL for 5-minute micro-markets → CLOB.
  const { events, ticker, calls } = await resolutionRun({
    gamma: () => jsonResponse(404, {}),
    clob: () =>
      jsonResponse(200, {
        condition_id: BTC_CONDITION,
        question: "Bitcoin Up or Down",
        closed: true,
        archived: false,
        accepting_orders: false,
        end_date_iso: "2026-08-10T04:45:00Z",
        is_50_50_outcome: false,
        tokens: [
          { token_id: BTC_UP, outcome: "Up", price: 0, winner: false },
          { token_id: BTC_DOWN, outcome: "Down", price: 1, winner: true },
        ],
      }),
  });
  const resolution = events.find((e) => e.type === "venue_resolution")!;
  assert.equal(resolution.type, "venue_resolution");
  assert.equal(resolution.source, "clob");
  assert.deepEqual(resolution.outcome_prices, [0, 1]);
  assert.equal(resolution.winning_label, "Down");
  assert.equal(resolution.resolved_at, "2026-08-10T04:45:00Z");
  assert.ok(
    calls.some((url) => url.startsWith("https://gamma.test")),
    "Gamma is consulted first",
  );
  assert.ok(
    calls.some((url) => url.startsWith("https://clob.test")),
    "…and CLOB only after Gamma answered with no row",
  );
  await ticker.stop();
  console.log("  ok  Gamma-absent → CLOB fallback");
}

// ─── 6. Snapshot surface: validation, dedupe, cap, unknown ids ─────────────

{
  assert.deepEqual(normalizeMarketParam(undefined), []);
  assert.deepEqual(normalizeMarketParam(BTC_CONDITION), [BTC_CONDITION]);
  assert.deepEqual(normalizeMarketParam([BTC_CONDITION, BTC_CONDITION]), [
    BTC_CONDITION,
    BTC_CONDITION,
  ]);
  assert.equal(normalizeMarketParam("not-a-condition-id"), null);
  assert.equal(normalizeMarketParam("0xdead"), null);
  assert.equal(normalizeMarketParam([BTC_CONDITION, 42]), null);

  seed([
    {
      id: BTC_CONDITION,
      status: "listed",
      resolutionAtMs: NOW_MS + 5 * MIN,
      config: config(BTC_CONDITION, BTC_UP, BTC_DOWN),
    },
  ]);
  const ticker = new VenueTicker({
    db,
    nowMs,
    logger: { log: () => undefined, warn: () => undefined },
    wsUrl: server.url,
    trackedRefreshMs: 60_000,
    resolutionSliceMs: 60_000,
    tickBatchMs: 60_000,
    pingMs: 60_000,
  });
  await ticker.start();

  assert.deepEqual(
    venueLiveSnapshot("bogus", { reader: ticker }),
    { status: 400, body: VENUE_INVALID_MARKET_BODY },
    "a malformed id is a 400, not a silent drop",
  );

  const unknownId = conditionFor(4242);
  const answer = venueLiveSnapshot([BTC_CONDITION, BTC_CONDITION, unknownId], {
    reader: ticker,
  });
  assert.equal(answer.status, 200);
  assert.equal(answer.body.markets.length, 2, "duplicate ids collapse");
  assert.equal(answer.body.markets[0]!.market_id, BTC_CONDITION);
  assert.deepEqual(
    answer.body.markets[1],
    { market_id: unknownId, freshness: "unknown" },
    "a valid-but-untracked id answers 'unknown'",
  );
  assert.equal(answer.body.truncated, false);

  const many = Array.from({ length: 60 }, (_, i) => conditionFor(1000 + i));
  const capped = venueLiveSnapshot(many, { reader: ticker });
  assert.equal(capped.status, 200);
  assert.equal(capped.body.markets.length, 50, "capped at 50");
  assert.equal(capped.body.truncated, true);

  const all = venueLiveSnapshot(undefined, { reader: ticker });
  assert.equal(all.status, 200);
  assert.equal(all.body.markets.length, 1, "no params returns everything tracked");

  await ticker.stop();
  assert.deepEqual(
    venueLiveSnapshot(undefined, { reader: ticker }),
    { status: 503, body: VENUE_TICKER_UNAVAILABLE_BODY },
    "a stopped ticker answers 503",
  );
  assert.deepEqual(venueLiveSnapshot(undefined, { reader: null }), {
    status: 503,
    body: VENUE_TICKER_UNAVAILABLE_BODY,
  });
  console.log("  ok  snapshot validation, dedupe, cap, unknown ids");
}

// ─── 7. Backpressure: an overrunning client is CLOSED, never trimmed ──────
// `removed[]` and resolutions are one-shot, so dropping frames would lose them.

{
  seed([
    {
      id: BTC_CONDITION,
      status: "listed",
      resolutionAtMs: NOW_MS + 5 * MIN,
      config: config(BTC_CONDITION, BTC_UP, BTC_DOWN),
    },
  ]);
  const ticker = new VenueTicker({
    db,
    nowMs,
    logger: { log: () => undefined, warn: () => undefined },
    wsUrl: server.url,
    trackedRefreshMs: 60_000,
    resolutionSliceMs: 60_000,
    tickBatchMs: 60_000,
    pingMs: 60_000,
  });
  await ticker.start();
  let writes = 0;
  let ended = false;
  const res: VenueStreamResponse = {
    status: () => res,
    json: () => undefined,
    setHeader: () => undefined,
    // Socket buffer full from the first byte and never draining.
    write: () => {
      writes += 1;
      return false;
    },
    end: () => {
      ended = true;
    },
    once: () => undefined,
  };
  const stream = openVenueStream({ on: () => undefined }, res, {
    reader: ticker,
    heartbeatMs: 60_000,
    maxQueue: 4,
  });
  assert.equal(stream.status, 200);
  for (let i = 0; i < 200; i++) {
    ticker.handleFrame(JSON.stringify(RECORDED_PRICE_CHANGE));
    ticker.flushBatch();
  }
  assert.equal(
    writes,
    1,
    "a blocked socket is written to once — the daemon never spins on it",
  );
  assert.equal(
    ended,
    true,
    "a client that overruns its queue is disconnected, not silently trimmed",
  );

  // And it is really gone: the ticker must hold no subscription for it, so a
  // dead transport cannot keep costing fan-out work forever.
  const beforeOrphan = writes;
  for (let i = 0; i < 20; i++) {
    ticker.handleFrame(JSON.stringify(RECORDED_PRICE_CHANGE));
    ticker.flushBatch();
  }
  assert.equal(writes, beforeOrphan, "the closed client is unsubscribed");

  await ticker.stop();
  console.log("  ok  queue overflow closes the client (no silent frame loss)");
}

// ─── 8. The routes over real HTTP (express query parsing + SSE bytes) ─────

{
  seed([
    {
      id: BTC_CONDITION,
      status: "listed",
      resolutionAtMs: NOW_MS + 5 * MIN,
      config: config(BTC_CONDITION, BTC_UP, BTC_DOWN),
    },
  ]);
  const express = (await import("express")).default;

  // Ticker absent → both routes must answer 503, not 404 and not a crash.
  const offApp = express();
  offApp.use(venueTickerRouter({ reader: null }));
  const offServer = offApp.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => offServer.once("listening", () => resolve()));
  const offPort = (offServer.address() as { port: number }).port;
  const offLive = await fetch(`http://127.0.0.1:${offPort}/v2/venue/live`);
  assert.equal(offLive.status, 503);
  assert.deepEqual(await offLive.json(), VENUE_TICKER_UNAVAILABLE_BODY);
  const offStream = await fetch(`http://127.0.0.1:${offPort}/v2/venue/stream`);
  assert.equal(offStream.status, 503);
  await offStream.json();
  await new Promise<void>((resolve) => offServer.close(() => resolve()));

  const ticker = new VenueTicker({
    db,
    nowMs,
    logger: { log: () => undefined, warn: () => undefined },
    wsUrl: server.url,
    tickBatchMs: 150,
    trackedRefreshMs: 60_000,
    resolutionSliceMs: 60_000,
    pingMs: 60_000,
  });
  await ticker.start();
  const app = express();
  app.use(venueTickerRouter({ reader: ticker }));
  const httpServer = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => httpServer.once("listening", () => resolve()));
  const port = (httpServer.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;

  await until(
    () => ticker.snapshot().markets.some((r) => "outcomes" in r),
    "the tracked market",
  );

  // Repeated ?market= params must arrive as a list.
  const unknownId = conditionFor(777);
  const live = await fetch(
    `${base}/v2/venue/live?market=${BTC_CONDITION}&market=${unknownId}`,
  );
  assert.equal(live.status, 200);
  const liveBody = (await live.json()) as {
    markets: Array<{ market_id: string; freshness: string }>;
  };
  assert.equal(liveBody.markets.length, 2, "repeated ?market= params parse");
  assert.equal(liveBody.markets[1]!.freshness, "unknown");

  const bad = await fetch(`${base}/v2/venue/live?market=nope`);
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), VENUE_INVALID_MARKET_BODY);

  // Real SSE bytes.
  const streamRes = await fetch(`${base}/v2/venue/stream`);
  assert.equal(streamRes.status, 200);
  assert.equal(
    streamRes.headers.get("content-type"),
    "text/event-stream",
    "SSE content type",
  );
  assert.equal(streamRes.headers.get("x-accel-buffering"), "no");
  const reader = streamRes.body!.getReader();
  const decoder = new TextDecoder();
  let sse = "";
  const readChunk = async (): Promise<void> => {
    const { value, done } = await reader.read();
    if (!done && value) sse += decoder.decode(value, { stream: true });
  };
  await readChunk();
  assert.ok(sse.startsWith("event: venue_tick\ndata: {"), "first SSE frame");
  server.broadcast(RECORDED_PRICE_CHANGE);
  await readChunk();
  assert.ok(
    sse.split("event: venue_tick").length - 1 >= 2,
    "live ticks reach a real HTTP client",
  );

  // WHY the daemon stops the ticker BEFORE closing the HTTP server:
  // `server.close()` waits for open connections and never ends them itself,
  // so an open /v2/venue/stream wedges shutdown until the ticker ends it.
  let httpClosed = false;
  const closing = new Promise<void>((resolve) =>
    httpServer.close(() => {
      httpClosed = true;
      resolve();
    }),
  );
  await sleep(250);
  assert.equal(
    httpClosed,
    false,
    "server.close() must NOT complete while a venue SSE client is open — " +
      "this is why venue-ticker stop is deferred after the http-server step",
  );

  // stop() must end the response body; closing the server alone would not.
  await ticker.stop();
  await closing;
  assert.equal(httpClosed, true, "…and completes once the ticker ends them");
  const drained = await Promise.race([
    (async () => {
      // Read until the server ends the stream.
      for (;;) {
        const { done } = await reader.read();
        if (done) return "ended" as const;
      }
    })(),
    sleep(3_000).then(() => "hung" as const),
  ]);
  assert.equal(drained, "ended", "stop() ends the live HTTP response");
  console.log("  ok  routes over real HTTP + shutdown order");
}

// ─── 9. Eviction tombstones reach connected clients ───────────────────────
// Delta ticks only add, so evictions must ship as `removed[]`.

{
  const keptId = conditionFor(21);
  const evictedId = conditionFor(22);
  seed([
    { id: keptId, status: "listed", resolutionAtMs: NOW_MS + 6 * MIN },
    { id: evictedId, status: "listed", resolutionAtMs: NOW_MS + 7 * MIN },
  ]);
  const ticker = new VenueTicker({
    db,
    nowMs,
    logger: { log: () => undefined, warn: () => undefined },
    wsUrl: server.url,
    // Manual flush: the assertions are about frame CONTENT, not timing.
    tickBatchMs: 60_000,
    trackedRefreshMs: 60_000,
    resolutionSliceMs: 60_000,
    pingMs: 60_000,
  });
  await ticker.start();

  const written: string[] = [];
  const res: VenueStreamResponse = {
    status: () => res,
    json: () => undefined,
    setHeader: () => undefined,
    write: (chunk) => {
      written.push(chunk);
      return true;
    },
    end: () => undefined,
  };
  openVenueStream({ on: () => undefined }, res, {
    reader: ticker,
    heartbeatMs: 60_000,
  });

  const tickFrames = (): Array<{
    markets: VenueMarketRow[];
    removed?: string[];
    resolutions?: unknown[];
  }> =>
    written
      .filter((frame) => frame.startsWith("event: venue_tick\n"))
      .map(
        (frame) =>
          JSON.parse(frame.split("\ndata: ")[1]!.trim()) as {
            markets: VenueMarketRow[];
            removed?: string[];
            resolutions?: unknown[];
          },
      );

  const first = tickFrames()[0]!;
  assert.equal(first.markets.length, 2, "the first frame is the whole cache");
  assert.equal(
    "removed" in first,
    false,
    "a full snapshot carries no tombstones — replacing the map already drops",
  );
  assert.deepEqual(
    first.resolutions,
    [],
    "…and always states the resolution set, so the client can replace both maps",
  );

  // Evict ONE. The survivor still rides the same frame.
  seed([{ id: keptId, status: "listed", resolutionAtMs: NOW_MS + 6 * MIN }]);
  ticker.syncTrackedSet();
  ticker.flushBatch();
  const afterOne = tickFrames().at(-1)!;
  assert.deepEqual(
    afterOne.removed,
    [evictedId],
    "a tracked-set eviction ships as a tombstone on the next delta frame",
  );
  assert.deepEqual(
    afterOne.markets.map((row) => row.market_id),
    [keptId],
    "the surviving market is still in the same frame",
  );
  assert.equal(
    "resolutions" in afterOne,
    false,
    "a DELTA frame never restates the resolution set",
  );

  // Evict EVERYTHING: an eviction-only frame must still ship.
  seed([]);
  ticker.syncTrackedSet();
  ticker.flushBatch();
  const afterAll = tickFrames().at(-1)!;
  assert.deepEqual(afterAll.markets, [], "nothing is tracked any more");
  assert.deepEqual(
    afterAll.removed,
    [keptId],
    "the everything-evicted case is a markets:[] + removed:[…] frame, not silence",
  );

  // Tombstones are not replayed: they describe a transition, not state.
  const beforeIdle = tickFrames().length;
  ticker.flushBatch();
  assert.equal(tickFrames().length, beforeIdle, "an empty batch emits nothing");

  await ticker.stop();
  console.log("  ok  eviction tombstones (partial + everything-evicted)");
}

// ─── 10. An INTENTIONAL close publishes 'stale' too ───────────────────────
// closeSocket() removes listeners first, so it must publish 'stale' itself.

{
  const silent = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  const silentSockets: WsSocket[] = [];
  silent.on("connection", (socket) => {
    silentSockets.push(socket);
    socket.on("message", (data) => {
      // Deliberately NEVER answers PING — that is what makes the socket a
      // zombie and drives the intentional teardown under test.
      if (data.toString() === "PING") return;
      socket.send(JSON.stringify(RECORDED_BOOK));
    });
  });
  await new Promise<void>((resolve) => silent.once("listening", resolve));
  const silentPort = (silent.address() as { port: number }).port;

  seed([
    {
      id: BTC_CONDITION,
      status: "listed",
      resolutionAtMs: NOW_MS + 5 * MIN,
      config: config(BTC_CONDITION, BTC_UP, BTC_DOWN),
    },
  ]);
  const ticker = new VenueTicker({
    db,
    nowMs,
    logger: { log: () => undefined, warn: () => undefined },
    wsUrl: `ws://127.0.0.1:${silentPort}`,
    tickBatchMs: 40,
    trackedRefreshMs: 60_000,
    resolutionSliceMs: 60_000,
    // Two unanswered intervals: several live frames land before the teardown.
    pingMs: 200,
    // Long enough that the board stays stale for the assertion instead of
    // flipping back to live mid-check.
    reconnectBaseMs: 60_000,
    reconnectMaxMs: 60_000,
    socketGraceMs: 50,
  });
  const events: VenueTickerEvent[] = [];
  ticker.subscribe({ onEvent: (e) => events.push(e), onClose: () => undefined });
  await ticker.start();

  const freshnessSeen = (want: string): boolean =>
    events.some(
      (e) =>
        e.type === "venue_tick" &&
        e.markets.some((row) => row.freshness === want),
    );

  await until(() => freshnessSeen("live"), "a live frame");
  await until(
    () => freshnessSeen("stale"),
    "a stale frame after the unanswered-PING teardown",
  );
  assert.equal(
    (ticker.snapshot().markets[0] as VenueMarketRow).freshness,
    "stale",
    "…and the snapshot agrees, so a late joiner is not told 'live' either",
  );

  await ticker.stop();
  for (const socket of silentSockets) socket.terminate();
  await new Promise<void>((resolve) => silent.close(() => resolve()));
  console.log("  ok  stale published on an intentional close");
}

// ─── 11. Malformed timestamps and out-of-range quotes ─────────────────────
// A finite-but-absurd stamp ("1e100") must never reach toISOString from the batch timer.

{
  assert.equal(venueTimestampMs("1786336507696", NOW_MS), 1786336507696);
  assert.equal(venueTimestampMs("1e100", NOW_MS), null, "absurd stamps are refused");
  assert.equal(venueTimestampMs("0", NOW_MS), null);
  assert.equal(venueTimestampMs("-1786336507696", NOW_MS), null);
  assert.equal(
    venueTimestampMs("1786336507", NOW_MS),
    null,
    "a seconds-precision stamp is below the floor, not silently read as 1970",
  );
  assert.equal(
    venueTimestampMs(String(NOW_MS + 48 * HOUR), NOW_MS),
    null,
    "a stamp two days ahead can only be wrong",
  );
  assert.equal(venueTimestampMs("not-a-number", NOW_MS), null);

  assert.equal(probabilityField("0.51"), 0.51);
  assert.equal(probabilityField(0), 0);
  assert.equal(probabilityField(1), 1);
  assert.equal(probabilityField("1e100"), null);
  assert.equal(probabilityField("5"), null, "a share price above 1 is malformed");
  assert.equal(probabilityField("-0.2"), null);
  assert.equal(probabilityField(""), null);

  seed([
    {
      id: BTC_CONDITION,
      status: "listed",
      resolutionAtMs: NOW_MS + 5 * MIN,
      config: config(BTC_CONDITION, BTC_UP, BTC_DOWN),
    },
  ]);
  // No start(): syncTrackedSet() alone populates the token index, and no
  // socket factory exists yet, so this section drives frames by hand.
  const ticker = new VenueTicker({
    db,
    nowMs,
    logger: { log: () => undefined, warn: () => undefined },
    wsUrl: server.url,
    tickBatchMs: 60_000,
    trackedRefreshMs: 60_000,
    resolutionSliceMs: 60_000,
    pingMs: 60_000,
  });
  const events: VenueTickerEvent[] = [];
  ticker.subscribe({ onEvent: (e) => events.push(e), onClose: () => undefined });
  ticker.syncTrackedSet();

  ticker.handleFrame(JSON.stringify(RECORDED_BOOK));
  ticker.handleFrame(
    JSON.stringify({
      ...RECORDED_PRICE_CHANGE,
      timestamp: "1e100",
      price_changes: [
        {
          ...RECORDED_PRICE_CHANGE.price_changes[0]!,
          best_bid: "5",
          best_ask: "0.64",
        },
        {
          ...RECORDED_PRICE_CHANGE.price_changes[1]!,
          best_bid: "-0.3",
          best_ask: "1e100",
        },
      ],
    }),
  );
  assert.doesNotThrow(
    () => ticker.flushBatch(),
    "a finite-but-absurd timestamp must never reach toISOString",
  );

  const row = (ticker.snapshot().markets[0] as VenueMarketRow);
  assert.equal(
    row.updated_at,
    new Date(NOW_MS).toISOString(),
    "an out-of-range venue stamp falls back to local time",
  );
  const up = row.outcomes.find((o) => o.label === "Up")!;
  const down = row.outcomes.find((o) => o.label === "Down")!;
  assert.equal(up.best_bid, 0.5, "an out-of-range bid is dropped, not applied");
  assert.equal(up.best_ask, 0.64, "…and the valid field in the SAME frame lands");
  assert.equal(down.best_bid, 0.49, "a negative bid is dropped");
  assert.equal(down.best_ask, 0.5, "an absurd ask is dropped");

  // A book whose last trade is nonsense keeps the rest of the book.
  ticker.handleFrame(
    JSON.stringify([
      { ...RECORDED_BOOK[0]!, last_trade_price: "1e100", timestamp: "1e100" },
    ]),
  );
  assert.doesNotThrow(() => ticker.flushBatch());
  const afterBook = (ticker.snapshot().markets[0] as VenueMarketRow).outcomes.find(
    (o) => o.label === "Down",
  )!;
  assert.equal(afterBook.last_trade_price, 0.5, "the absurd last trade is refused");
  assert.equal(afterBook.best_bid, 0.49, "the rest of the book still applies");

  await ticker.stop();
  console.log("  ok  timestamp + quote validation (no throw on '1e100')");
}

// ─── 11b. An EMPTY book is an ANSWER; an unreadable one is not ────────────
// `bids: []` means no bid side; levels that all fail validation say nothing.

const bookFrame = (
  assetId: string,
  bids: unknown[],
  asks: unknown[],
  extra: Record<string, unknown> = {},
): string =>
  JSON.stringify([
    {
      market: BTC_CONDITION,
      asset_id: assetId,
      timestamp: "1786336279819",
      hash: "smoke",
      tick_size: "0.01",
      event_type: "book",
      bids,
      asks,
      ...extra,
    },
  ]);

/** Non-empty, every level unreadable. */
const GARBLED_LEVELS = [
  { price: "5", size: "100" },
  { price: "1e100", size: "100" },
];

function freshTicker(): VenueTicker {
  seed([
    {
      id: BTC_CONDITION,
      status: "listed",
      resolutionAtMs: NOW_MS + 5 * MIN,
      config: config(BTC_CONDITION, BTC_UP, BTC_DOWN),
    },
  ]);
  const ticker = new VenueTicker({
    db,
    nowMs,
    logger: { log: () => undefined, warn: () => undefined },
    wsUrl: server.url,
    tickBatchMs: 60_000,
    trackedRefreshMs: 60_000,
    resolutionSliceMs: 60_000,
    pingMs: 60_000,
  });
  ticker.syncTrackedSet();
  return ticker;
}

{
  const ticker = freshTicker();
  const row = (): VenueMarketRow => ticker.snapshot().markets[0] as VenueMarketRow;
  assert.equal(row().freshness, "warming", "nothing has arrived yet");

  // One side answered empty, the other still silent.
  ticker.handleFrame(bookFrame(BTC_DOWN, [], []));
  assert.equal(
    row().freshness,
    "warming",
    "the OTHER outcome has still never been answered",
  );

  ticker.handleFrame(bookFrame(BTC_UP, [], []));
  assert.equal(
    row().freshness,
    "live",
    "an empty book seeds — a market with no resting orders is answered, " +
      "not loading",
  );
  for (const outcome of row().outcomes) {
    assert.equal(outcome.best_bid, null);
    assert.equal(outcome.best_ask, null);
    assert.equal(outcome.price, null, "…with honest nulls, never a fabricated mid");
  }
  await ticker.stop();
}

{
  const ticker = freshTicker();
  const row = (): VenueMarketRow => ticker.snapshot().markets[0] as VenueMarketRow;

  // A NON-empty book whose every level is out of range answers nothing.
  ticker.handleFrame(bookFrame(BTC_DOWN, GARBLED_LEVELS, GARBLED_LEVELS));
  ticker.handleFrame(bookFrame(BTC_UP, GARBLED_LEVELS, GARBLED_LEVELS));
  assert.equal(
    row().freshness,
    "warming",
    "levels we could not read are not an answer — this must NOT seed",
  );

  // Real data seeds it properly.
  ticker.handleFrame(JSON.stringify(RECORDED_BOOK));
  assert.equal(row().freshness, "live");
  const down = () => row().outcomes.find((o) => o.label === "Down")!;
  assert.equal(down().best_bid, 0.49);
  assert.equal(down().best_ask, 0.5);

  // …and a garbled frame afterwards must not erase it.
  ticker.handleFrame(bookFrame(BTC_DOWN, GARBLED_LEVELS, GARBLED_LEVELS));
  assert.equal(down().best_bid, 0.49, "an unreadable book leaves the quotes alone");
  assert.equal(down().best_ask, 0.5);

  // A side that is answered EMPTY, though, writes its real null through: the
  // venue is saying that side just emptied out.
  ticker.handleFrame(bookFrame(BTC_DOWN, [], [{ price: "0.55", size: "10" }]));
  assert.equal(down().best_bid, null, "an emptied bid side is reported as empty");
  assert.equal(down().best_ask, 0.55, "…while the side that still has levels lands");

  // A side the frame OMITS entirely is not an answer either.
  ticker.handleFrame(
    JSON.stringify([
      {
        market: BTC_CONDITION,
        asset_id: BTC_DOWN,
        timestamp: "1786336279819",
        event_type: "book",
        asks: [{ price: "0.6", size: "10" }],
      },
    ]),
  );
  assert.equal(down().best_ask, 0.6, "the side that IS present applies");
  assert.equal(
    down().best_bid,
    null,
    "a missing side changes nothing — it was already null here",
  );

  await ticker.stop();
  console.log("  ok  empty book answers; unreadable book does not");
}

// ─── 12. An in-flight poll cannot resurrect an evicted market ─────────────

{
  seed([
    {
      id: BTC_CONDITION,
      status: "frozen",
      resolutionAtMs: NOW_MS - 2 * MIN,
      config: config(BTC_CONDITION, BTC_UP, BTC_DOWN),
    },
  ]);
  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let fetched = false;
  const ticker = new VenueTicker({
    db,
    nowMs,
    logger: { log: () => undefined, warn: () => undefined },
    wsUrl: server.url,
    gammaBaseUrl: "https://gamma.test",
    clobBaseUrl: "https://clob.test",
    fetchFn: async () => {
      await gate;
      fetched = true;
      return jsonResponse(200, [
        {
          conditionId: BTC_CONDITION,
          outcomes: JSON.stringify(["Up", "Down"]),
          outcomePrices: JSON.stringify(["1", "0"]),
          umaResolutionStatus: "resolved",
          umaResolutionStatuses: JSON.stringify(["proposed", "resolved"]),
          closed: true,
          closedTime: "2026-08-10T04:45:03Z",
          endDate: "2026-08-10T04:45:00Z",
        },
      ]);
    },
    tickBatchMs: 60_000,
    trackedRefreshMs: 60_000,
    resolutionSliceMs: 60_000,
    resolutionIntervalMs: 20,
    pingMs: 60_000,
  });
  const events: VenueTickerEvent[] = [];
  ticker.subscribe({ onEvent: (e) => events.push(e), onClose: () => undefined });
  ticker.syncTrackedSet();
  ticker.pumpResolutionPolls();

  // The poll is parked mid-await. Evict the market out from under it.
  seed([]);
  ticker.syncTrackedSet();
  assert.equal(ticker.snapshot().markets.length, 0, "the market is gone");

  release!();
  await until(() => fetched, "the parked poll to resume");
  await sleep(120);

  assert.equal(
    events.filter((e) => e.type === "venue_resolution").length,
    0,
    "a poll that outlived its market emits nothing",
  );
  assert.equal(
    ticker.snapshot().resolutions.length,
    0,
    "…and writes no orphan cache entry that nothing would ever evict",
  );
  await ticker.stop();
  console.log("  ok  resolution poll cannot resurrect an evicted market");
}

// ─── 13. Reconnect machine: handshake timeout + backoff escalation ────────

{
  // (a) A peer that accepts TCP and never speaks leaves `ws` in CONNECTING forever.
  const net = await import("node:net");
  const held: import("node:net").Socket[] = [];
  const mute = net.createServer((socket) => {
    held.push(socket);
  });
  await new Promise<void>((resolve) => mute.listen(0, "127.0.0.1", resolve));
  const mutePort = (mute.address() as { port: number }).port;

  seed([
    {
      id: BTC_CONDITION,
      status: "listed",
      resolutionAtMs: NOW_MS + 5 * MIN,
      config: config(BTC_CONDITION, BTC_UP, BTC_DOWN),
    },
  ]);
  const warnings: string[] = [];
  const stuck = new VenueTicker({
    db,
    nowMs,
    logger: { log: () => undefined, warn: (m) => warnings.push(String(m)) },
    wsUrl: `ws://127.0.0.1:${mutePort}`,
    handshakeMs: 150,
    // Park the retry so the assertion is about the timeout, not the loop.
    reconnectBaseMs: 60_000,
    reconnectMaxMs: 60_000,
    socketGraceMs: 50,
    tickBatchMs: 60_000,
    trackedRefreshMs: 60_000,
    resolutionSliceMs: 60_000,
    pingMs: 60_000,
  });
  await stuck.start();
  await until(
    () => warnings.some((line) => line.includes("handshake timed out")),
    "the handshake timeout to fire",
  );
  await stuck.stop();
  for (const socket of held) socket.destroy();
  await new Promise<void>((resolve) => mute.close(() => resolve()));

  // (b) An accept-then-reject server must escalate the backoff.
  const flapping = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  let connections = 0;
  flapping.on("connection", (socket) => {
    connections += 1;
    socket.close();
  });
  await new Promise<void>((resolve) => flapping.once("listening", resolve));
  const flappingPort = (flapping.address() as { port: number }).port;

  const escalating = new VenueTicker({
    db,
    nowMs,
    logger: { log: () => undefined, warn: () => undefined },
    wsUrl: `ws://127.0.0.1:${flappingPort}`,
    reconnectBaseMs: 40,
    reconnectMaxMs: 5_000,
    handshakeMs: 5_000,
    socketGraceMs: 50,
    tickBatchMs: 60_000,
    trackedRefreshMs: 60_000,
    resolutionSliceMs: 60_000,
    pingMs: 60_000,
  });
  await escalating.start();
  await sleep(1_200);
  await escalating.stop();

  assert.ok(connections >= 2, `it does retry (saw ${connections})`);
  // 40ms doubling reaches ~1.2s of budget in about six attempts. Resetting on
  // open instead would fire ~30 in the same window.
  assert.ok(
    connections <= 10,
    `an accept-then-reject server must escalate the backoff, saw ${connections} ` +
      `connections in 1.2s (a reset-on-open bug produces ~30)`,
  );
  await new Promise<void>((resolve) => flapping.close(() => resolve()));
  console.log("  ok  handshake timeout + attempts reset on first FRAME");
}

// ─── 14. The snapshot frame carries the CURRENT resolution set ────────────
// So a client replaces both maps on connect, in one frame.

{
  seed([
    {
      id: BTC_CONDITION,
      status: "frozen",
      resolutionAtMs: NOW_MS - 2 * MIN,
      config: config(BTC_CONDITION, BTC_UP, BTC_DOWN),
    },
  ]);
  const ticker = new VenueTicker({
    db,
    nowMs,
    logger: { log: () => undefined, warn: () => undefined },
    wsUrl: server.url,
    gammaBaseUrl: "https://gamma.test",
    clobBaseUrl: "https://clob.test",
    fetchFn: async (url) =>
      url.startsWith("https://gamma.test")
        ? jsonResponse(200, [
            {
              conditionId: BTC_CONDITION,
              outcomes: JSON.stringify(["Up", "Down"]),
              outcomePrices: JSON.stringify(["1", "0"]),
              umaResolutionStatus: "resolved",
              umaResolutionStatuses: JSON.stringify(["proposed", "resolved"]),
              closed: true,
              closedTime: "2026-08-10T04:45:03Z",
              endDate: "2026-08-10T04:45:00Z",
            },
          ])
        : jsonResponse(404, {}),
    tickBatchMs: 60_000,
    trackedRefreshMs: 60_000,
    resolutionSliceMs: 60_000,
    resolutionIntervalMs: 20,
    pingMs: 60_000,
  });
  await ticker.start();

  interface Capture {
    written: string[];
    close: () => void;
  }
  const connect = (): Capture => {
    const written: string[] = [];
    const res: VenueStreamResponse = {
      status: () => res,
      json: () => undefined,
      setHeader: () => undefined,
      write: (chunk) => {
        written.push(chunk);
        return true;
      },
      end: () => undefined,
    };
    const result = openVenueStream({ on: () => undefined }, res, {
      reader: ticker,
      heartbeatMs: 60_000,
    });
    assert.equal(result.status, 200);
    return {
      written,
      close: result.status === 200 ? result.close : () => undefined,
    };
  };
  const snapshotFrame = (capture: Capture): {
    markets: VenueMarketRow[];
    resolutions?: Array<{ market_id: string }>;
  } =>
    JSON.parse(capture.written[0]!.split("\ndata: ")[1]!.trim()) as {
      markets: VenueMarketRow[];
      resolutions?: Array<{ market_id: string }>;
    };

  // Before anything has settled.
  const early = connect();
  assert.deepEqual(snapshotFrame(early).resolutions, []);

  ticker.pumpResolutionPolls();
  await until(
    () => ticker.snapshot().resolutions.length === 1,
    "the market to settle",
  );

  // A tab connecting AFTER the settlement is handed it in the snapshot itself.
  const afterSettle = connect();
  assert.equal(
    afterSettle.written.length,
    1,
    "the initial paint is ONE frame — not one extra per settled market, which " +
      "is exactly what used to overflow a slow reader's queue on connect",
  );
  const settled = snapshotFrame(afterSettle);
  assert.equal(settled.resolutions!.length, 1);
  assert.equal(settled.resolutions![0]!.market_id, BTC_CONDITION);

  // Evict it: a tab connecting afterwards must NOT be handed it.
  seed([]);
  ticker.syncTrackedSet();
  assert.equal(ticker.snapshot().resolutions.length, 0, "the daemon dropped it");
  const afterEvict = connect();
  assert.deepEqual(
    snapshotFrame(afterEvict).resolutions,
    [],
    "a reconnect states the CURRENT set, so replacing it prunes what is gone",
  );
  assert.deepEqual(snapshotFrame(afterEvict).markets, []);

  early.close();
  afterSettle.close();
  afterEvict.close();
  await ticker.stop();
  console.log("  ok  snapshot frame carries the current resolution set");
}

// ─── 15. A fast reconnect cannot re-publish old quotes as 'live' ──────────
// Freshness is stored per field, not read from `connected` at flush time.

{
  const toggling = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  const live: WsSocket[] = [];
  const subscribes: string[][] = [];
  /** Whether a NEW subscription is answered with a book. */
  let serveBooks = true;
  toggling.on("connection", (socket) => {
    live.push(socket);
    socket.on("message", (data) => {
      const raw = data.toString();
      if (raw === "PING") {
        socket.send("PONG");
        return;
      }
      try {
        const parsed = JSON.parse(raw) as { assets_ids?: string[] };
        if (!Array.isArray(parsed.assets_ids)) return;
        subscribes.push(parsed.assets_ids);
        if (serveBooks) socket.send(JSON.stringify(RECORDED_BOOK));
      } catch {
        socket.send("INVALID OPERATION");
      }
    });
  });
  await new Promise<void>((resolve) => toggling.once("listening", resolve));
  const togglingPort = (toggling.address() as { port: number }).port;

  seed([
    {
      id: BTC_CONDITION,
      status: "listed",
      resolutionAtMs: NOW_MS + 5 * MIN,
      config: config(BTC_CONDITION, BTC_UP, BTC_DOWN),
    },
  ]);
  const ticker = new VenueTicker({
    db,
    nowMs,
    logger: { log: () => undefined, warn: () => undefined },
    wsUrl: `ws://127.0.0.1:${togglingPort}`,
    tickBatchMs: 30,
    trackedRefreshMs: 60_000,
    resolutionSliceMs: 60_000,
    pingMs: 60_000,
    // Reconnect almost immediately — the whole point is a fast reopen.
    reconnectBaseMs: 20,
    reconnectMaxMs: 200,
    socketGraceMs: 50,
  });
  const events: VenueTickerEvent[] = [];
  ticker.subscribe({ onEvent: (e) => events.push(e), onClose: () => undefined });
  await ticker.start();

  const rowNow = (): VenueMarketRow =>
    ticker.snapshot().markets[0] as VenueMarketRow;
  await until(() => rowNow().freshness === "live", "the first live book");
  const bidBeforeDrop = rowNow().outcomes.find((o) => o.label === "Up")!.best_bid;
  assert.equal(bidBeforeDrop, 0.5);

  // Drop the socket, and make sure the reconnect is answered with NOTHING.
  serveBooks = false;
  for (const socket of live) socket.terminate();

  // Wait for the replacement socket to be established and subscribed.
  await until(() => subscribes.length >= 2, "the reconnect to re-subscribe");
  await sleep(120);

  assert.equal(
    rowNow().freshness,
    "stale",
    "an open socket is not evidence a market is live — only its data is",
  );
  assert.equal(
    rowNow().outcomes.find((o) => o.label === "Up")!.best_bid,
    bidBeforeDrop,
    "…and the quotes shown are still the pre-disconnect ones, correctly flagged",
  );
  assert.ok(
    events.some(
      (e) =>
        e.type === "venue_tick" && e.markets.some((r) => r.freshness === "stale"),
    ),
    "the stale transition reached subscribers rather than being overtaken",
  );

  const push = (payload: unknown): void => {
    const text = typeof payload === "string" ? payload : JSON.stringify(payload);
    for (const socket of live) {
      if (socket.readyState === socket.OPEN) socket.send(text);
    }
  };
  const up = () => rowNow().outcomes.find((o) => o.label === "Up")!;

  // ── Per-OUTCOME, not per-market ──────────────────────────────────────────
  // RECORDED_BOOK[0] is Down, [1] is Up; refreshing one must not vouch for the other.
  push([RECORDED_BOOK[0]]);
  await sleep(120);
  assert.equal(
    rowNow().freshness,
    "stale",
    "one outcome refreshed is not a refreshed market — the other side's " +
      "quotes still predate the disconnect",
  );

  // A frame whose every quote is out of range applies nothing, so it refreshes
  // nothing — validation failure is not a data arrival.
  push({
    ...RECORDED_PRICE_CHANGE,
    price_changes: [
      {
        ...RECORDED_PRICE_CHANGE.price_changes[0]!,
        best_bid: "5",
        best_ask: "1e100",
      },
    ],
  });
  await sleep(120);
  assert.equal(
    rowNow().freshness,
    "stale",
    "a frame whose values were all dropped clears nothing",
  );
  assert.equal(
    up().best_bid,
    bidBeforeDrop,
    "…and does not disturb the quotes already there",
  );

  // ── Per-FIELD, not per-outcome ───────────────────────────────────────────
  //
  // Down is fully refreshed by now, so the market's freshness tracks Up alone —
  // which lets each of these assertions be about one field at a time.

  // A trade print says where someone traded, NOT where the book now rests.
  // It refreshes `last_trade_price` and must refresh nothing else.
  push(RECORDED_LAST_TRADE);
  await until(() => up().last_trade_price === 0.51, "the trade print to apply");
  assert.equal(
    rowNow().freshness,
    "stale",
    "a fresh last trade does not vouch for best_bid/best_ask — those still " +
      "hold pre-disconnect values",
  );
  assert.equal(up().best_bid, bidBeforeDrop, "…which are indeed still the old ones");

  // A book that answers only its ask side refreshes only the ask.
  push(bookFrame(BTC_UP, GARBLED_LEVELS, [{ price: "0.64", size: "100" }]));
  await until(() => up().best_ask === 0.64, "the ask side to apply");
  assert.equal(
    rowNow().freshness,
    "stale",
    "the bid was unreadable, so it keeps its old value AND its stale flag",
  );
  assert.equal(up().best_bid, bidBeforeDrop);

  // Answering the bid side as EMPTY is fresh information about the bid: it
  // becomes a fresh null. Every number still on screen now post-dates the
  // disconnect, and a null renders as nothing, so nothing can lie.
  push(bookFrame(BTC_UP, [], [{ price: "0.64", size: "100" }]));
  await until(
    () => rowNow().freshness === "live",
    "live once every non-null field has been re-proved",
  );
  assert.equal(up().best_bid, null, "the emptied bid side is a fresh null");
  assert.equal(up().best_ask, 0.64);
  assert.equal(up().last_trade_price, 0.51);

  // And a full both-sides book is the ordinary path to the same place.
  push([RECORDED_BOOK[1]]);
  await until(() => up().best_bid === 0.5, "the full book to restore both sides");
  assert.equal(rowNow().freshness, "live");

  // A real update still lands normally afterwards.
  push(RECORDED_PRICE_CHANGE);
  await until(() => up().best_bid === 0.62, "the new quotes");
  assert.equal(rowNow().freshness, "live");

  await ticker.stop();
  for (const socket of live) socket.terminate();
  await new Promise<void>((resolve) => toggling.close(() => resolve()));
  console.log("  ok  stale is not overtaken by a fast reconnect");
}

// ─── Teardown ───────────────────────────────────────────────────────────────

await server.close();
db.close();
rmSync(tmp, { recursive: true, force: true });

// Nothing below calls process.exit(): if any timer, socket, or handle
// survived stop(), this process hangs and the smoke runner fails it.
process.stdout.write("venue ticker smoke OK\n");
