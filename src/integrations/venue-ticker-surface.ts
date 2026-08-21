/**
 * Venue ticker HTTP surface — public, read-only, no auth. Both routes are
 * display surfaces; nothing here reaches the resolver. Payload shapes and the
 * rules a renderer must honor live in src/types/wire-venue.ts.
 *
 * Deliberately NOT on `/v1/stream`: that surface fans every event to every
 * consumer and ignores the result of `res.write()`, so a slow reader buffers
 * into the daemon's heap. Venue ticks are the highest-rate stream murmur emits,
 * so they get their own route with a bounded queue.
 *
 * GET /v2/venue/stream — text/event-stream. 503 `venue_ticker_unavailable` when
 * the ticker is off. Otherwise the FIRST frame is a full-snapshot `venue_tick`
 * carrying both maps; later frames are deltas every 2s, plus `venue_resolution`
 * frames as they occur and a `: heartbeat` comment every 25s. A client that
 * merges the first frame keeps markets and resolutions the daemon dropped.
 *
 * A reader that overruns the queue is DISCONNECTED, not silently trimmed:
 * these frames carry one-shot transitions (`removed[]`, resolutions) a later
 * frame cannot restate. Reconnect and take the snapshot again.
 *
 * GET /v2/venue/live — application/json. `?market=` repeats, and commas inside
 * one value also split. Omit it for every tracked market. A value that is not a
 * 32-byte hex condition id is a 400 `invalid_market_id`. Ids dedupe, at most 50
 * are answered, and `freshness:"unknown"` means a well-formed id this daemon
 * does not track.
 */

import { Router } from "express";

// The payload shapes come from the SHARED wire module, which is exactly what
// the dashboard imports — so this surface and its only consumer are typed by
// one declaration rather than two that happen to agree today. The reader
// interface and the internal event envelope still come from the ticker itself;
// neither crosses the wire.
import type { WireVenueSnapshotResult } from "../types/wire-venue.js";
import type {
  VenueTickerEvent,
  VenueTickerReader,
} from "./venue-ticker.js";
import { VENUE_SNAPSHOT_MAX_MARKETS } from "./venue-ticker.js";
import { POLYMARKET_CONDITION_ID_REGEX } from "../markets/polymarket-gamma/config.js";

const VENUE_STREAM_HEARTBEAT_MS = 25_000;
/** Frames a single slow client may buffer before the daemon closes it. */
const VENUE_STREAM_MAX_QUEUE = 16;

export const VENUE_TICKER_UNAVAILABLE_BODY = {
  code: "venue_ticker_unavailable",
  message: "venue ticker is not running on this deployment",
} as const;

export const VENUE_INVALID_MARKET_BODY = {
  code: "invalid_market_id",
  message: "each market must be a 32-byte hex condition id (0x + 64 hex chars)",
} as const;

// ─── Narrow req/res shapes (mirrors public-event-stream-surface.ts) ─────────

export interface VenueStreamRequest {
  on(event: "close" | "error", handler: () => void): unknown;
}

export interface VenueStreamResponse {
  status(code: number): VenueStreamResponse;
  json(body: unknown): unknown;
  setHeader(name: string, value: string): unknown;
  flushHeaders?(): unknown;
  /** Node returns false once the socket buffer is full. */
  write(chunk: string): boolean;
  end(): unknown;
  once?(event: "drain", handler: () => void): unknown;
}

