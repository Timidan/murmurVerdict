/**
 * Venue ticker HTTP surface: public, read-only, display only (never reaches the resolver).
 * Payload shapes and renderer rules live in src/types/wire-venue.ts. Kept off `/v1/stream`,
 * which has no backpressure; this route uses a bounded queue.
 *
 * GET /v2/venue/stream: SSE; 503 `venue_ticker_unavailable` when the ticker is off. The FIRST
 * frame is a full-snapshot `venue_tick` with both maps (replace, don't merge); then deltas
 * every 2s, `venue_resolution` frames, and `: heartbeat` every 25s. A reader that overruns
 * the queue is disconnected (frames carry one-shot transitions); reconnect for a snapshot.
 *
 * GET /v2/venue/live: JSON. `?market=` repeats and splits on commas; omit for all tracked.
 * A non-condition-id is 400 `invalid_market_id`. Deduped, max 50; `freshness:"unknown"`
 * means a well-formed id this daemon does not track.
 */

import { Router } from "express";

// Payload shapes from the shared wire module the dashboard also imports.
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
      // Overflow ⇒ close, not drop: `removed[]` and resolutions are one-shot
      // transitions. The client reconnects and gets the full snapshot.
      close();
      return;
    }
    flush();
  };

  // Declared BEFORE the initial write, and nullable: close() can run from that
  // first write (client gone), before these would otherwise exist.
  const scheduleHeartbeat =
    deps.setInterval ?? ((handler: () => void, ms: number) => setInterval(handler, ms));
  const clearHeartbeat =
    deps.clearInterval ??
    ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>));
  let unsubscribe: (() => void) | null = null;
  let heartbeat: unknown = null;

  // ONE frame for the initial paint, markets AND resolutions, so a reconnect replaces both maps.
  const snapshot = reader.snapshot();
  enqueue(
    sseFrame("venue_tick", {
      markets: snapshot.markets,
      resolutions: snapshot.resolutions,
      ts: snapshot.ts,
    }),
  );

  // If the first write already closed us, don't subscribe a dead transport.
  if (closed) return { status: 200, close };

  unsubscribe = reader.subscribe({
    onEvent: (event: VenueTickerEvent) => {
      if (event.type === "venue_tick") {
        enqueue(
          sseFrame("venue_tick", {
            markets: event.markets,
            // Tombstones ride the same frame; omitted when empty.
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
