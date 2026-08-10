/**
 * Venue ticker — live Polymarket order-book + resolution feed for the
 * dashboard market board. DISPLAY ONLY.
 *
 * ─── Pure-referee boundary (structural, enforced by a smoke) ───────────────
 *
 * Murmur's own resolution comes exclusively from the resolver
 * (`src/verdict/resolver.ts` → `src/verdict/resolution-lifecycle.ts` →
 * the venue adapter registry). This module NEVER participates in it:
 *
 *   · nothing under `src/verdict/resolver*` or `src/verdict/resolution-
 *     lifecycle*` may import this file;
 *   · this file imports no resolver module;
 *   · it does not use the adapter's module-level Gamma/CLOB singletons
 *     (`setDefaultPolymarketClient`), so a display outage, a rate limit, or
 *     a poisoned cache here cannot reach a scored verdict.
 *
 * `src/integrations/venue-ticker-referee.smoke.ts` asserts both directions.
 * It shares only pure leaves with the adapter: config parsing
 * (`markets/polymarket-gamma/config.ts`), the pure Gamma transform
 * (`transform.ts`), and the pure CLOB transform (`clob-transform.ts`).
 * The HTTP clients are shared as CLASSES; the instances are private to this
 * ticker (with a much shorter active-cache TTL than the resolver wants).
 *
 * ─── Verified websocket protocol (live probe, 2026-08-10, mainnet CLOB) ────
 *
 * Endpoint: `wss://ws-subscriptions-clob.polymarket.com/ws/market`.
 * Public, key-less, read-only.
 *
 *  1. SUBSCRIBE — send ONE json text frame right after `open`:
 *       {"type":"market","assets_ids":["<tokenId>", …]}
 *     `assets_ids` are CLOB token ids (decimal strings), NOT condition ids.
 *
 *  2. INITIAL BOOK — the server answers immediately with a JSON **array**
 *     holding one `book` object per subscribed asset:
 *       {market, asset_id, timestamp:"<ms>", hash, tick_size:"0.01",
 *        last_trade_price:"0.500", event_type:"book",
 *        bids:[{price,size},…], asks:[{price,size},…]}
 *     Observed ordering was bids ascending / asks descending, so this module
 *     computes best bid as max(bid.price) and best ask as min(ask.price)
 *     rather than trusting index 0. Book frames also RECUR mid-stream (as
 *     single-element arrays) after larger trades, so the handler must accept
 *     an array of any length at any time, not only on subscribe.
 *
 *  3. price_change — a single JSON **object** (not an array) carrying a
 *     batch for one market:
 *       {market, timestamp:"<ms>", event_type:"price_change",
 *        price_changes:[{asset_id, price, size, side,
 *                        hash, best_bid, best_ask}, …]}
 *     `price` / `size` / `side` describe the level that changed — they are
 *     NOT the market price. `best_bid`/`best_ask` are the live top of book
 *     and are the only quote fields this module reads.
 *
 *  4. last_trade_price — a single JSON object:
 *       {market, asset_id, price, size, fee_rate_bps, side,
 *        timestamp, event_type:"last_trade_price"}
 *
 *  5. KEEPALIVE IS REQUIRED. The server answers a `PING` **text** frame with
 *     a `PONG` text frame. A probe socket that never pinged and received no
 *     data was closed by the server at ~126s with code 1006, so a quiet
 *     subscription dies without a keepalive. This module pings every 10s and
 *     treats an unanswered PING as a dead socket.
 *
 *  6. RESUBSCRIBE IS NOT SUPPORTED. Sending a second `{"type":"market",…}`
 *     frame on a live socket answers with the text `INVALID OPERATION` and
 *     the original subscription stays. Changing the tracked set therefore
 *     REQUIRES a reconnect, which is what `syncTrackedSet` does whenever the
 *     tracked signature changes.
 *
 *  7. An empty `assets_ids` array is accepted and simply yields no data, so
 *     "nothing tracked" is represented by keeping the socket closed.
 *
 *  8. VOLUME. An 80-asset subscription (the 40-market cap) is accepted and
 *     produced ~380 frames/second across ~12 active markets. That is why the
 *     transport coalesces: consumers get ONE batched frame per interval,
 *     never the raw feed.
 *
 * ─── Resolution ────────────────────────────────────────────────────────────
 *
 * The websocket does not announce resolution. Markets past their
 * `market_clocks.resolution_at_ms` are polled (staggered, ≤2 in flight):
 * Gamma first, and on Gamma absence — which is NORMAL for 5-minute
 * micro-markets, Gamma drops them minutes after close — the read-only CLOB
 * market endpoint. Both are mapped by the SAME pure transforms the resolver
 * uses, and `resolved_at` always comes from the venue's own stamp
 * (`resolvedAtSeconds`), never from poll time.
 */

import type Database from "better-sqlite3";

import {
  PolymarketGammaClient,
  type FetchFnLike,
} from "../markets/polymarket-gamma/client.js";
import { PolymarketClobClient } from "../markets/polymarket-gamma/clob-client.js";
import {
  clobMarketToOutcome,
  normalizeOutcomeLabel,
} from "../markets/polymarket-gamma/clob-transform.js";
import { POLYMARKET_CONDITION_ID_REGEX } from "../markets/polymarket-gamma/config.js";
import { gammaMarketToOutcome } from "../markets/polymarket-gamma/transform.js";
import { isoFromMs } from "../verdict/time.js";

// ─── Constants ──────────────────────────────────────────────────────────────

export const VENUE_TICKER_ADAPTER_ID = "polymarket-gamma" as const;
export const VENUE_WS_URL =
  "wss://ws-subscriptions-clob.polymarket.com/ws/market";

/** Cap on simultaneously tracked markets (newest-relative-to-now wins). */
const DEFAULT_MAX_TRACKED = 40;
/** How far into the future a market may resolve and still be tracked. */
const DEFAULT_HORIZON_MS = 24 * 60 * 60 * 1000;
/** How long after resolution a market stays tracked (discovery freezes at
 *  endDate within one 60s tick, so `status='listed'` alone loses these). */
const DEFAULT_LOOKBACK_MS = 30 * 60 * 1000;
const DEFAULT_TRACKED_REFRESH_MS = 30_000;
const DEFAULT_TICK_BATCH_MS = 2_000;
const DEFAULT_RESOLUTION_INTERVAL_MS = 15_000;
const DEFAULT_RESOLUTION_SLICE_MS = 1_500;
const DEFAULT_RESOLUTION_CONCURRENCY = 2;
const DEFAULT_PING_MS = 10_000;
const DEFAULT_RECONNECT_BASE_MS = 1_000;
const DEFAULT_RECONNECT_MAX_MS = 30_000;
const DEFAULT_SOCKET_GRACE_MS = 2_000;
/**
 * A TCP connect that never completes the websocket handshake leaves the socket
 * in CONNECTING forever: `ws` fires neither 'open' nor 'close', so the close
 * handler that owns reconnect never runs and the feed is dead without ever
 * reporting so. Ten seconds is well past the observed handshake (<1s) and well
 * inside the venue's own ~126s idle kill.
 */
