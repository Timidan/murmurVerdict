import type Database from "better-sqlite3";

import {
  MURMUR_AGENT_CARD_CACHE_CONTROL,
  MURMUR_AGENT_CARD_CONTENT_TYPE,
  MURMUR_AGENT_CARD_CORS_ORIGIN,
  publicMurmurAgentCard,
} from "./murmur-agent-card.js";
import {
  publicMurmurAgentListRow,
  publicMurmurAgentProfile,
} from "./murmur-agent-public-profile.js";
import type {
  PublicAgentCallsQuery,
  PublicAgentListQueryResult,
} from "./public-agent-query.js";
import { agentsRepo } from "./repos/agents-repo.js";
import {
  ERROR_CODES,
  SCHEMA_VERSION,
  type AgentKind,
} from "./schema.js";
import { listPublicAgentCallProjections } from "./sealed-call-public-projection.js";
import { nowIso } from "./time.js";

const unknownAgentBody = {
  code: ERROR_CODES.unknown_agent,
  message: "agent not found",
};

export interface PublicAgentJsonResponse {
  status: number;
  headers?: Record<string, string>;
  body: unknown;
}

export interface PublicAgentJsonResponseTarget {
  setHeader(name: string, value: string): unknown;
  status(code: number): { json(body: unknown): unknown };
}

export function sendPublicAgentJsonResponse(
  res: PublicAgentJsonResponseTarget,
  result: PublicAgentJsonResponse,
): void {
  if (result.headers) {
    for (const [name, value] of Object.entries(result.headers)) {
      res.setHeader(name, value);
    }
  }
  res.status(result.status).json(result.body);
}

export function listPublicAgentsResponse(input: {
  db: Database.Database;
  servedAt: Date;
  query: PublicAgentListQueryResult;
}):
  | {
      status: 200;
      body: {
        schema_version: typeof SCHEMA_VERSION;
        served_at: string;
        kind: AgentKind;
        count: number;
        rows: Array<ReturnType<typeof publicMurmurAgentListRow>>;
      };
    }
  | {
      status: 400;
      body: {
        code: "invalid_kind";
        message: string;
      };
    } {
  const query = input.query;
  if ("status" in query) return query;
  const rows = agentsRepo.listByKind(input.db, query.kind, query.limit);
  return {
    status: 200,
    body: {
      schema_version: SCHEMA_VERSION,
      served_at: nowIso(input.servedAt),
      kind: query.kind,
      count: rows.length,
      rows: rows.map(publicMurmurAgentListRow),
    },
  };
}

export function publicAgentProfileResponse(input: {
  db: Database.Database;
  slug: string;
}):
  | {
      status: 200;
      body: NonNullable<ReturnType<typeof publicMurmurAgentProfile>>;
    }
  | {
      status: 404;
      body: typeof unknownAgentBody;
    } {
  const row = agentsRepo.bySlug(input.db, input.slug);
  if (!row) {
    return { status: 404, body: unknownAgentBody };
  }
  const profile = publicMurmurAgentProfile(row);
  if (!profile) {
    return { status: 404, body: unknownAgentBody };
  }
  return { status: 200, body: profile };
}

export function publicAgentCardResponse(input: {
  db: Database.Database;
  slug: string;
  apiBase: string;
  servedAt: Date;
}):
  | {
      status: 200;
      headers: {
        "Content-Type": typeof MURMUR_AGENT_CARD_CONTENT_TYPE;
        "Cache-Control": typeof MURMUR_AGENT_CARD_CACHE_CONTROL;
        "Access-Control-Allow-Origin": typeof MURMUR_AGENT_CARD_CORS_ORIGIN;
      };
      body: ReturnType<typeof publicMurmurAgentCard>;
    }
  | {
      status: 404;
      body: typeof unknownAgentBody;
    } {
  const row = agentsRepo.bySlug(input.db, input.slug);
  if (!row) {
    return { status: 404, body: unknownAgentBody };
  }
  return {
    status: 200,
    headers: {
      "Content-Type": MURMUR_AGENT_CARD_CONTENT_TYPE,
      "Cache-Control": MURMUR_AGENT_CARD_CACHE_CONTROL,
      "Access-Control-Allow-Origin": MURMUR_AGENT_CARD_CORS_ORIGIN,
    },
    body: publicMurmurAgentCard({
      agent: row,
      apiBase: input.apiBase,
      servedAt: nowIso(input.servedAt),
    }),
  };
}

export function publicAgentCallsResponse(input: {
  db: Database.Database;
  slug: string;
  query: PublicAgentCallsQuery;
}):
  | {
      status: 200;
      body: {
        agent_id: string;
        display_slug: string;
        kind: AgentKind;
        calls: ReturnType<typeof listPublicAgentCallProjections>;
      };
    }
  | {
      status: 404;
      body: typeof unknownAgentBody;
    } {
  const agent = agentsRepo.bySlug(input.db, input.slug);
  if (!agent) {
    return { status: 404, body: unknownAgentBody };
  }
  const calls = listPublicAgentCallProjections({
    db: input.db,
    agent_id: agent.agent_id,
    agent_slug: agent.display_slug,
    limit: input.query.limit,
  });
  return {
    status: 200,
    body: {
      agent_id: agent.agent_id,
      display_slug: agent.display_slug,
      kind: agent.kind,
      calls,
    },
  };
}
