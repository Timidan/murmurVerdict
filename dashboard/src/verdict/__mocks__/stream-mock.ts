// Mock SSE stream that mirrors the shape returned by ../hooks/useStream.ts.
//
// Synthesises events on a 2s interval so the live tape ticks and stats
// refresh during a demo. Replays an initial leaderboard + stats burst so
// consumers paint without a one-frame skeleton flash. A small in-module
// queue lets api-mock writes ride the same channel ("agent.created"
// becomes a synthetic call.accepted etc.) — see emitStreamEvent below.

import { useEffect, useState } from "react";
import type {
  CallAcceptedEvent,
  CallResolvedEvent,
  LeaderboardUpdateEvent,
  MarketsUpdateEvent,
  StatsTickEvent,
  StreamSnapshot,
  StreamStatus,
  VerdictEvent,
} from "../hooks/useStream.js";
import {
  AGENTS,
  CALLS,
  MARKETS,
  maybeResolvePending,
  pickLiveAgentSlug,
  pushPendingCall,
} from "./fixtures.js";
import { snapshotLeaderboardForStream, snapshotMarketAgents } from "./api-mock.js";

const RECENT_CAP = 60;

function initialStats(): StatsTickEvent {
  let accepted = 0;
  let resolved = 0;
  let wins = 0;
  let losses = 0;
  let voids = 0;
  for (const a of AGENTS) {
    accepted += a.wins + a.losses + a.voids + a.pending;
    resolved += a.wins + a.losses + a.voids;
    wins += a.wins;
    losses += a.losses;
    voids += a.voids;
  }
  return {
    type: "stats.tick",
    served_at: new Date().toISOString(),
    accepted_24h: Math.round(accepted * 0.32),
    resolved_24h: Math.round(resolved * 0.28),
    wins_24h: Math.round(wins * 0.3),
    losses_24h: Math.round(losses * 0.3),
    void_24h: Math.round(voids * 0.3),
  };
}

function initialLeaderboard(): LeaderboardUpdateEvent {
  const rows = snapshotLeaderboardForStream();
  return {
    type: "leaderboard.update",
    served_at: new Date().toISOString(),
    rows: rows.map((r) => ({
      rank: r.rank,
      agent_id: r.agent_id,
      display_slug: r.display_slug,
      display_name: r.display_name,
      kind: r.kind,
      verdict_score: r.verdict_score,
      win_rate: r.win_rate,
      resolved_calls: r.resolved_calls,
      pending_calls: r.pending_calls,
    })),
  };
}

function initialMarkets(): Record<string, MarketsUpdateEvent> {
  const out: Record<string, MarketsUpdateEvent> = {};
  for (const m of MARKETS) {
    out[m.market_id] = {
      type: "markets.update",
      market_id: m.market_id,
      served_at: new Date().toISOString(),
      agents: snapshotMarketAgents(m.market_id),
    };
  }
  return out;
}

function initialRecent(): Array<CallAcceptedEvent | CallResolvedEvent> {
  // Seed the live tape with the most recent calls so the panel paints
  // populated on first frame.
  return CALLS.slice(0, 12).map((c): CallAcceptedEvent | CallResolvedEvent => {
    if (c.outcome) {
      return {
        type: "call.resolved",
        call_id: c.call_id,
        agent_id: c.agent_id,
        agent_slug: c.agent_slug,
        outcome: c.outcome,
        signed_return: c.signed_return ?? null,
        call_score: c.call_score,
        resolved_at: c.resolved_at ?? new Date().toISOString(),
        adapter_id: "chainlink",
        market_family: "native-price",
        market_id: c.market_id,
      } satisfies CallResolvedEvent;
    }
    return {
      type: "call.accepted",
      call_id: c.call_id,
      agent_id: c.agent_id,
      agent_slug: c.agent_slug,
      privacy_mode: c.privacy_mode,
      commit_hash: c.commit_hash,
      adapter_id: "chainlink",
      market_family: "native-price",
      market_id: c.market_id,
      side: c.side,
      asset_id: c.asset_id,
      horizon_hours: c.horizon_hours,
      confidence: c.confidence,
      accepted_at: c.accepted_at,
    } satisfies CallAcceptedEvent;
  });
}

let snapshot: StreamSnapshot = {
  status: "open",
  leaderboard: initialLeaderboard(),
  stats: initialStats(),
  recentCalls: initialRecent(),
  markets: initialMarkets(),
};