const DEFAULT_HANDSHAKE_MS = 10_000;
/** Spread on the reconnect delay, so every daemon does not retry in lockstep. */
const RECONNECT_JITTER = 0.2;
/**
 * Bounds a venue-supplied millisecond stamp. Below: a seconds-vs-milliseconds
 * mix-up or a zero/garbage value. Above: a stamp far enough ahead that it can
 * only be wrong. Anything outside — including a finite-but-absurd "1e100" —
 * would reach `new Date(ms).toISOString()`, which throws RangeError from inside
 * a setInterval callback and takes the daemon down.
 */
const VENUE_TS_MIN_MS = Date.UTC(2020, 0, 1);
const VENUE_TS_FUTURE_SLACK_MS = 24 * 60 * 60 * 1000;
/** Short enough that a 15s resolution poll is never served a stale row. */
const GAMMA_TTL_ACTIVE_MS = 5_000;
const GAMMA_TTL_NEGATIVE_MS = 30_000;
/** Hard ceiling on ids accepted by the snapshot route. */
export const VENUE_SNAPSHOT_MAX_MARKETS = 50;

// ─── Public wire types (the dashboard consumes these verbatim) ─────────────
//
// DECLARED in src/types/wire-venue.ts and re-exported here under their
// daemon-side names. This module is Node-only (better-sqlite3, ws, the Gamma
// and CLOB HTTP clients), so the browser cannot reach into it for a type — but
// every existing daemon-side importer keeps working unchanged, because these
// names still resolve from here.

import type {
  WireVenueOutcomeQuote as VenueOutcomeQuote,
  WireVenueFreshness as VenueFreshness,
  WireVenueMarketRow as VenueMarketRow,
  WireVenueUnknownMarketRow as VenueUnknownMarketRow,
  WireVenueResolutionRow as VenueResolutionRow,
  WireVenueSnapshotResult as VenueSnapshotResult,
} from "../types/wire-venue.js";

export type {
  VenueOutcomeQuote,
  VenueFreshness,
  VenueMarketRow,
  VenueUnknownMarketRow,
  VenueResolutionRow,
  VenueSnapshotResult,
};

/**
 * The ticker's INTERNAL event union — a discriminated envelope around the wire
 * payloads. It stays here rather than in the shared wire types because the
 * `type` tag never reaches the wire: SSE carries the discriminator in the
 * `event:` line and `venue-ticker-surface.ts` strips it from the body.
 */
export type VenueTickerEvent =
  | {
      type: "venue_tick";
      markets: VenueMarketRow[];
      /** Market ids evicted from the tracked set since the previous frame.
       *  Absent on the full-snapshot first frame (a replace covers it). */
      removed?: string[];
      ts: string;
    }
  | ({ type: "venue_resolution" } & VenueResolutionRow);

export interface VenueTickerSubscriber {
  onEvent: (event: VenueTickerEvent) => void;
  /** Invoked once when the ticker shuts down, so transports can end their
   *  responses (closing the HTTP server alone does not). */
  onClose: () => void;
}

/**
 * The NARROW read interface handed to HTTP surfaces. No DB handle, no
 * websocket, no client, no mutation — a consumer cannot reach anything the
 * ticker owns.
 */
export interface VenueTickerReader {
  running(): boolean;
  snapshot(input?: { marketIds?: readonly string[] }): VenueSnapshotResult;
  subscribe(subscriber: VenueTickerSubscriber): () => void;
}

// ─── Dependencies ───────────────────────────────────────────────────────────

export interface VenueTickerLogger {
  log: (message?: unknown, ...optional: unknown[]) => void;
  warn: (message?: unknown, ...optional: unknown[]) => void;
}

export interface VenueTickerDeps {
  db: Database.Database;
  nowMs: () => number;
  logger?: VenueTickerLogger;
  /** Override for the local-ws-server smoke. */
  wsUrl?: string;
  gammaBaseUrl?: string;
  clobBaseUrl?: string;
  /** Injected fetch for the offline smoke (both HTTP clients). */
  fetchFn?: FetchFnLike;
  maxTrackedMarkets?: number;
  horizonMs?: number;
  lookbackMs?: number;
  trackedRefreshMs?: number;
  tickBatchMs?: number;
  resolutionIntervalMs?: number;
  resolutionSliceMs?: number;
  resolutionConcurrency?: number;
  pingMs?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  socketGraceMs?: number;
  /** How long a socket may sit in CONNECTING before it is torn down. */
  handshakeMs?: number;
}

// ─── Internal state ─────────────────────────────────────────────────────────

interface TrackedOutcome {
  label: string;
  tokenId: string;
}

interface TrackedMarket {
  marketId: string;
  conditionId: string;
  endDate: string | null;
  resolutionAtMs: number;
  outcomes: TrackedOutcome[];
}

interface QuoteState {
  bestBid: number | null;
  bestAsk: number | null;
  lastTradePrice: number | null;
  /**
   * The venue has ANSWERED for this outcome — until then it is 'warming'.
   *
   * Answered, not quoted: a book with both sides empty seeds the outcome with
   * null prices, because "there is no market here right now" is an answer. What
   * does NOT seed is a frame we could not read — every value out of range, or
   * levels present that all failed validation. That would flip an outcome out
   * of 'warming' on the strength of nothing.
   */
  seeded: boolean;
  /**
   * Freshness is STORED per FIELD — the granularity at which a number is
   * actually shown, and therefore the granularity at which it can lie.
   *
   * Each widening was the same mistake at a coarser scale: freshness inferred
   * from something other than "did THIS number arrive".
   *
   *   · derived from `connected`, it was resolved at FLUSH time from a mutable
   *     flag, and a replacement socket sets `connected` on 'open' before any
   *     book — so a reconnect inside one batch interval turned the pending
   *     stale frame into a `live` badge over pre-disconnect quotes;
   *   · stored per MARKET, one frame cleared it for the whole row, so the
   *     first outcome's book vouched for the other outcome;
   *   · stored per OUTCOME, a partially answered book — or a standalone
   *     `last_trade_price` — cleared it while `best_bid`/`best_ask` still held
   *     pre-disconnect values, which then rendered as live.
   *
   * There is nothing finer below this: `price` is derived from these three.
   *
   * Flagged on every teardown; a flag clears only when THAT field is written by
   * an answered frame — including a written null from an answered-empty side,
   * because "there are no bids" is fresh information about bids.
   */
  stale: QuoteFieldStaleness;
}

/** Per-field staleness flags. See {@link QuoteState.stale}. */
interface QuoteFieldStaleness {
  bid: boolean;
  ask: boolean;
  lastTrade: boolean;
}

interface MarketState {
  tracked: TrackedMarket;
  quotes: Map<string, QuoteState>;
  updatedAtMs: number | null;
}

interface ResolutionProgress {
  lastPolledAtMs: number;
  emitted: boolean;
}

/** The subset of `ws` this module uses, so the smoke can assert against it. */
interface VenueSocket {
  readyState: number;
  send(data: string): void;
  close(): void;
  terminate(): void;
  on(event: "open", handler: () => void): unknown;
  on(event: "message", handler: (data: unknown, isBinary: boolean) => void): unknown;
  on(event: "close", handler: () => void): unknown;
  on(event: "error", handler: (err: Error) => void): unknown;
  once(event: "close", handler: () => void): unknown;
  removeAllListeners(): unknown;
}

