import { useEffect, useState } from "react";
import { verdictApi } from "../api.js";
import type {
  WireVenueMarketRow,
  WireVenueResolutionRow,
  WireVenueTickPayload,
} from "@shared/wire-venue";

// The venue wire types are declared ONCE, in src/types/wire-venue.ts, and
// imported here through the `@shared` alias. Never import them from
// src/integrations/venue-ticker.ts — that module pulls in better-sqlite3, ws
// and the venue HTTP clients, and a browser bundle must not reach it.
export type {
  WireVenueMarketRow as VenueMarketRow,
  WireVenueOutcomeQuote as VenueOutcomeQuote,
  WireVenueResolutionRow as VenueResolutionRow,
  WireVenueFreshness as VenueFreshness,
} from "@shared/wire-venue";

export type VenueStreamStatus =
  | "connecting"
  | "open"
  | "reconnecting"
  /** The daemon answered 503: this deployment runs no venue ticker. */
  | "unavailable"
  | "closed";

export interface VenueStreamSnapshot {
  status: VenueStreamStatus;
  /** Live quotes keyed by market_id. Replaced wholesale by the first tick on
   *  each connection, merged by later ones, pruned by `removed[]`. */
  markets: Record<string, WireVenueMarketRow>;
  /** Settled outcomes keyed by market_id. Replaced wholesale by the first tick
   *  on each connection (same frame as `markets`), then upserted and pruned by
   *  `removed[]` — the two maps are always drawn from the same daemon state. */
  resolutions: Record<string, WireVenueResolutionRow>;
  /** ISO stamp of the most recent tick, or null before the first one. */
  ts: string | null;
}

//
// Same architecture as useStream.ts, and for the same reason: one EventSource
// per TAB, not per component. Several widgets read venue prices, and the
// browser's per-origin connection budget is small enough that a socket per
// subscriber starves ordinary fetches. Deliberately a SEPARATE socket from
// useStream's /v1/stream — venue ticks are the highest-rate stream murmur
// emits and the daemon gives them their own bounded, drop-oldest route, so
// pairing them on one connection would put a 5-updates/second feed behind the
// same buffer as the leaderboard.
//
// Written as a sibling of useStream rather than a generalization of it: the
// two differ in the parts that matter (first-frame-is-a-snapshot semantics,
// 503-means-off, resolution upserts), and a shared abstraction would have to
// carry all of it as options anyway.

let snapshot: VenueStreamSnapshot = {
  status: "connecting",
  markets: {},
  resolutions: {},
  ts: null,
};

const subscribers = new Set<(s: VenueStreamSnapshot) => void>();
let es: EventSource | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let attempt = 0;
/**
 * The first `venue_tick` after a connection opens carries the daemon's WHOLE
 * cache; every later one carries only what changed. Merging the first frame
 * would leave markets the daemon has stopped tracking on screen forever, with
 * prices frozen at whatever they were when tracking stopped.
 */
let awaitingFullSnapshot = true;

const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 30_000;
/** Highest exponent before the cap; 500 × 2^6 = 32s, already past 30s. */
const BACKOFF_MAX_ATTEMPT = 6;

function broadcast(): void {
  for (const fn of subscribers) fn(snapshot);
}

function setStatus(status: VenueStreamStatus): void {
  if (snapshot.status === status) return;
  snapshot = { ...snapshot, status };
  broadcast();
}

