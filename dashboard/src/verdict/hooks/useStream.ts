import { useEffect, useState } from "react";
import { verdictApi, type AgentMarketRow } from "../api.js";

// Mirrors the union from src/verdict/events.ts on the daemon side.
// Kept loose here (string fields where the backend uses literals) to
// avoid coupling the dashboard build to backend internal types.

export interface CallAcceptedEvent {
  type: "call.accepted";
  call_id: string;
  agent_id: string;
  agent_slug: string;
  privacy_mode: string;
  commit_hash?: string;
  acceptance_receipt_hash?: string;
  // Phase 10 / Z4-extra discriminators. Backend populates these from
  // submissions.adapter_id / market_family / market_id. Optional for
  // forward compat with daemons that haven't shipped the wire-shape
  // bump yet.
  adapter_id?: string;
  market_family?: string;
  market_id?: string;
  side?: "BUY" | "SELL";
  asset_id?: string;
  horizon_hours?: number;
  confidence?: number;
  accepted_at: string;
}

export interface CallResolvedEvent {
  type: "call.resolved";
  call_id: string;
  agent_id: string;
  agent_slug: string;
  outcome: string;
  /** Native-price markets emit a string-decimal return; non-native
   *  adapters (Polymarket and future event/category families) OMIT this
   *  field entirely (Drift C). Consumers must guard with `if
   *  (signed_return)` before formatting. */
  signed_return?: string | null;
  call_score: number | null;
  resolved_at: string;
  // Phase 10 / Z4-extra discriminators.
  adapter_id?: string;
  market_family?: string;
  market_id?: string;
  // Phase 5 — universal payout-vector additive fields. Populated by the
  // resolver when the v2 adapter dispatch ran (Outcome JSON +
  // payoutNumerators stringified). Consumers that want the universal
  // outcome shape read these; legacy consumers reading outcome /
  // call_score continue working unchanged.
  resolved_outcome?: unknown;
  payout_vector?: string[];
}

export interface LeaderboardUpdateEvent {
  type: "leaderboard.update";
  served_at: string;
  rows: Array<{
    rank: number | null;
    agent_id: string;
    display_slug: string;
    display_name: string;
    kind: "verified" | "benchmark" | "shadow" | "internal_test" | "wallet_only";
    verdict_score: number | null;
    win_rate: number | null;
    resolved_calls: number;
    pending_calls: number;
  }>;
}

export interface StatsTickEvent {
  type: "stats.tick";
  served_at: string;
  accepted_24h: number;
  resolved_24h: number;
  wins_24h: number;
  losses_24h: number;
  void_24h: number;
}

export interface MarketsUpdateEvent {
  type: "markets.update";
  market_id: string;
  served_at: string;
  agents: AgentMarketRow[];
}

export type VerdictEvent =
  | CallAcceptedEvent
  | CallResolvedEvent
  | LeaderboardUpdateEvent
  | MarketsUpdateEvent
  | StatsTickEvent;

export type StreamStatus = "connecting" | "open" | "reconnecting" | "closed";

export interface StreamSnapshot {
  status: StreamStatus;
  /** Last leaderboard payload — replayed on connect so consumers paint immediately. */
  leaderboard: LeaderboardUpdateEvent | null;
  /** Last stats heartbeat. */
  stats: StatsTickEvent | null;
  /** Most recent N calls (newest first). Capped to keep memory steady on long sessions. */
  recentCalls: Array<CallAcceptedEvent | CallResolvedEvent>;
  /**
   * Latest per-market top-N snapshot keyed by market_id. Populated as
   * `markets.update` events arrive — components scoped to a single market
   * read `markets[their_market_id]` and re-render without a REST refetch.
   */
  markets: Record<string, MarketsUpdateEvent>;
}

const RECENT_CAP = 60;

// ─── Module-level singleton ──────────────────────────────────────────────────
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
    snapshot = { ...snapshot, stats: event };
  } else if (event.type === "markets.update") {
    // Per-market delta — keyed map so consumers filter cheaply by market_id.
    snapshot = {
      ...snapshot,
      markets: { ...snapshot.markets, [event.market_id]: event },
    };
  } else {
    // call.accepted | call.resolved
    const next = [event, ...snapshot.recentCalls].slice(0, RECENT_CAP);
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
  es?.close();
  es = null;
  attempt = 0;
  if (snapshot.status !== "closed") {
    snapshot = { ...snapshot, status: "closed" };
    // No broadcast() — the last subscriber just unmounted; nobody to notify.
  }
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
    if (subscribers.size === 1) {
      connect();
    } else {
      // Hand the new subscriber the latest snapshot immediately.
      setLocal(snapshot);
    }
    return () => {
      subscribers.delete(sub);
      if (subscribers.size === 0) disconnect();
    };
  }, []);

  return local;
}