type VenueSocketFactory = (url: string) => VenueSocket;

// ─── Implementation ─────────────────────────────────────────────────────────

export class VenueTicker implements VenueTickerReader {
  private readonly db: Database.Database;
  private readonly nowMs: () => number;
  private readonly logger: VenueTickerLogger;
  private readonly wsUrl: string;
  private readonly gamma: PolymarketGammaClient;
  private readonly clob: PolymarketClobClient;
  private readonly maxTracked: number;
  private readonly horizonMs: number;
  private readonly lookbackMs: number;
  private readonly trackedRefreshMs: number;
  private readonly tickBatchMs: number;
  private readonly resolutionIntervalMs: number;
  private readonly resolutionSliceMs: number;
  private readonly resolutionConcurrency: number;
  private readonly pingMs: number;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly socketGraceMs: number;
  private readonly handshakeMs: number;

  private readonly markets = new Map<string, MarketState>();
  /** token_id → market_id, so a frame lands on its market in O(1). */
  private readonly tokenIndex = new Map<string, string>();
  private readonly resolutions = new Map<string, VenueResolutionRow>();
  private readonly resolutionProgress = new Map<string, ResolutionProgress>();
  private readonly subscribers = new Set<VenueTickerSubscriber>();
  private readonly dirty = new Set<string>();
  /**
   * Tombstones for the next delta frame. A tracked-set eviction is invisible to
   * a connected client otherwise: delta ticks only ever ADD, so every client
   * map would grow for the life of the tab and keep painting markets the daemon
   * stopped tracking, frozen at their last price. Cleared on every flush, so
   * this is bounded by one batch interval's worth of evictions.
   */
  private readonly pendingRemovals = new Set<string>();
  private readonly inFlightPolls = new Set<Promise<void>>();
  /** Malformed-config markets we already complained about, so the "one log
   *  line, no retry loop" rule survives the 30s tracked-set refresh. */
  private readonly skipped = new Set<string>();

  private socket: VenueSocket | null = null;
  private socketFactory: VenueSocketFactory | null = null;
  private trackedSignature = "";
  private started = false;
  private stopped = false;
  /**
   * Did the CURRENT socket complete its handshake? Drives the handshake
   * timeout and nothing else. Deliberately NOT an input to freshness: it says
   * a socket is open, which is not the same claim as "this row's numbers are
   * current" — see MarketState.stale.
   */
  private connected = false;
  private reconnectAttempts = 0;
  private awaitingPong = false;
  private resolutionCursor = 0;