function applyTick(payload: WireVenueTickPayload): void {
  const incoming: Record<string, WireVenueMarketRow> = {};
  for (const row of payload.markets) incoming[row.market_id] = row;
  // Full snapshot → replace. Delta → merge, then apply tombstones.
  const markets = awaitingFullSnapshot
    ? incoming
    : { ...snapshot.markets, ...incoming };
  let resolutions = snapshot.resolutions;
  if (awaitingFullSnapshot) {
    // BOTH maps are replaced together, from the same frame.
    //
    // Replacing markets while merging resolutions was the leak: the daemon
    // only ever replayed the resolutions it still holds, so one it evicted
    // while this tab was disconnected had no way to leave the tab. It stayed
    // in the map for the life of the session, and any view keyed off
    // `resolutions[market_id]` kept rendering a settled outcome for a market
    // the board had otherwise forgotten.
    resolutions = {};
    for (const row of payload.resolutions ?? []) {
      resolutions[row.market_id] = row;
    }
  }
  const removed = Array.isArray(payload.removed) ? payload.removed : [];
  if (removed.length > 0) {
    // A delta tick only ever ADDS, so without honoring these the map grows for
    // the life of the tab and keeps painting markets the daemon stopped
    // tracking, frozen at their last price under a stale badge.
    //
    // The resolution goes with it. Eviction means the market fell out of the
    // daemon's 30-minute post-resolution lookback, so nothing on screen still
    // refers to it — and `resolutions` has no other eviction path at all.
    let prunedResolutions: Record<string, WireVenueResolutionRow> | null = null;
    for (const marketId of removed) {
      if (typeof marketId !== "string") continue;
      delete markets[marketId];
      if (marketId in resolutions) {
        prunedResolutions ??= { ...resolutions };
        delete prunedResolutions[marketId];
      }
    }
    if (prunedResolutions !== null) resolutions = prunedResolutions;
  }
  snapshot = {
    ...snapshot,
    markets,
    resolutions,
    ts: typeof payload.ts === "string" ? payload.ts : snapshot.ts,
  };
  awaitingFullSnapshot = false;
  broadcast();
}

function applyResolution(payload: WireVenueResolutionRow): void {
  // Idempotent by contract — the daemon replays resolutions across restarts,
  // so this is an upsert and a repeat is a no-op that still costs a render if
  // we are not careful. Bail when nothing actually changed.
  const existing = snapshot.resolutions[payload.market_id];
  if (
    existing &&
    existing.winning_label === payload.winning_label &&
    existing.resolved_at === payload.resolved_at &&
    existing.source === payload.source
  ) {
    return;
  }
  snapshot = {
    ...snapshot,
    resolutions: { ...snapshot.resolutions, [payload.market_id]: payload },
  };
  broadcast();
}

/**
 * Exponential backoff with jitter.
 *
 * The cap alone is not enough: every tab that lost the daemon at the same
 * moment would come back at the same moment, so the daemon's first breath
 * after a restart is spent serving a synchronized stampede. ±20% spreads them.
 */
function backoffDelayMs(): number {
  const base = Math.min(
    BACKOFF_CAP_MS,
    BACKOFF_BASE_MS * 2 ** Math.min(attempt, BACKOFF_MAX_ATTEMPT),
  );
  const jitter = base * 0.2 * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(base + jitter));
}

function scheduleReconnect(): void {
  if (subscribers.size === 0) {
    setStatus("closed");
    return;
  }
  const delay = backoffDelayMs();
  attempt += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (subscribers.size > 0) connect();
  }, delay);
}

