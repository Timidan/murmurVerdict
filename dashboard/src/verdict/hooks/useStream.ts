import { useEffect, useState } from "react";
import { verdictApi } from "../api.js";
import type {
  CallAcceptedEvent,
  CallResolvedEvent,
  LeaderboardUpdateEvent,
  MarketsUpdateEvent,
  StatsTickEvent,
  VerdictEvent,
} from "@shared/events";

// SSE wire event types are the SHARED source of truth in src/types/events.ts,
// imported by BOTH the daemon (src/verdict/events.ts re-exports them) and this
// hook so the /v1/stream contract cannot drift between them. Streamed rows
// carry only the lean wire fields — REST-only fields (verdict_score_lb,
// call_scores, last_resolved_at, …) are NOT present on stream deltas, so
// consumers must source those from REST state, not the streamed row.
export type {
  CallAcceptedEvent,
  CallResolvedEvent,
  LeaderboardUpdateEvent,
  MarketsUpdateEvent,
  StatsTickEvent,
  VerdictEvent,
} from "@shared/events";

export type StreamStatus = "connecting" | "open" | "reconnecting" | "closed";

export interface StreamSnapshot {
  status: StreamStatus;
  /** Last leaderboard payload — replayed on connect so consumers paint immediately. */
  leaderboard: LeaderboardUpdateEvent | null;
  /** Last stats heartbeat. */
  stats: StatsTickEvent | null;
  /** Client receive time of that heartbeat — the page's "updated Ns ago". */
  statsAt: number | null;
  /** Most recent N calls (newest first). Capped to keep memory steady on long sessions. */
  recentCalls: Array<CallAcceptedEvent | CallResolvedEvent>;
  /**
   * Latest per-market top-N snapshot keyed by market_id. Populated as
   * `markets.update` events arrive — a component scoped to one market reads
   * `markets[their_market_id].served_at` as the signal to re-read its ladder
   * over REST, because the lean event is not the ladder.
   */
  markets: Record<string, MarketsUpdateEvent>;
}

const RECENT_CAP = 60;

//
// Earlier versions opened one EventSource per `useStream()` call. The landing
// page renders ~6 widgets that each subscribe, so a single tab held ~6 SSE
// connections — close to the per-origin browser limit and 6× the server-side
// subscriber load. Now every `useStream()` consumer subscribes to the same
// shared snapshot; the EventSource is opened on the first subscriber and
// closed when the last one unmounts.

let snapshot: StreamSnapshot = {
  status: "connecting",
  leaderboard: null,
  stats: null,
  statsAt: null,
  recentCalls: [],
  markets: {},
};

const subscribers = new Set<(s: StreamSnapshot) => void>();
let es: EventSource | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let attempt = 0;

function broadcast(): void {
  for (const fn of subscribers) fn(snapshot);
}

function applyEvent(event: VerdictEvent): void {
  if (event.type === "leaderboard.update") {
    snapshot = { ...snapshot, leaderboard: event };
  } else if (event.type === "stats.tick") {
    snapshot = { ...snapshot, stats: event, statsAt: Date.now() };
  } else if (event.type === "markets.update") {
    // Per-market delta — keyed map so consumers filter cheaply by market_id.
    snapshot = {
      ...snapshot,
      markets: { ...snapshot.markets, [event.market_id]: event },
    };
  } else {
    // call.accepted | call.resolved
    const next = [event, ...snapshot.recentCalls.filter(
      (row) => row.call_id !== event.call_id || row.type !== event.type,
    )].sort((a, b) => {
      const at = a.type === "call.accepted" ? a.accepted_at : a.resolved_at;
      const bt = b.type === "call.accepted" ? b.accepted_at : b.resolved_at;
      return bt.localeCompare(at);
    }).slice(0, RECENT_CAP);
    snapshot = { ...snapshot, recentCalls: next };
  }
  broadcast();
}

function setStatus(status: StreamStatus): void {
  if (snapshot.status === status) return;
  snapshot = { ...snapshot, status };
  broadcast();
}

function connect(): void {
  if (es) return;
  setStatus(attempt === 0 ? "connecting" : "reconnecting");
  es = new EventSource(`${verdictApi.apiUrl}/v1/stream`);

  es.onopen = () => {
    attempt = 0;
    setStatus("open");
  };

  const handle = (e: MessageEvent) => {
    try {
      applyEvent(JSON.parse(e.data) as VerdictEvent);
    } catch {
      // Malformed frame — ignore.
    }
  };

  es.addEventListener("leaderboard.update", handle);
  es.addEventListener("markets.update", handle);
  es.addEventListener("stats.tick", handle);
  es.addEventListener("call.accepted", handle);
  es.addEventListener("call.resolved", handle);

  es.onerror = () => {
    es?.close();
    es = null;
    if (subscribers.size === 0) {
      // Nobody listening — don't reconnect.
      setStatus("closed");
      return;
    }
    setStatus("reconnecting");
    const delay = Math.min(30_000, 500 * 2 ** Math.min(attempt, 6));
    attempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (subscribers.size > 0) connect();
    }, delay);
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
  if (snapshot.status !== "closed") {
    snapshot = { ...snapshot, status: "closed" };
    // No broadcast() — the last subscriber just unmounted; nobody to notify.
  }
}

/** Hold the socket across route changes — every page remounts its own subscriber. */
const DISCONNECT_GRACE_MS = 5_000;
let disconnectTimer: ReturnType<typeof setTimeout> | null = null;

/** Arm the deferred teardown. Idempotent. */
function scheduleDisconnect(): void {
  if (disconnectTimer) return;
  disconnectTimer = setTimeout(() => {
    disconnectTimer = null;
    // Re-check: a page that mounted during the window owns the stream now.
    if (subscribers.size === 0) disconnect();
  }, DISCONNECT_GRACE_MS);
}

/**
 * Subscribe to the daemon's SSE stream. Reconnects with exponential backoff.
 *
 * One EventSource per *tab*, regardless of how many components call this
 * hook. The EventSource opens on the first subscriber and closes when the
 * last one unmounts. Honours `prefers-reduced-motion` only in CSS — the
 * data itself updates the same regardless of motion preference.
 */
export function useStream(): StreamSnapshot {
  const [local, setLocal] = useState<StreamSnapshot>(snapshot);

  useEffect(() => {
    const sub = (s: StreamSnapshot) => setLocal(s);
    subscribers.add(sub);
    // Claim a socket still held open from a route handover.
    if (disconnectTimer) {
      clearTimeout(disconnectTimer);
      disconnectTimer = null;
    }
    if (subscribers.size === 1) {
      connect(); // no-op if the socket survived the handover
    } else {
      // Hand the new subscriber the latest snapshot immediately.
      setLocal(snapshot);
    }
    return () => {
      subscribers.delete(sub);
      if (subscribers.size === 0) scheduleDisconnect();
    };
  }, []);

  return local;
}