  private trackedTimer: ReturnType<typeof setInterval> | null = null;
  private batchTimer: ReturnType<typeof setInterval> | null = null;
  private resolutionTimer: ReturnType<typeof setInterval> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: VenueTickerDeps) {
    this.db = deps.db;
    this.nowMs = deps.nowMs;
    this.logger = deps.logger ?? console;
    this.wsUrl = deps.wsUrl ?? VENUE_WS_URL;
    this.maxTracked = positive(deps.maxTrackedMarkets, DEFAULT_MAX_TRACKED);
    this.horizonMs = positive(deps.horizonMs, DEFAULT_HORIZON_MS);
    this.lookbackMs = positive(deps.lookbackMs, DEFAULT_LOOKBACK_MS);
    this.trackedRefreshMs = positive(
      deps.trackedRefreshMs,
      DEFAULT_TRACKED_REFRESH_MS,
    );
    this.tickBatchMs = positive(deps.tickBatchMs, DEFAULT_TICK_BATCH_MS);
    this.resolutionIntervalMs = positive(
      deps.resolutionIntervalMs,
      DEFAULT_RESOLUTION_INTERVAL_MS,
    );
    this.resolutionSliceMs = positive(
      deps.resolutionSliceMs,
      DEFAULT_RESOLUTION_SLICE_MS,
    );
    this.resolutionConcurrency = positive(
      deps.resolutionConcurrency,
      DEFAULT_RESOLUTION_CONCURRENCY,
    );
    this.pingMs = positive(deps.pingMs, DEFAULT_PING_MS);
    this.reconnectBaseMs = positive(
      deps.reconnectBaseMs,
      DEFAULT_RECONNECT_BASE_MS,
    );
    this.reconnectMaxMs = positive(deps.reconnectMaxMs, DEFAULT_RECONNECT_MAX_MS);
    this.socketGraceMs = positive(deps.socketGraceMs, DEFAULT_SOCKET_GRACE_MS);
    this.handshakeMs = positive(deps.handshakeMs, DEFAULT_HANDSHAKE_MS);
    // PRIVATE clients. The resolver's module-level singletons are deliberately
    // untouched: a display-side rate limit or poisoned cache must never be
    // able to reach a scored verdict.
    this.gamma = new PolymarketGammaClient({
      nowMs: deps.nowMs,
      ...(deps.gammaBaseUrl !== undefined ? { baseUrl: deps.gammaBaseUrl } : {}),
      ...(deps.fetchFn !== undefined ? { fetchFn: deps.fetchFn } : {}),
      ttlActiveMs: GAMMA_TTL_ACTIVE_MS,
      ttlNegativeMs: GAMMA_TTL_NEGATIVE_MS,
    });
    this.clob = new PolymarketClobClient({
      nowMs: deps.nowMs,
      ...(deps.clobBaseUrl !== undefined ? { baseUrl: deps.clobBaseUrl } : {}),
      ...(deps.fetchFn !== undefined ? { fetchFn: deps.fetchFn } : {}),
    });
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  /** Open the socket and start every timer. Safe to call once. */
  async start(): Promise<void> {
    if (this.started || this.stopped) return;
    this.started = true;
    this.socketFactory = await loadSocketFactory();
    // stop() may have landed during that await; installing timers now would
    // leak them past shutdown.
    if (this.stopped) return;
    this.syncTrackedSet();
    this.trackedTimer = setInterval(() => {
      this.syncTrackedSet();
    }, this.trackedRefreshMs);
    this.batchTimer = setInterval(() => {
      this.flushBatch();
    }, this.tickBatchMs);
    this.resolutionTimer = setInterval(() => {
      this.pumpResolutionPolls();
    }, this.resolutionSliceMs);
    this.logger.log(
      `[venue-ticker] started (${this.markets.size} markets tracked)`,
    );
  }

  /**
   * Reverse of start(). The stopped flag is raised BEFORE the socket closes
   * so the close handler cannot schedule a reconnect, every timer is cleared,
   * in-flight polls are awaited, post-await emissions are suppressed, and
   * every SSE client is closed (`server.close()` does not do that).
   */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.clearTimer("trackedTimer");
    this.clearTimer("batchTimer");
    this.clearTimer("resolutionTimer");
    this.clearTimer("pingTimer");
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.closeSocket();
    const pending = [...this.inFlightPolls];
    if (pending.length > 0) await Promise.allSettled(pending);
    this.inFlightPolls.clear();
    this.dirty.clear();
    this.pendingRemovals.clear();
    for (const subscriber of [...this.subscribers]) {
      this.subscribers.delete(subscriber);
      try {
        subscriber.onClose();
      } catch {
        // A transport that already died must not block shutdown.
      }
    }
    this.logger.log("[venue-ticker] stopped");
  }

  // ─── Read interface ───────────────────────────────────────────────────────

  running(): boolean {
    return this.started && !this.stopped;
  }

  snapshot(input?: { marketIds?: readonly string[] }): VenueSnapshotResult {
    const ts = isoMillis(this.nowMs());
    const requested = input?.marketIds;
    if (requested === undefined) {
      const markets = [...this.markets.keys()].map((id) => this.rowFor(id)!);
      return {
        ts,
        markets,
        resolutions: [...this.resolutions.values()],
        truncated: false,
      };
    }
    const deduped: string[] = [];
    const seen = new Set<string>();
    for (const raw of requested) {
      const key = raw.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(raw);
    }
    const truncated = deduped.length > VENUE_SNAPSHOT_MAX_MARKETS;
    const capped = deduped.slice(0, VENUE_SNAPSHOT_MAX_MARKETS);
    const markets: Array<VenueMarketRow | VenueUnknownMarketRow> = [];
    const resolutions: VenueResolutionRow[] = [];
    for (const marketId of capped) {
      const row = this.rowFor(marketId);
      markets.push(row ?? { market_id: marketId, freshness: "unknown" });
      const resolution = this.resolutionFor(marketId);
      if (resolution) resolutions.push(resolution);
    }
    return { ts, markets, resolutions, truncated };
  }

  subscribe(subscriber: VenueTickerSubscriber): () => void {
    if (this.stopped) {
      // Never leave a late subscriber hanging on a bus that will not emit.
      try {
        subscriber.onClose();
      } catch {
        // Transport already gone.
      }
      return () => undefined;
    }
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  // ─── Tracked set ──────────────────────────────────────────────────────────

  /**
   * Recompute the tracked set and, when its SIGNATURE changed, reconnect.
   *
   * The signature covers market ids, resolution instants AND token ids: a
   * re-registered market can rewrite its token map under a stable id, and
   * the socket would otherwise keep streaming the retired tokens.
   *
   * Both halves of the predicate matter. `status='listed'` alone loses every
   * just-ended market, because discovery freezes ended listed rows within one
   * 60s tick — so the lookback half also accepts `frozen`.
   */
  syncTrackedSet(): void {
    if (this.stopped) return;
    const now = this.nowMs();
    let rows: TrackedRow[];
    try {
      rows = this.db
        .prepare(TRACKED_SQL)
        .all({
          adapter: VENUE_TICKER_ADAPTER_ID,
          now,
          horizon: now + this.horizonMs,
          lookback: now - this.lookbackMs,
          cap: this.maxTracked,
        }) as TrackedRow[];
    } catch (err) {
      this.logger.warn(
        `[venue-ticker] tracked-set query failed: ${errorText(err)}`,
      );
      return;
    }
    const tracked: TrackedMarket[] = [];
    for (const row of rows) {
      const parsed = parseTrackedRow(row);
      if (parsed === null) {
        if (!this.skipped.has(row.market_id)) {
          // Skipped ids are never re-tracked, so this set has no natural
          // eviction; clear it wholesale rather than let it grow for the
          // life of the process. Worst case one extra log line per id.
          if (this.skipped.size > 1_000) this.skipped.clear();
          this.skipped.add(row.market_id);
          this.logger.warn(
            `[venue-ticker] skipping ${row.market_id}: missing or malformed ` +
              `config_json.clobTokenIds`,
          );
        }
        continue;
      }
      tracked.push(parsed);
    }
    const signature = trackedSignature(tracked);
    if (signature === this.trackedSignature) {
      // Nothing to resubscribe to. A pending reconnect owns the socket, so
      // opening one here would race it and drop the backoff on the floor.
      if (this.socket !== null || this.reconnectTimer !== null) return;
    }
    this.trackedSignature = signature;
    this.applyTrackedSet(tracked);
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempts = 0;
    this.openSocket();
  }

  private applyTrackedSet(tracked: TrackedMarket[]): void {
    const keep = new Set(tracked.map((m) => m.marketId));
    for (const marketId of [...this.markets.keys()]) {
      if (!keep.has(marketId)) {
        // Everything keyed on this market goes with it. `resolution_at_ms` is
        // fixed per market and only recedes, so a market that has aged out of
        // the lookback can never re-enter and re-emit — which is what keeps
        // all four of these maps bounded by the tracked cap rather than by
        // daemon uptime.
        this.markets.delete(marketId);
        this.dirty.delete(marketId);
        this.resolutionProgress.delete(marketId);
        this.resolutions.delete(marketId);
        // …including on every CONNECTED client. Delta ticks only add, so
        // without a tombstone the row lives on in the browser forever.
        this.pendingRemovals.add(marketId);
      }
    }
    this.tokenIndex.clear();
    for (const market of tracked) {
      const existing = this.markets.get(market.marketId);
      const tokensUnchanged =
        existing !== undefined &&
        existing.tracked.outcomes.length === market.outcomes.length &&
        existing.tracked.outcomes.every(
          (outcome, i) => outcome.tokenId === market.outcomes[i]!.tokenId,
        );
      if (existing && tokensUnchanged) {
        existing.tracked = market;
      } else {
        // New market, or the token map was rewritten — drop any quote state
        // keyed on the retired tokens rather than showing it under new labels.
        this.markets.set(market.marketId, {
          tracked: market,
          quotes: new Map(
            market.outcomes.map((outcome) => [
              outcome.tokenId,
              {
                bestBid: null,
                bestAsk: null,
                lastTradePrice: null,
                seeded: false,
                // A brand-new outcome has no quotes at all, so it reads
                // 'warming'; `stale` only ever describes data already shown.
                stale: { bid: false, ask: false, lastTrade: false },
              } satisfies QuoteState,
            ]),
          ),
          updatedAtMs: null,
        });
      }
      for (const outcome of market.outcomes) {
        this.tokenIndex.set(outcome.tokenId, market.marketId);
      }
    }
  }

  // ─── Websocket ────────────────────────────────────────────────────────────

  private openSocket(): void {
    if (this.stopped) return;
    this.closeSocket();
    const assets = [...this.tokenIndex.keys()];
    // Polymarket accepts an empty subscription but sends nothing for it, so a
    // socket with no assets is pure cost.
    if (assets.length === 0 || this.socketFactory === null) return;
    let socket: VenueSocket;
    try {
      socket = this.socketFactory(this.wsUrl);
    } catch (err) {
      this.logger.warn(`[venue-ticker] socket open failed: ${errorText(err)}`);
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    // A handshake that never completes fires neither 'open' nor 'close', so
    // nothing else in this class would ever notice. Tear it down and let the
    // normal backoff own the retry.
    this.handshakeTimer = setTimeout(() => {
      this.handshakeTimer = null;
      if (this.stopped || this.socket !== socket || this.connected) return;
      this.logger.warn(
        `[venue-ticker] handshake timed out after ${this.handshakeMs}ms`,
      );
      this.closeSocket();
      this.scheduleReconnect();
    }, this.handshakeMs);
    this.handshakeTimer.unref?.();
    /** Did THIS socket ever deliver a frame? See the attempts reset below. */
    let receivedFrame = false;
    socket.on("open", () => {
      if (this.stopped || this.socket !== socket) return;
      this.clearHandshakeTimer();
      this.connected = true;
      // NOT the place to reset the backoff. A server that accepts the TCP
      // connection and then rejects or drops the subscription would reset the
      // counter on every attempt and spin at the base delay forever; the first
      // FRAME is the earliest proof the connection is actually serving us.
      try {
        socket.send(JSON.stringify({ type: "market", assets_ids: assets }));
      } catch (err) {
        // Same rule as the PING send: a throw here means the socket died
        // between 'open' and this line, and a subscription that never left is
        // a socket that will never carry data.
        this.logger.warn(`[venue-ticker] subscribe failed: ${errorText(err)}`);
        this.closeSocket();
        this.scheduleReconnect();
        return;
      }
      this.startPing(socket);
    });
    socket.on("message", (data, isBinary) => {
      if (this.stopped || this.socket !== socket) return;
      if (!receivedFrame) {
        receivedFrame = true;
        this.reconnectAttempts = 0;
      }
      if (isBinary) return;
      this.handleFrame(String(data));
    });
    socket.on("error", (err) => {
      if (this.stopped || this.socket !== socket) return;
      this.logger.warn(`[venue-ticker] socket error: ${err.message}`);
    });
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.connected = false;
      this.socket = null;
      this.clearTimer("pingTimer");
      this.clearHandshakeTimer();
      // Every tracked row is now unverifiable — mark the whole board stale.
      this.markAllStale();
      if (this.stopped) return;
      this.scheduleReconnect();
    });
  }

  /**
   * Freshness reports TRANSPORT health, so a dropped socket has to reach the
   * board even when no price changed: without this, `rowFor` would keep
   * answering 'live' to anyone who never asks again, and a client watching a
   * dead reconnect sees a live badge over frozen numbers.
   */
  private markAllStale(): void {
    for (const [marketId, state] of this.markets) {
      // Per FIELD: every number on screen has to be re-proved by its own
      // arrival. Anything coarser lets one value vouch for another — one
      // outcome for the other, or a fresh last trade for a stale bid.
      for (const quote of state.quotes.values()) {
        quote.stale.bid = true;
        quote.stale.ask = true;
        quote.stale.lastTrade = true;
      }
      this.dirty.add(marketId);
    }
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer !== null) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
  }

  private startPing(socket: VenueSocket): void {
    this.clearTimer("pingTimer");
    this.awaitingPong = false;
    this.pingTimer = setInterval(() => {
      if (this.stopped || this.socket !== socket) return;
      if (this.awaitingPong) {
        // The previous PING was never answered — the socket is a zombie.
        this.awaitingPong = false;
        this.closeSocket();
        this.scheduleReconnect();
        return;
      }
      this.awaitingPong = true;
      try {
        socket.send("PING");
      } catch {
        // A send that throws means the socket is already gone in a way `ws`
        // has not surfaced yet. Clearing the flag alone would leave a dead
        // socket installed and no reconnect scheduled — the feed would simply
        // stop, silently. Treat it exactly like an unanswered PING.
        this.awaitingPong = false;
        this.closeSocket();
        this.scheduleReconnect();
      }
    }, this.pingMs);
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== null) return;
    const base = Math.min(
      this.reconnectMaxMs,
      this.reconnectBaseMs * 2 ** Math.min(this.reconnectAttempts, 6),
    );
    // ±20%. Without it, every daemon (and every tab) that lost the venue at the
    // same instant retries at the same instant, so the venue's first breath
    // after a blip is spent serving a synchronized stampede.
    const jitter = base * RECONNECT_JITTER * (Math.random() * 2 - 1);
    const delay = Math.max(0, Math.round(base + jitter));
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopped) return;
      this.openSocket();
    }, delay);
  }

  private closeSocket(): void {
    const socket = this.socket;
    this.clearTimer("pingTimer");
    this.clearHandshakeTimer();
    this.connected = false;
    this.socket = null;
    if (!socket) return;
    // An INTENTIONAL close is exactly as fatal to freshness as a spontaneous
    // one — the ping-triggered zombie teardown, a send failure, or a tracked-set
    // reconnect all leave the board unverifiable. `removeAllListeners()` below
    // means the 'close' handler that normally does this will NEVER run for this
    // socket, so the stale transition has to be published here or clients keep
    // showing "live" straight through a dead reconnect.
    this.markAllStale();
    socket.removeAllListeners();
    // Re-arm an error sink BEFORE closing. Closing a socket that is still
    // CONNECTING makes `ws` emit 'error' ("closed before the connection was
    // established"), and an EventEmitter with no 'error' listener rethrows
    // it as an uncaught exception that would take the daemon down mid-stop.
    socket.on("error", () => undefined);
    try {
      socket.close();
    } catch {
      // Already closing.
    }
    // A half-open TCP connection would keep the event loop alive past
    // shutdown, so escalate to terminate() after a short grace window. The
    // timer is unref'd — it must never itself be the reason we stay up — and
    // is cleared as soon as the socket actually closes.
    const grace = setTimeout(() => {
      try {
        socket.terminate();
      } catch {
        // Already gone.
      }
    }, this.socketGraceMs);
    grace.unref?.();
    socket.once("close", () => clearTimeout(grace));
  }

  /**
   * Apply one text frame. Handles the three verified shapes plus the two
   * non-JSON control replies (`PONG`, `INVALID OPERATION`).
   */
  handleFrame(raw: string): void {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return;
    if (trimmed === "PONG") {
      this.awaitingPong = false;
      return;
    }
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
      // e.g. the verified `INVALID OPERATION` reply to a resubscribe attempt.
      this.logger.warn(`[venue-ticker] control frame: ${trimmed.slice(0, 64)}`);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return;
    }
    for (const event of Array.isArray(parsed) ? parsed : [parsed]) {
      if (event === null || typeof event !== "object") continue;
      const record = event as Record<string, unknown>;
      switch (record.event_type) {
        case "book":
          this.applyBook(record);
          break;
        case "price_change":
          this.applyPriceChange(record);
          break;
        case "last_trade_price":
          this.applyLastTrade(record);
          break;
        default:
          break;
      }
    }
  }

  private applyBook(event: Record<string, unknown>): void {
    const assetId = stringField(event.asset_id);
    if (assetId === null) return;
    const target = this.quoteFor(assetId);
    if (target === null) return;
    // Ordering is not part of the contract — take the extremes explicitly.
    //
    // "Answered" is a STRUCTURAL question, not a value one. An empty `bids`
    // array is the venue stating there is no bid side right now — a real market
    // state, and a perfectly good answer. Only a side that is missing, or one
    // that carries levels we could not read, has failed to say anything.
    // Collapsing those two cases left a genuinely empty book indistinguishable
    // from garbage, so an outcome whose side legitimately has no market stayed
    // 'warming' forever even though the venue had answered.
    const bid = bookSide(event.bids, "max");
    const ask = bookSide(event.asks, "min");
    const lastTrade = probabilityField(event.last_trade_price);
    if (!bid.answered && !ask.answered && lastTrade === null) return;
    // Written per side, and freshness clears per side with it: an answered side
    // lands (including its real null), a garbled one leaves whatever was
    // already there rather than erasing a good quote on unreadable data — and
    // keeps its stale flag, because nothing about it was re-proved.
    if (bid.answered) {
      target.quote.bestBid = bid.price;
      target.quote.stale.bid = false;
    }
    if (ask.answered) {
      target.quote.bestAsk = ask.price;
      target.quote.stale.ask = false;
    }
    if (lastTrade !== null) {
      target.quote.lastTradePrice = lastTrade;
      target.quote.stale.lastTrade = false;
    }
    target.quote.seeded = true;
    this.touch(target.marketId, event.timestamp);
  }

  private applyPriceChange(event: Record<string, unknown>): void {
    const changes = event.price_changes;
    if (!Array.isArray(changes)) return;
    for (const change of changes) {
      if (change === null || typeof change !== "object") continue;
      const record = change as Record<string, unknown>;
      const assetId = stringField(record.asset_id);
      if (assetId === null) continue;
      const target = this.quoteFor(assetId);
      if (target === null) continue;
      // `price`/`size`/`side` describe the changed LEVEL, not the market
      // price. Only the top-of-book fields are quotes.
      const bid = probabilityField(record.best_bid);
      const ask = probabilityField(record.best_ask);
      // Both quotes out of range ⇒ this change applies nothing. It used to
      // set `seeded` and clear staleness regardless, so a stream of malformed
      // numbers could carry an outcome from 'warming' to 'live' with every
      // price still null.
      if (bid === null && ask === null) continue;
      // A price_change never carries a last trade, so it cannot refresh one.
      if (bid !== null) {
        target.quote.bestBid = bid;
        target.quote.stale.bid = false;
      }
      if (ask !== null) {
        target.quote.bestAsk = ask;
        target.quote.stale.ask = false;
      }
      target.quote.seeded = true;
      this.touch(target.marketId, event.timestamp);
    }
  }

  private applyLastTrade(event: Record<string, unknown>): void {
    const assetId = stringField(event.asset_id);
    if (assetId === null) return;
    const target = this.quoteFor(assetId);
    if (target === null) return;
    // An out-of-range price applies nothing — already the early return here.
    const price = probabilityField(event.price);
    if (price === null) return;
    // ONLY the last trade is refreshed. A trade print says nothing about where
    // the book now rests, so `best_bid`/`best_ask` keep their stale flags — the
    // whole reason this granularity exists.
    target.quote.lastTradePrice = price;
    target.quote.stale.lastTrade = false;
    target.quote.seeded = true;
    this.touch(target.marketId, event.timestamp);
  }

  private quoteFor(
    assetId: string,
  ): { marketId: string; quote: QuoteState } | null {
    const marketId = this.tokenIndex.get(assetId);
    if (marketId === undefined) return null;
    const state = this.markets.get(marketId);
    if (state === undefined) return null;
    const quote = state.quotes.get(assetId);
    if (quote === undefined) return null;
    return { marketId, quote };
  }

  /**
   * Record that an outcome's quote actually changed. Callers invoke this ONLY
   * after applying a validated value, so `updated_at` means what it says —
   * "the last frame applied" — rather than "the last frame that arrived".
   */
  private touch(marketId: string, venueTimestamp: unknown): void {
    const state = this.markets.get(marketId);
    if (state === undefined) return;
    // Prefer the venue's own stamp; fall back to local time when the frame
    // omits it or ships something outside the plausible range. `> 0` was not
    // enough: `"1e100"` is finite and positive, and it reaches
    // `new Date(ms).toISOString()` in rowFor(), which throws RangeError —
    // from a setInterval callback, i.e. OUTSIDE the per-message try/catch, so
    // one malformed frame killed the daemon.
    const now = this.nowMs();
    state.updatedAtMs = venueTimestampMs(venueTimestamp, now) ?? now;
    this.dirty.add(marketId);
  }

  // ─── Batched emission ─────────────────────────────────────────────────────

  /** ONE frame per interval carrying every dirty market plus any tombstones. */
  flushBatch(): void {
    if (this.stopped) return;
    if (this.dirty.size === 0 && this.pendingRemovals.size === 0) return;
    const markets: VenueMarketRow[] = [];
    for (const marketId of this.dirty) {
      const row = this.rowFor(marketId);
      if (row !== null) markets.push(row);
    }
    const removed = [...this.pendingRemovals];
    this.dirty.clear();
    this.pendingRemovals.clear();
    // An eviction-only batch STILL ships — including the everything-evicted
    // case, where `markets` is empty and the tombstones are the whole message.
    if (markets.length === 0 && removed.length === 0) return;
    this.emit({
      type: "venue_tick",
      markets,
      ...(removed.length > 0 ? { removed } : {}),
      ts: isoMillis(this.nowMs()),
    });
  }

  private emit(event: VenueTickerEvent): void {
    if (this.stopped) return;
    for (const subscriber of this.subscribers) {
      try {
        subscriber.onEvent(event);
      } catch {
        // One bad transport must not stop the fan-out.
      }
    }
  }

  private rowFor(marketId: string): VenueMarketRow | null {
    const state = this.markets.get(marketId);
    if (state === undefined) return null;
    const outcomes = state.tracked.outcomes.map((outcome) => {
      const quote = state.quotes.get(outcome.tokenId);
      const bestBid = quote?.bestBid ?? null;
      const bestAsk = quote?.bestAsk ?? null;
      return {
        label: outcome.label,
        token_id: outcome.tokenId,
        price: midPrice(bestBid, bestAsk, quote?.lastTradePrice ?? null),
        best_bid: bestBid,
        best_ask: bestAsk,
        last_trade_price: quote?.lastTradePrice ?? null,
      } satisfies VenueOutcomeQuote;
    });
    const quotes = state.tracked.outcomes.map((outcome) =>
      state.quotes.get(outcome.tokenId),
    );
    const seeded = quotes.every((quote) => quote?.seeded === true);
    // ANY seeded outcome still carrying pre-disconnect data makes the whole row
    // stale. Both outcomes are quoted independently and neither can vouch for
    // the other, so 'live' is the strictly stronger claim: EVERY outcome has
    // been refreshed since the last transport failure.
    const anyStale = quotes.some(
      (quote) => quote?.seeded === true && quoteIsStale(quote),
    );
    // Freshness reports TRANSPORT health, not market activity: a quiet market
    // with a valid book is 'live', while a book we can no longer verify
    // because the socket dropped is 'stale' however recent it looks.
    //
    // `warming` outranks `stale`: a row that never had a book has no numbers to
    // be stale ABOUT, and "no data yet" is a different thing to say than "the
    // data on screen cannot be verified".
    //
    // Read from each outcome's own stored flag, never from `this.connected` —
    // see QuoteState.stale for both bugs that produced this rule.
    const freshness: VenueFreshness = !seeded
      ? "warming"
      : anyStale
        ? "stale"
        : "live";
    return {
      market_id: marketId,
      outcomes,
      updated_at:
        state.updatedAtMs === null ? null : isoMillis(state.updatedAtMs),
      freshness,
    };
  }

  private resolutionFor(marketId: string): VenueResolutionRow | undefined {
    const direct = this.resolutions.get(marketId);
    if (direct) return direct;
    const lower = marketId.toLowerCase();
    for (const [key, value] of this.resolutions) {
      if (key.toLowerCase() === lower) return value;
    }
    return undefined;
  }

  // ─── Resolution observer ──────────────────────────────────────────────────

  /**
   * Start at most (concurrency − inflight) polls per slice. Spreading the
   * work this way keeps the observer to ≤2 concurrent upstream requests and
   * never does invalidate-all + Promise.all across the tracked set.
   */
  pumpResolutionPolls(): void {
    if (this.stopped) return;
    const now = this.nowMs();
    const due = [...this.markets.values()].filter((state) => {
      if (state.tracked.resolutionAtMs > now) return false;
      const progress = this.resolutionProgress.get(state.tracked.marketId);
      if (progress === undefined) return true;
      if (progress.emitted) return false;
      return now - progress.lastPolledAtMs >= this.resolutionIntervalMs;
    });
    if (due.length === 0) return;
    let started = 0;
    const budget = this.resolutionConcurrency - this.inFlightPolls.size;
    for (let i = 0; i < due.length && started < budget; i++) {
      const state = due[(this.resolutionCursor + i) % due.length]!;
      const progress = this.resolutionProgress.get(state.tracked.marketId);
      if (progress?.emitted) continue;
      this.resolutionProgress.set(state.tracked.marketId, {
        lastPolledAtMs: now,
        emitted: false,
      });
      started += 1;
      const promise = this.pollResolution(state.tracked).finally(() => {
        this.inFlightPolls.delete(promise);
      });
      this.inFlightPolls.add(promise);
    }
    this.resolutionCursor = (this.resolutionCursor + started) % Math.max(
      1,
      due.length,
    );
  }

  /**
   * A poll started before an eviction can land after it. Re-checked after EVERY
   * await, because a late writer would otherwise resurrect the market: it
   * re-populates `resolutions`/`resolutionProgress` for an id no longer in
   * `markets`, so the entry is orphaned (nothing evicts it a second time — the
   * eviction sweep only walks `markets`) and the emitted `venue_resolution`
   * describes a market no client is tracking any more.
   */
  private stillTracked(marketId: string): boolean {
    return !this.stopped && this.markets.has(marketId);
  }

  private async pollResolution(tracked: TrackedMarket): Promise<void> {
    let row: VenueResolutionRow | null = null;
    try {
      const gammaResult = await this.gamma.fetchMarketByConditionId(
        tracked.conditionId,
      );
      if (!this.stillTracked(tracked.marketId)) return;
      if (gammaResult.snapshot !== null) {
        const outcome = gammaMarketToOutcome(gammaResult.snapshot);
        if (typeof outcome !== "string") {
          row = resolutionRow(tracked, outcome, "gamma");
        }
      } else {
        // Gamma absence post-close is NORMAL for 5-minute micro-markets, so
        // this is the expected branch rather than an error path.
        row = await this.pollClobFallback(tracked);
        if (!this.stillTracked(tracked.marketId)) return;
      }
    } catch (err) {
      this.logger.warn(
        `[venue-ticker] resolution poll failed for ${tracked.marketId}: ` +
          errorText(err),
      );
      return;
    }
    // The awaits above may have straddled stop() or an eviction; never write or
    // emit afterwards.
    if (!this.stillTracked(tracked.marketId) || row === null) return;
    const progress = this.resolutionProgress.get(tracked.marketId);
    if (progress?.emitted) return;
    this.resolutionProgress.set(tracked.marketId, {
      lastPolledAtMs: this.nowMs(),
      emitted: true,
    });
    this.resolutions.set(tracked.marketId, row);
    this.emit({ type: "venue_resolution", ...row });
  }

  private async pollClobFallback(
    tracked: TrackedMarket,
  ): Promise<VenueResolutionRow | null> {
    const result = await this.clob.fetchMarketByConditionId(
      tracked.conditionId,
    );
    if (result.snapshot === null) return null;
    const mapped = clobMarketToOutcome({
      conditionId: tracked.conditionId,
      storedOutcomes: tracked.outcomes.map((outcome) => outcome.label),
      storedClobTokenIds: Object.fromEntries(
        tracked.outcomes.map((outcome) => [
          normalizeOutcomeLabel(outcome.label),
          outcome.tokenId,
        ]),
      ),
      endDate: tracked.endDate,
      snapshot: result.snapshot,
    });
    if (mapped.kind === "pending") return null;
    return resolutionRow(tracked, mapped.outcome, "clob");
  }

  // ─── Utility ──────────────────────────────────────────────────────────────

  private clearTimer(
    field: "trackedTimer" | "batchTimer" | "resolutionTimer" | "pingTimer",
  ): void {
    const handle = this[field];
    if (handle !== null) {
      clearInterval(handle);
      this[field] = null;
    }
  }
}