function connect(): void {
  if (es) return;
  if (snapshot.status !== "unavailable") {
    setStatus(attempt === 0 ? "connecting" : "reconnecting");
  }
  // A reconnect always starts a new cache handoff.
  awaitingFullSnapshot = true;

  const source = new EventSource(`${verdictApi.apiUrl}/v2/venue/stream`);
  es = source;
  /** Per-CONNECTION, not per-session: did THIS socket ever reach open? */
  let opened = false;
  /** …and did it ever deliver a frame? See `noteServing`. */
  let served = false;

  source.onopen = () => {
    opened = true;
    setStatus("open");
  };

  /**
   * Reset the backoff on the first FRAME, not on open.
   *
   * `onopen` fires as soon as headers land, which a proxy or a daemon mid-
   * restart will happily do before dropping the connection. Resetting there
   * walks the backoff back to 500ms on every such attempt and the tab spins at
   * the base delay indefinitely. The daemon writes a full-snapshot tick
   * immediately on subscribe, so the first frame is the earliest honest proof
   * the connection is actually serving us.
   */
  const noteServing = (): void => {
    if (served) return;
    served = true;
    attempt = 0;
  };

  const handleTick = (e: MessageEvent) => {
    noteServing();
    try {
      applyTick(JSON.parse(e.data) as WireVenueTickPayload);
    } catch {
      // Malformed frame — ignore. A bad frame is not a reason to drop a
      // working socket.
    }
  };
  const handleResolution = (e: MessageEvent) => {
    noteServing();
    try {
      applyResolution(JSON.parse(e.data) as WireVenueResolutionRow);
    } catch {
      // Ignore.
    }
  };

  source.addEventListener("venue_tick", handleTick);
  source.addEventListener("venue_resolution", handleResolution);

  source.onerror = () => {
    // EventSource exposes no status code, so a 503 (no ticker on this
    // deployment) is indistinguishable from a dropped socket — EXCEPT that a
    // 503 errors before the connection ever opens. That is the whole signal,
    // and it has to be tracked per connection: keying off the retry counter
    // instead would report "unavailable" on the first failure and
    // "reconnecting" on every one after it, i.e. a deployment with the ticker
    // switched off would start claiming it was about to reconnect to a stream
    // that does not exist.
    //
    // The response to `unavailable` is to go QUIET — no error chrome, no
    // console noise — while still retrying on the same capped backoff, so a
    // ticker that comes up later is picked up without a reload.
    //
    // Always CLOSE before reconnecting. EventSource retries on its own once
    // this handler returns; leaving the old object alive means two sockets
    // racing, and the browser's per-origin budget is spent on duplicates.
    source.close();
    if (es === source) es = null;
    if (subscribers.size === 0) {
      setStatus("closed");
      return;
    }
    setStatus(opened ? "reconnecting" : "unavailable");
    scheduleReconnect();
  };
}

function disconnect(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (disconnectTimer) {
    clearTimeout(disconnectTimer);
    disconnectTimer = null;
  }
  es?.close();
  es = null;
  attempt = 0;
  awaitingFullSnapshot = true;
  if (snapshot.status !== "closed") {
    snapshot = { ...snapshot, status: "closed" };
    // No broadcast — the last subscriber just unmounted.
  }
}

/** Hold the socket across route changes; every page remounts its subscriber. */
const DISCONNECT_GRACE_MS = 5_000;
let disconnectTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleDisconnect(): void {
  if (disconnectTimer) return;
  disconnectTimer = setTimeout(() => {
    disconnectTimer = null;
    // Re-check: a page that mounted during the window owns the stream now.
    if (subscribers.size === 0) disconnect();
  }, DISCONNECT_GRACE_MS);
}

/**
 * Subscribe to the daemon's venue price stream (`GET /v2/venue/stream`).
 *
 * One EventSource per tab regardless of how many components call this. The
 * socket opens on the first subscriber, survives a 5s route handover, and
 * closes when the last subscriber is gone for good.
 */
export function useVenueStream(): VenueStreamSnapshot {
  const [local, setLocal] = useState<VenueStreamSnapshot>(snapshot);

  useEffect(() => {
    const sub = (s: VenueStreamSnapshot) => setLocal(s);
    subscribers.add(sub);
    // Claim a socket still held open from a route handover.
    if (disconnectTimer) {
      clearTimeout(disconnectTimer);
      disconnectTimer = null;
    }
    if (subscribers.size === 1) {
      connect(); // no-op if the socket survived the handover
    } else {
      setLocal(snapshot);
    }
    return () => {
      subscribers.delete(sub);
      if (subscribers.size === 0) scheduleDisconnect();
    };
  }, []);

  return local;
}
