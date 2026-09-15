import { useEffect, useState } from "react";
import { verdictApi } from "../api.js";
import type {
  WireVenueMarketRow,
  WireVenueResolutionRow,
  WireVenueTickPayload,
} from "@shared/wire-venue";

// Never import these from src/integrations/venue-ticker.ts: it pulls in
// better-sqlite3 and ws, which a browser bundle must not reach.
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
  /** Settled outcomes keyed by market_id. Replaced with `markets` by the first
   *  tick, then upserted and pruned by `removed[]`. */
  resolutions: Record<string, WireVenueResolutionRow>;
  /** ISO stamp of the most recent tick, or null before the first one. */
  ts: string | null;
}

// One EventSource per tab, as in useStream.ts, but a separate socket: venue
// ticks are high-rate and get their own drop-oldest route on the daemon.

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
/** The first `venue_tick` per connection is the whole cache (replace); later ones are deltas. */
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
  // Anything but `open` means cached quotes are no longer live: mark them stale.
  snapshot = {
    ...snapshot,
    status,
    markets: status === "open" ? snapshot.markets : staleMarkets(snapshot.markets),
  };
  broadcast();
}

/** Every quote marked stale. Returns the same object when nothing changed. */
function staleMarkets(
  markets: Record<string, WireVenueMarketRow>,
): Record<string, WireVenueMarketRow> {
  let next: Record<string, WireVenueMarketRow> | null = null;
  for (const [id, row] of Object.entries(markets)) {
    if (row.freshness === "stale") continue;
    next ??= { ...markets };
    next[id] = { ...row, freshness: "stale" };
  }
  return next ?? markets;
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
    // Both maps are replaced together, or resolutions evicted while offline linger.
    resolutions = {};
    for (const row of payload.resolutions ?? []) {
      resolutions[row.market_id] = row;
    }
  }
  const removed = Array.isArray(payload.removed) ? payload.removed : [];
  if (removed.length > 0) {
    // Tombstones are the only eviction path for both maps; deltas only add.
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
  // The daemon replays resolutions; skip the render when nothing changed.
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

/** Exponential backoff with ±20% jitter so tabs don't reconnect in lockstep. */
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
   * Reset the backoff on the first frame, not on open: a proxy can send headers
   * then drop, which would pin retries at the base delay.
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
      // Malformed frame; keep the socket.
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
    // No status code on EventSource: a 503 (no ticker) is an error before open,
    // tracked per connection. `unavailable` stays quiet but keeps retrying.
    // Close first, or EventSource's own retry races ours.
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
    // The next page reads this before its first frame; mark quotes stale.
    snapshot = {
      ...snapshot,
      status: "closed",
      markets: staleMarkets(snapshot.markets),
    };
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