// ─── Tracked-set SQL + parsing ──────────────────────────────────────────────

interface TrackedRow {
  market_id: string;
  config_json: string;
  resolution_at_ms: number;
}

/**
 * The tracked predicate. Two halves:
 *   · FUTURE  — `listed` and resolving inside the horizon (bounded so a
 *               far-dated market can never crowd out the live board).
 *   · RECENT  — resolved within the lookback, `listed` OR `frozen`, because
 *               discovery freezes ended listed rows within one 60s tick.
 * `operator_halted_at IS NULL` excludes anything an operator pulled.
 * Ordering is "closest to now first" so the cap keeps the markets a board
 * actually shows rather than the far tail in either direction.
 */
const TRACKED_SQL = `
  SELECT m.market_id AS market_id,
         m.config_json AS config_json,
         c.resolution_at_ms AS resolution_at_ms
    FROM markets m
    JOIN market_clocks c ON c.market_id = m.market_id
   WHERE m.adapter_id = @adapter
     AND m.operator_halted_at IS NULL
     AND (
           (m.status = 'listed'
             AND c.resolution_at_ms > @now
             AND c.resolution_at_ms <= @horizon)
        OR (m.status IN ('listed','frozen')
             AND c.resolution_at_ms <= @now
             AND c.resolution_at_ms >= @lookback)
         )
   ORDER BY ABS(c.resolution_at_ms - @now) ASC, m.market_id ASC
   LIMIT @cap
`;

