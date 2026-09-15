/**
 * Venue ticker: live Polymarket order-book + resolution feed for the market board. DISPLAY ONLY.
 *
 * Pure-referee boundary (venue-ticker-referee.smoke.ts): no resolver module imports this and it
 * imports none. Gamma/CLOB clients are private instances, never the adapter's singletons.
 *
 * CLOB websocket quirks (live-probed, mostly undocumented):
 *  · `assets_ids` are CLOB token ids, not condition ids.
 *  · Book order isn't guaranteed: best bid = max(bid.price), best ask = min(ask.price).
 *  · Book frames recur mid-stream as arrays of any length.
 *  · In price_change, `price`/`size`/`side` are the changed level; only best_bid/best_ask are quotes.
 *  · Keepalive required: an idle socket is closed at ~126s (1006). Ping every 10s; no PONG = dead.
 *  · No resubscribe (`INVALID OPERATION`); changing the tracked set means reconnecting.
 *  · Empty `assets_ids` yields nothing, so "tracking nothing" = socket closed.
 *  · ~380 frames/s for 80 assets, hence one batched frame per interval.
 *
 * Resolution isn't announced on the socket: markets past resolution_at_ms are polled, Gamma
 * first, then CLOB (Gamma drops 5-minute markets minutes after close). `resolved_at` is always
 * the venue's own stamp, never poll time.
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
 * A handshake that never completes fires neither 'open' nor 'close', so nothing would
 * reconnect. 10s is well past the observed <1s handshake and inside the ~126s idle kill.
 */
const DEFAULT_HANDSHAKE_MS = 10_000;
/** Spread on the reconnect delay, so every daemon does not retry in lockstep. */
const RECONNECT_JITTER = 0.2;
/**
 * Bounds for a venue ms stamp (below: seconds/ms mix-up or garbage; above: impossible).
 * An out-of-range value would throw RangeError in toISOString from a timer callback.
 */
const VENUE_TS_MIN_MS = Date.UTC(2020, 0, 1);
const VENUE_TS_FUTURE_SLACK_MS = 24 * 60 * 60 * 1000;
/** Short enough that a 15s resolution poll is never served a stale row. */
const GAMMA_TTL_ACTIVE_MS = 5_000;
const GAMMA_TTL_NEGATIVE_MS = 30_000;
/** Hard ceiling on ids accepted by the snapshot route. */
export const VENUE_SNAPSHOT_MAX_MARKETS = 50;

// ─── Public wire types (the dashboard consumes these verbatim) ─────────────
// Declared in src/types/wire-venue.ts (this module is Node-only); re-exported under daemon-side names.

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

/** Internal event union; the `type` tag never reaches the wire (SSE carries it in `event:`). */
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

