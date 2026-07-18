import type Database from "better-sqlite3";

import {
  getLeaderboard,
  getLeaderboardForMarket,
} from "./leaderboard.js";
import type {
  CallAcceptedEvent,
  CallResolvedEvent,
  LeaderboardUpdateEvent,
  MarketLeaderboardEventAgentRow,
  MarketsUpdateEvent,
  VerdictEvent,
} from "./events.js";
import type { AgentMarketRow } from "./leaderboard.js";
import {
  agentsRepo,
  type AgentRow,
} from "./repos/agents-repo.js";
import type { MarketRow } from "./repos/market-registry-repo.js";
import {
  resolutionsRepo,
  type FullCallResolutionView,
} from "./repos/resolution-repo.js";
import { publicResolutionOutcomeEvidence } from "./resolution-outcome-evidence.js";
import { projectPublicResolvedCallFields } from "./sealed-call-public-projection.js";
import type { LeaderboardRow } from "./schema.js";
import { nowIso } from "./time.js";

const DEFAULT_LEADERBOARD_EVENT_LIMIT = 20;
const DEFAULT_MARKET_EVENT_LIMIT = 5;

export interface ResolvedCallFanoutInput {
  full: FullCallResolutionView;
  agent: AgentRow;
}

export interface PublicResolutionFanoutEventsInput {
  db: Database.Database;
  call_id: string;
  servedAt: Date;
  leaderboardLimit?: number;
  marketLimit?: number;
}

export interface AcceptedSealedCallFanoutInput {
  db: Database.Database;
  call_id: string;
  agent_id: string;
  accepted_at: string;
  commit_hash: string;
  market: MarketRow;
}

export type WebhookDeliverableEvent = CallAcceptedEvent | CallResolvedEvent;

export interface PublicWebhookFanoutEvent {
  agent_slug: string;
  event: WebhookDeliverableEvent;
}

export interface PublicLeaderboardUpdateEventInput {
  db: Database.Database;
  servedAt: Date;
  limit?: number;
}

export interface PublicMarketsUpdateEventInput {
  db: Database.Database;
  market_id: string;
  servedAt: Date;
  limit?: number;
}

export function publicResolutionFanoutEvents(
  input: PublicResolutionFanoutEventsInput,
): VerdictEvent[] {
  const full = resolutionsRepo.loadFullCall(input.db, input.call_id);
  const agent = full
    ? agentsRepo.byId(input.db, full.submission.agent_id)
    : null;
  if (!full?.resolution || !agent) return [];

  const resolved = publicResolvedCallEvent({
    full,
    agent,
  });
  if (!resolved) return [];

  const events: VerdictEvent[] = [
    resolved,
    publicLeaderboardUpdateEvent({
      db: input.db,
      servedAt: input.servedAt,
      limit: input.leaderboardLimit ?? DEFAULT_LEADERBOARD_EVENT_LIMIT,
    }),
  ];

  if (resolved.market_id) {
    events.push(
      publicMarketsUpdateEvent({
        db: input.db,
        market_id: resolved.market_id,
        servedAt: input.servedAt,
        limit: input.marketLimit ?? DEFAULT_MARKET_EVENT_LIMIT,
      }),
    );
  }

  return events;
}

export function publicAcceptedCallEvent(
  input: AcceptedSealedCallFanoutInput,
): CallAcceptedEvent {
  const agent = agentsRepo.byId(input.db, input.agent_id);
  return {
    type: "call.accepted",
    call_id: input.call_id,
    agent_id: input.agent_id,
    agent_slug: agent?.display_slug ?? input.agent_id,
    privacy_mode: "sealed_fhenix",
    accepted_at: input.accepted_at,
    commit_hash: input.commit_hash,
    adapter_id: input.market.adapter_id ?? "native-price",
    market_family: input.market.market_family ?? "financial-direction",
    market_id: input.market.market_id,
  };
}

export function publicWebhookFanoutEvent(
  event: VerdictEvent,
): PublicWebhookFanoutEvent | null {
  if (event.type !== "call.accepted" && event.type !== "call.resolved") {
    return null;
  }
  return {
    agent_slug: event.agent_slug,
    event,
  };
}

export function publicResolvedCallEvent(
  input: ResolvedCallFanoutInput,
): CallResolvedEvent | null {
  if (!input.full.resolution) return null;
  // Resolved-side public fields (outcome / call_score / native-price
  // signed_return gate / resolved_at / adapter + market-family defaults /
  // market_id) come from the SINGLE OWNER in the projection module, so this
  // SSE/webhook shape can't drift from the REST/RSS row projections.
  return {
    type: "call.resolved",
    call_id: input.full.submission.call_id,
    agent_id: input.agent.agent_id,
    agent_slug: input.agent.display_slug,
    ...projectPublicResolvedCallFields({
      adapter_id: input.full.submission.adapter_id,
      market_family: input.full.submission.market_family,
      market_id: input.full.submission.market_id,
      outcome: input.full.resolution.outcome,
      call_score: input.full.resolution.call_score,
      signed_return: input.full.resolution.signed_return,
      resolved_at: input.full.resolution.resolved_at,
    }),
    ...publicResolutionOutcomeEvidence(input.full.resolution),
  };
}

export function publicLeaderboardUpdateEvent(
  input: PublicLeaderboardUpdateEventInput,
): LeaderboardUpdateEvent {
  const rows = getLeaderboard(input.db, {
    limit: input.limit ?? DEFAULT_LEADERBOARD_EVENT_LIMIT,
  });
  return {
    type: "leaderboard.update",
    served_at: nowIso(input.servedAt),
    rows: rows.map(publicLeaderboardEventRow),
  };
}

export function publicMarketsUpdateEvent(
  input: PublicMarketsUpdateEventInput,
): MarketsUpdateEvent {
  return {
    type: "markets.update",
    market_id: input.market_id,
    served_at: nowIso(input.servedAt),
    agents: getLeaderboardForMarket(input.db, {
      market_id: input.market_id,
      limit: input.limit ?? DEFAULT_MARKET_EVENT_LIMIT,
    }).map(publicMarketLeaderboardEventRow),
  };
}

export function publicLeaderboardEventRow(
  row: LeaderboardRow,
): LeaderboardUpdateEvent["rows"][number] {
  return {
    rank: row.rank,
    agent_id: row.agent_id,
    display_slug: row.display_slug,
    display_name: row.display_name,
    kind: row.kind,
    verdict_score: row.verdict_score,
    win_rate: row.win_rate,
    resolved_calls: row.resolved_calls,
    pending_calls: row.pending_calls,
  };
}

export function publicMarketLeaderboardEventRow(
  row: AgentMarketRow,
): MarketLeaderboardEventAgentRow {
  return {
    agent_id: row.agent_id,
    display_slug: row.display_slug,
    display_name: row.display_name,
    kind: row.kind,
    market_id: row.market_id,
    verdict_score: row.verdict_score,
    win_rate: row.win_rate,
    resolved_calls: row.resolved_calls,
    pending_calls: row.pending_calls,
    market_main_tier: row.market_main_tier,
  };
}