export function parseTrackedRow(row: TrackedRow): TrackedMarket | null {
  let config: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(row.config_json);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    config = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const conditionId =
    typeof config.conditionId === "string" &&
    POLYMARKET_CONDITION_ID_REGEX.test(config.conditionId)
      ? config.conditionId
      : null;
  if (conditionId === null) return null;
  const labels = config.outcomes;
  if (
    !Array.isArray(labels) ||
    labels.length !== 2 ||
    !labels.every((label) => typeof label === "string" && label.length > 0)
  ) {
    return null;
  }
  // `clobTokenIds` is a normalized-label → tokenId OBJECT, not an array.
  const tokenMap = config.clobTokenIds;
  if (
    tokenMap === null ||
    typeof tokenMap !== "object" ||
    Array.isArray(tokenMap)
  ) {
    return null;
  }
  const outcomes: TrackedOutcome[] = [];
  for (const label of labels as string[]) {
    const tokenId = (tokenMap as Record<string, unknown>)[
      normalizeOutcomeLabel(label)
    ];
    if (typeof tokenId !== "string" || tokenId.length === 0) return null;
    outcomes.push({ label, tokenId });
  }
  if (outcomes[0]!.tokenId === outcomes[1]!.tokenId) return null;
  return {
    marketId: row.market_id,
    conditionId,
    endDate: typeof config.endDate === "string" ? config.endDate : null,
    resolutionAtMs: row.resolution_at_ms,
    outcomes,
  };
}