/** Narrow read interface for HTTP surfaces: no DB, socket, client or mutation. */
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
   * The venue has ANSWERED for this outcome (until then 'warming'). An empty book is an
   * answer; a frame we could not read is not.
   */
  seeded: boolean;
  /**
   * Staleness per FIELD, the granularity at which a number is shown (and can lie); anything
   * coarser, or derived from `connected`, lets one value vouch for another.
   * Set on every teardown; a flag clears only when THAT field is written by an answered
   * frame, including a written null ("no bids" is fresh information).
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
  /** Tombstones for the next delta frame (deltas only add). Cleared on every flush. */
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
  /** Did the CURRENT socket complete its handshake? Handshake timeout only; never freshness (see QuoteState.stale). */
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
    // PRIVATE clients, never the resolver's singletons: display-side failures must not reach a verdict.
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
   * Recompute the tracked set; reconnect when its signature (ids, resolution instants,
   * token ids) changed. See TRACKED_SQL for the predicate.
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
          // No natural eviction, so clear wholesale past 1000 (worst case one extra log per id).
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
        // Drop everything keyed on it. An aged-out market never re-enters, so
        // these maps stay bounded by the tracked cap.
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
      // Don't reset backoff here: the first FRAME, not 'open', proves the connection serves us.
      try {
        socket.send(JSON.stringify({ type: "market", assets_ids: assets }));
      } catch (err) {
        // A throw means the socket died after 'open'; same handling as a failed PING.
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

  /** Freshness is TRANSPORT health, so a dropped socket must reach the board even if no price changed. */
  private markAllStale(): void {
    for (const [marketId, state] of this.markets) {
      // Per FIELD: every shown number must be re-proved by its own arrival.
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
        // A throwing send means the socket is gone; treat it like an unanswered PING.
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
    // ±20% so clients that lost the venue together don't retry together.
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
    // An intentional close is as fatal to freshness as a spontaneous one, and
    // removeAllListeners() means the 'close' handler never runs: mark stale here.
    this.markAllStale();
    socket.removeAllListeners();
    // Re-arm an error sink BEFORE closing: closing a CONNECTING socket emits
    // 'error', which would otherwise be an uncaught exception.
    socket.on("error", () => undefined);
    try {
      socket.close();
    } catch {
      // Already closing.
    }
    // Escalate to terminate() after a grace window so a half-open connection
    // can't hold shutdown; the timer is unref'd.
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
    // Ordering is not part of the contract; take the extremes. "Answered" is
    // structural: an empty side is an answer, a missing or unreadable side is not.
    const bid = bookSide(event.bids, "max");
    const ask = bookSide(event.asks, "min");
    const lastTrade = probabilityField(event.last_trade_price);
    if (!bid.answered && !ask.answered && lastTrade === null) return;
    // Per side: an answered side lands (null included) and clears its stale flag;
    // a garbled side keeps its value and its flag.
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
      // Both quotes out of range ⇒ apply nothing (no seeding, no stale clear).
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
    const price = probabilityField(event.price);
    if (price === null) return;
    // ONLY the last trade is refreshed; a trade says nothing about the book.
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
    // Prefer the venue's stamp; fall back to local time when absent or out of range.
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
    // ANY seeded outcome with pre-disconnect data makes the row stale; outcomes can't vouch for each other.
    const anyStale = quotes.some(
      (quote) => quote?.seeded === true && quoteIsStale(quote),
    );
    // Transport health, not market activity. `warming` outranks `stale` (no data is
    // not unverifiable data). Read stored per-field flags, never `this.connected`.
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
   * A poll started before an eviction can land after it; re-check after EVERY await so a
   * late write can't resurrect an evicted market (orphaned entries, stray emits).
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

/** Ids, token ids and resolution instants; a rewritten token map must force a reconnect. */
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
  // The venue's own stamp, in SECONDS. Out of range → refuse the row; never substitute poll time.
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

/** Keeps milliseconds (ticks update several times a second); `resolved_at` uses `isoFromMs`. */
function isoMillis(ms: number): string {
  // Last-resort guard: never throw RangeError from a timer callback.
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

/** A venue ms stamp, or null if below the floor (seconds/ms mix-up, zero) or above now + 1 day. */
export function venueTimestampMs(value: unknown, nowMs: number): number | null {
  const parsed = numberField(value);
  if (parsed === null) return null;
  const ms = Math.round(parsed);
  if (!Number.isSafeInteger(ms)) return null;
  if (ms < VENUE_TS_MIN_MS) return null;
  if (ms > nowMs + VENUE_TS_FUTURE_SLACK_MS) return null;
  return ms;
}

/** A 0..1 share price, or null. Only the out-of-range field is dropped; the rest of the frame applies. */
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

/** Is this outcome showing a number from before the last transport failure? A flagged null shows nothing, so it doesn't count. */
function quoteIsStale(quote: QuoteState): boolean {
  return (
    (quote.bestBid !== null && quote.stale.bid) ||
    (quote.bestAsk !== null && quote.stale.ask) ||
    (quote.lastTradePrice !== null && quote.stale.lastTrade)
  );
}

/**
 * One side of a book:
 *   · not an array        → no answer;
 *   · empty array         → ANSWERED, price null (no market on this side);
 *   · levels, none usable → no answer.
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
