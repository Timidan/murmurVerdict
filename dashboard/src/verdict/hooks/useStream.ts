import { useEffect, useState } from "react";
import { verdictApi } from "../api.js";

// Mirrors the union from src/verdict/events.ts on the daemon side.
// Kept loose here (string fields where the backend uses literals) to
// avoid coupling the dashboard build to backend internal types.

export interface CallAcceptedEvent {
  type: "call.accepted";
  call_id: string;
  agent_id: string;
  agent_slug: string;
  side: "BUY" | "SELL";
  asset_id: string;
  horizon_hours: number;
  confidence: number;
  accepted_at: string;
}

export interface CallResolvedEvent {
  type: "call.resolved";
  call_id: string;
  agent_id: string;
  agent_slug: string;
  outcome: string;
  signed_return: string | null;
  call_score: number | null;
  resolved_at: string;
}

export interface LeaderboardUpdateEvent {
  type: "leaderboard.update";
  served_at: string;
  rows: Array<{
    rank: number | null;
    agent_id: string;
    display_slug: string;
    display_name: string;
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

export type VerdictEvent =
  | CallAcceptedEvent
  | CallResolvedEvent
  | LeaderboardUpdateEvent
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
}

const RECENT_CAP = 60;

/**
 * Subscribe to the daemon's SSE stream. Reconnects with exponential backoff.
 * One EventSource per tab; consumers share the snapshot via React state.
 *
 * Honours `prefers-reduced-motion` only in CSS — the data itself updates the
 * same regardless of motion preference.
 */
export function useStream(): StreamSnapshot {
  const [snapshot, setSnapshot] = useState<StreamSnapshot>({
    status: "connecting",
    leaderboard: null,
    stats: null,
    recentCalls: [],
  });

  useEffect(() => {
    let attempt = 0;
    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const apply = (event: VerdictEvent) => {
      setSnapshot((prev) => {
        if (event.type === "leaderboard.update") {
          return { ...prev, leaderboard: event };
        }
        if (event.type === "stats.tick") {
          return { ...prev, stats: event };
        }
        // call.accepted | call.resolved
        const next = [event, ...prev.recentCalls];
        return { ...prev, recentCalls: next.slice(0, RECENT_CAP) };
      });
    };

    const connect = () => {
      if (cancelled) return;
      setSnapshot((prev) => ({
        ...prev,
        status: attempt === 0 ? "connecting" : "reconnecting",
      }));

      es = new EventSource(`${verdictApi.apiUrl}/v1/stream`);

      es.onopen = () => {
        attempt = 0;
        setSnapshot((prev) => ({ ...prev, status: "open" }));
      };

      const handle = (e: MessageEvent) => {
        try {
          const payload = JSON.parse(e.data) as VerdictEvent;
          apply(payload);
        } catch {
          // Malformed frame; ignore.
        }
      };

      es.addEventListener("leaderboard.update", handle);
      es.addEventListener("stats.tick", handle);
      es.addEventListener("call.accepted", handle);
      es.addEventListener("call.resolved", handle);

      es.onerror = () => {
        if (cancelled) return;
        es?.close();
        es = null;
        setSnapshot((prev) => ({ ...prev, status: "reconnecting" }));
        // Exponential backoff capped at 30s.
        const delay = Math.min(30_000, 500 * 2 ** Math.min(attempt, 6));
        attempt += 1;
        reconnectTimer = setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      es?.close();
    };
  }, []);

  return snapshot;
}