/** Ids AND token ids AND resolution instants — a re-registered market that
 *  rewrites its token map must force a resubscribe, and resubscribing on a
 *  live socket is refused by the venue (verified), so this drives a
 *  reconnect. */
export function trackedSignature(tracked: readonly TrackedMarket[]): string {
  return tracked
    .map(
      (market) =>
        `${market.marketId}:${market.resolutionAtMs}:` +
        market.outcomes.map((o) => `${o.label}=${o.tokenId}`).join(","),
    )
    .sort()
    .join("|");
}

// ─── Pure helpers ───────────────────────────────────────────────────────────

function resolutionRow(
  tracked: TrackedMarket,
  outcome: {
    payoutNumerators: bigint[];
    payoutDenominator: bigint;
    resolvedAt: number;
  },
  source: "gamma" | "clob",
): VenueResolutionRow | null {
  // The venue's own stamp, in SECONDS. A value outside the plausible range
  // would throw out of `isoFromMs`; refusing the row is the honest answer,
  // because substituting the poll time would publish a resolution instant
  // murmur invented on a surface whose whole contract is that it did not.
  const resolvedAtMs = outcome.resolvedAt * 1000;
  if (
    !Number.isFinite(resolvedAtMs) ||
    resolvedAtMs < VENUE_TS_MIN_MS ||
    resolvedAtMs > Date.now() + VENUE_TS_FUTURE_SLACK_MS
  ) {
    return null;
  }
  const denominator = outcome.payoutDenominator === 0n
    ? 1n
    : outcome.payoutDenominator;
  const prices = outcome.payoutNumerators.map(
    (numerator) => Number(numerator) / Number(denominator),
  );
  const labels = tracked.outcomes.map((o) => o.label);
  let winningLabel: string | null = null;
  let best = -1;
  let tied = false;
  for (let i = 0; i < prices.length && i < labels.length; i++) {
    const price = prices[i]!;
    if (price > best) {
      best = price;
      winningLabel = labels[i]!;
      tied = false;
    } else if (price === best) {
      tied = true;
    }
  }
  // A 50-50 or cancelled payout vector has no winner. Naming one would be a
  // fabricated result on a public surface.
  if (tied || best <= 0) winningLabel = null;
  return {
    market_id: tracked.marketId,
    outcome_labels: labels,
    outcome_prices: prices,
    resolved_at: isoFromMs(resolvedAtMs),
    winning_label: winningLabel,
    source,
  };
}