const subscribers = new Set<(s: StreamSnapshot) => void>();
let tickHandle: ReturnType<typeof setInterval> | null = null;
let tickCount = 0;

function broadcast(): void {
  for (const fn of subscribers) fn(snapshot);
}

function applyEvent(event: VerdictEvent): void {
  if (event.type === "leaderboard.update") {
    snapshot = { ...snapshot, leaderboard: event };
  } else if (event.type === "stats.tick") {
    snapshot = { ...snapshot, stats: event };
  } else if (event.type === "markets.update") {
    snapshot = {
      ...snapshot,
      markets: { ...snapshot.markets, [event.market_id]: event },
    };
  } else {
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

function tick(): void {
  tickCount += 1;

  // Every tick: emit one accepted (synthesized from a pending call) and
  // sometimes resolve a pending one.
  const slug = pickLiveAgentSlug(tickCount);
  const newCall = pushPendingCall(slug);
  if (newCall) {
    applyEvent({
      type: "call.accepted",
      call_id: newCall.call_id,
      agent_id: newCall.agent_id,
      agent_slug: newCall.agent_slug,
      privacy_mode: newCall.privacy_mode,
      commit_hash: newCall.commit_hash,
      adapter_id: "chainlink",
      market_family: "native-price",
      market_id: newCall.market_id,
      side: newCall.side,
      asset_id: newCall.asset_id,
      horizon_hours: newCall.horizon_hours,
      confidence: newCall.confidence,
      accepted_at: newCall.accepted_at,
    });
  }

  // Resolve a random pending call every 2nd tick.
  if (tickCount % 2 === 0) {
    const resolved = maybeResolvePending();
    if (resolved) {
      applyEvent({
        type: "call.resolved",
        call_id: resolved.call_id,
        agent_id: resolved.agent_id,
        agent_slug: resolved.agent_slug,
        outcome: resolved.outcome ?? "win",
        signed_return: resolved.signed_return ?? null,
        call_score: resolved.call_score,
        resolved_at: resolved.resolved_at ?? new Date().toISOString(),
        adapter_id: "chainlink",
        market_family: "native-price",
        market_id: resolved.market_id,
      });
    }
  }

  // Every 3rd tick: refresh stats + leaderboard + a markets card.
  if (tickCount % 3 === 0) {
    applyEvent(initialStats());
    applyEvent(initialLeaderboard());
    const m = MARKETS[tickCount % MARKETS.length];
    applyEvent({
      type: "markets.update",
      market_id: m.market_id,
      served_at: new Date().toISOString(),
      agents: snapshotMarketAgents(m.market_id),
    });
  }
}

function start(): void {
  if (tickHandle) return;
  setStatus("open");
  tickHandle = setInterval(tick, 2200);
}

function stop(): void {
  if (tickHandle) {
    clearInterval(tickHandle);
    tickHandle = null;
  }
}

/**
 * External hook for api-mock writes that want to surface as a
 * stream event. Keeps the api-mock from importing the broadcast plumbing.
 */
export function emitStreamEvent(payload:
  | { kind: "agent.created"; slug: string }
  | { kind: "raw"; event: VerdictEvent }): void {
  if (payload.kind === "raw") {
    applyEvent(payload.event);
    return;
  }
  // Translate agent.created → a synthetic call.accepted so the live
  // tape immediately reflects the new agent.
  const call = pushPendingCall(payload.slug);
  if (!call) return;
  applyEvent({
    type: "call.accepted",
    call_id: call.call_id,
    agent_id: call.agent_id,
    agent_slug: call.agent_slug,
    privacy_mode: call.privacy_mode,
    commit_hash: call.commit_hash,
    adapter_id: "chainlink",
    market_family: "native-price",
    market_id: call.market_id,
    side: call.side,
    asset_id: call.asset_id,
    horizon_hours: call.horizon_hours,
    confidence: call.confidence,
    accepted_at: call.accepted_at,
  });
}

export function useMockStream(): StreamSnapshot {
  const [local, setLocal] = useState<StreamSnapshot>(snapshot);

  useEffect(() => {
    const sub = (s: StreamSnapshot) => setLocal(s);
    subscribers.add(sub);
    if (subscribers.size === 1) start();
    else setLocal(snapshot);
    return () => {
      subscribers.delete(sub);
      if (subscribers.size === 0) stop();
    };
  }, []);

  return local;
}