export interface VenueStreamSurfaceDeps {
  reader: VenueTickerReader | null;
  heartbeatMs?: number;
  maxQueue?: number;
  setInterval?: (handler: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

export type VenueStreamResult =
  | { status: 503; body: typeof VENUE_TICKER_UNAVAILABLE_BODY }
  | { status: 200; close: () => void };

/**
 * Open one SSE connection. Writes an immediate `venue_tick` carrying the
 * current cache so the board paints without a second request, then forwards
 * the ticker's own batched frames.
 */
export function openVenueStream(
  req: VenueStreamRequest,
  res: VenueStreamResponse,
  deps: VenueStreamSurfaceDeps,
): VenueStreamResult {
  const reader = deps.reader;
  if (!reader || !reader.running()) {
    res.status(503).json(VENUE_TICKER_UNAVAILABLE_BODY);
    return { status: 503, body: VENUE_TICKER_UNAVAILABLE_BODY };
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const maxQueue = deps.maxQueue ?? VENUE_STREAM_MAX_QUEUE;
  const queue: string[] = [];
  let writable = true;
  let closed = false;

  const flush = (): void => {
    while (!closed && writable && queue.length > 0) {
      const chunk = queue.shift()!;
      let ok: boolean;
      try {
        ok = res.write(chunk);
      } catch {
        close();
        return;
      }
      if (ok === false) {
        writable = false;
        // Backpressure: stop writing until the socket drains. Without a
        // `once` hook we simply keep the queue bounded and retry on the next
        // frame, which still cannot grow without limit.
        res.once?.("drain", () => {
          writable = true;
          flush();
        });
        return;
      }
    }
  };

  const enqueue = (chunk: string): void => {
    if (closed) return;
    queue.push(chunk);
    if (queue.length > maxQueue) {
      // OVERFLOW ⇒ CLOSE, rather than drop.
      //
      // This used to drop the oldest frame, on the reasoning that a live board
      // only wants the newest prices. That is true of prices and false of
      // everything else this stream carries: a delta tick's `removed[]`
      // tombstones and a `venue_resolution` are one-shot STATE TRANSITIONS.
      // The daemon clears `pendingRemovals` at fan-out and emits each
      // resolution once, so a dropped frame is simply gone — the client keeps
      // an evicted market on screen, or never learns a market settled, with no
      // repair path and no way to detect it happened.
      //
      // Closing is the honest repair: the client reconnects and is handed the
      // authoritative full snapshot, which is exactly the state it lost.
      close();
      return;
    }
    flush();
  };

  // Declared BEFORE the initial write, and nullable.
  //
  // `close()` is hoisted and the first `enqueue` below can reach it — a client
  // that vanishes mid-write makes `res.write()` throw, `flush()` calls
  // `close()`, and `close()` touched `unsubscribe`/`heartbeat`/`clearHeartbeat`
  // while they were still in their temporal dead zone. That is a ReferenceError
  // thrown out of the route handler on a perfectly ordinary disconnect, leaving
  // the subscription installed on the ticker and the response never ended.
  const scheduleHeartbeat =
    deps.setInterval ?? ((handler: () => void, ms: number) => setInterval(handler, ms));
  const clearHeartbeat =
    deps.clearInterval ??
    ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>));
  let unsubscribe: (() => void) | null = null;
  let heartbeat: unknown = null;

  // ONE frame for the whole initial paint: markets AND resolutions together.
  //
  // The resolutions used to follow as one `venue_resolution` frame each. That
  // could only ADD to the client's map, so a resolution evicted while the
  // client was disconnected survived the reconnect and stayed on screen
  // forever — the market map was replaced, the resolution map was not. It also
  // made the initial paint one frame per settled market, which is precisely
  // what overflowed a slow reader's queue at connect time.
  const snapshot = reader.snapshot();
  enqueue(
    sseFrame("venue_tick", {
      markets: snapshot.markets,
      resolutions: snapshot.resolutions,
      ts: snapshot.ts,
    }),
  );

  // Nothing below runs if the write above already closed us out — subscribing a
  // dead transport to the ticker is exactly the leak this guard prevents.
  if (closed) return { status: 200, close };

  unsubscribe = reader.subscribe({
    onEvent: (event: VenueTickerEvent) => {
      if (event.type === "venue_tick") {
        enqueue(
          sseFrame("venue_tick", {
            markets: event.markets,
            // Tombstones ride the same frame. Omitted when empty so the common
            // tick stays byte-identical to what it was.
            ...(event.removed !== undefined && event.removed.length > 0
              ? { removed: event.removed }
              : {}),
            ts: event.ts,
          }),
        );
        return;
      }
      const { type: _type, ...payload } = event;
      enqueue(sseFrame("venue_resolution", payload));
    },
    onClose: () => close(),
  });

  heartbeat = scheduleHeartbeat(() => {
    enqueue(": heartbeat\n\n");
  }, deps.heartbeatMs ?? VENUE_STREAM_HEARTBEAT_MS);

  function close(): void {
    if (closed) return;
    closed = true;
    queue.length = 0;
    // Null-guarded: close() is reachable from the very first write, before
    // either of these exists.
    if (heartbeat !== null) {
      clearHeartbeat(heartbeat);
      heartbeat = null;
    }
    if (unsubscribe !== null) {
      unsubscribe();
      unsubscribe = null;
    }
    try {
      res.end();
    } catch {
      // Already closed.
    }
  }

  req.on("close", close);
  req.on("error", close);

  return { status: 200, close };
}

// ─── Snapshot ───────────────────────────────────────────────────────────────

export type VenueLiveResult =
  | { status: 503; body: typeof VENUE_TICKER_UNAVAILABLE_BODY }
  | { status: 400; body: typeof VENUE_INVALID_MARKET_BODY }
  | { status: 200; body: WireVenueSnapshotResult };

/**
 * Snapshot for the initial paint. `?market=` may repeat; every value must be
 * a validly shaped condition id (a malformed one is a client bug and gets a
 * 400 rather than a silent drop). Ids the ticker does not track come back as
 * `{market_id, freshness:'unknown'}` so the caller can tell "not tracked"
 * apart from "no data yet". No params at all returns everything tracked.
 */
export function venueLiveSnapshot(
  rawMarkets: unknown,
  deps: { reader: VenueTickerReader | null },
): VenueLiveResult {
  const reader = deps.reader;
  if (!reader || !reader.running()) {
    return { status: 503, body: VENUE_TICKER_UNAVAILABLE_BODY };
  }
  const requested = normalizeMarketParam(rawMarkets);
  if (requested === null) return { status: 400, body: VENUE_INVALID_MARKET_BODY };
  if (requested.length === 0) return { status: 200, body: reader.snapshot() };
  return { status: 200, body: reader.snapshot({ marketIds: requested }) };
}

/** `null` signals "at least one value is not a condition id". */
export function normalizeMarketParam(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return [];
  const values = Array.isArray(raw) ? raw : [raw];
  const out: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") return null;
    for (const part of value.split(",")) {
      const trimmed = part.trim();
      if (trimmed.length === 0) continue;
      if (!POLYMARKET_CONDITION_ID_REGEX.test(trimmed)) return null;
      out.push(trimmed);
    }
  }
  return out;
}

// ─── Express wiring ─────────────────────────────────────────────────────────

export interface VenueTickerRouterDeps {
  reader: VenueTickerReader | null;
}

export function venueTickerRouter(deps: VenueTickerRouterDeps): Router {
  const router = Router();

  router.get("/v2/venue/stream", (req, res) => {
    openVenueStream(
      req as unknown as VenueStreamRequest,
      res as unknown as VenueStreamResponse,
      { reader: deps.reader },
    );
  });

  router.get("/v2/venue/live", (req, res) => {
    const result = venueLiveSnapshot(req.query.market, { reader: deps.reader });
    res.status(result.status).json(result.body);
  });

  return router;
}

export const VENUE_SNAPSHOT_CAP = VENUE_SNAPSHOT_MAX_MARKETS;

function sseFrame(eventName: string, payload: unknown): string {
  return `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
}