/**
 * Live stamps keep milliseconds. The repo-wide `isoFromMs` strips them, which
 * is right for the second-granularity instants murmur records elsewhere, but
 * this feed updates several times per second — collapsing those to the same
 * string would make consecutive ticks indistinguishable to the UI.
 * `resolved_at` still uses `isoFromMs`: it is a venue resolution stamp and is
 * seconds-precision at the source.
 */
function isoMillis(ms: number): string {
  // Belt and braces. Every caller now passes a validated instant, but this is
  // the single choke point where a bad number becomes a thrown RangeError on a
  // timer callback, so it refuses to be that choke point.
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

/**
 * A venue millisecond stamp, or null when it is not one.
 *
 * The venue sends `timestamp` as a decimal string and has no obligation to send
 * a sane one. Bounded on BOTH sides: below the floor is a seconds/milliseconds
 * mix-up or a zero, above `now + 1 day` is a value that can only be wrong.
 */
export function venueTimestampMs(value: unknown, nowMs: number): number | null {
  const parsed = numberField(value);
  if (parsed === null) return null;
  const ms = Math.round(parsed);
  if (!Number.isSafeInteger(ms)) return null;
  if (ms < VENUE_TS_MIN_MS) return null;
  if (ms > nowMs + VENUE_TS_FUTURE_SLACK_MS) return null;
  return ms;
}

/**
 * A 0..1 probability, or null.
 *
 * Every price on this feed is a share price on a binary outcome, so anything
 * outside [0,1] is a malformed frame — and a value like `1e100` reaching the
 * mid computation would render as a nonsense probability on a public board.
 * The out-of-range FIELD is dropped; the rest of the frame still applies.
 */
export function probabilityField(value: unknown): number | null {
  const parsed = numberField(value);
  if (parsed === null) return null;
  return parsed >= 0 && parsed <= 1 ? parsed : null;
}

function midPrice(
  bestBid: number | null,
  bestAsk: number | null,
  lastTradePrice: number | null,
): number | null {
  if (bestBid !== null && bestAsk !== null) return (bestBid + bestAsk) / 2;
  if (bestBid !== null) return bestBid;
  if (bestAsk !== null) return bestAsk;
  return lastTradePrice;
}

/**
 * Is this outcome showing a number that predates the last transport failure?
 *
 * A flagged field only lies if it has something to lie WITH. A null field
 * renders as nothing at all — an empty cell cannot misinform anyone — so a
 * flagged null is ignored rather than holding the whole row on 'stale'
 * indefinitely. Non-null AND flagged is exactly the set of numbers a reader can
 * see but we cannot currently vouch for.
 */
function quoteIsStale(quote: QuoteState): boolean {
  return (
    (quote.bestBid !== null && quote.stale.bid) ||
    (quote.bestAsk !== null && quote.stale.ask) ||
    (quote.lastTradePrice !== null && quote.stale.lastTrade)
  );
}

/**
 * One side of a book, split into "did the venue answer?" and "what did it say?".
 *
 * The two are genuinely independent, and conflating them is what made an empty
 * book look like a broken one:
 *   · not an array      → no answer (the frame omitted this side entirely);
 *   · empty array       → ANSWERED, price null. There is no market on this
 *                         side right now, which is a fact about the book, not
 *                         a failure to report one;
 *   · levels, none usable → no answer. The venue said something; we could not
 *                         read any of it, so we know nothing new.
 */
interface BookSideRead {
  answered: boolean;
  price: number | null;
}

function bookSide(levels: unknown, pick: "max" | "min"): BookSideRead {
  if (!Array.isArray(levels)) return { answered: false, price: null };
  if (levels.length === 0) return { answered: true, price: null };
  const price = extremePrice(levels, pick);
  return { answered: price !== null, price };
}

function extremePrice(levels: unknown, pick: "max" | "min"): number | null {
  if (!Array.isArray(levels)) return null;
  let chosen: number | null = null;
  for (const level of levels) {
    if (level === null || typeof level !== "object") continue;
    const record = level as Record<string, unknown>;
    const price = probabilityField(record.price);
    if (price === null) continue;
    const size = numberField(record.size);
    if (size !== null && size <= 0) continue;
    if (chosen === null) chosen = price;
    else if (pick === "max") chosen = Math.max(chosen, price);
    else chosen = Math.min(chosen, price);
  }
  return chosen;
}

function numberField(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** `ws` is loaded lazily so importing this module never costs a socket. */
async function loadSocketFactory(): Promise<VenueSocketFactory> {
  const mod = await import("ws");
  const Ctor = (mod.default ?? mod) as unknown as new (url: string) => VenueSocket;
  return (url: string) => new Ctor(url);
}
