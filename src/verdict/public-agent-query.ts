import {
  boundedIntegerQuery,
  firstQueryValue,
} from "./route-query.js";
import type { AgentKind } from "./schema.js";

export const PUBLIC_AGENT_KINDS = [
  "agent",
  "attested",
  "benchmark",
  "internal_test",
] as const satisfies readonly AgentKind[];

export interface PublicAgentListQuery {
  kind: AgentKind;
  limit: number;
}

export interface PublicAgentCallsQuery {
  limit: number;
}

export interface PublicAgentRssQuery {
  limit: number;
}

export interface PublicAgentQueryError {
  status: 400;
  body: {
    code: "invalid_kind";
    message: string;
  };
}

export type PublicAgentListQueryResult = PublicAgentListQuery | PublicAgentQueryError;

export function publicAgentListQuery(
  query: Record<string, unknown>,
): PublicAgentListQueryResult {
  const kind = firstQueryValue(query.kind) ?? "";
  if (!PUBLIC_AGENT_KINDS.includes(kind as AgentKind)) {
    return {
      status: 400,
      body: {
        code: "invalid_kind",
        message: `kind must be one of ${PUBLIC_AGENT_KINDS.join("|")}`,
      },
    };
  }
  return {
    kind: kind as AgentKind,
    limit: boundedIntegerQuery(query.limit, { fallback: 100, max: 200 }),
  };
}

export function publicAgentCallsQuery(
  query: Record<string, unknown>,
): PublicAgentCallsQuery {
  return {
    limit: boundedIntegerQuery(query.limit, { fallback: 50, max: 500 }),
  };
}

export function publicAgentRssQuery(
  query: Record<string, unknown>,
): PublicAgentRssQuery {
  return {
    limit: boundedIntegerQuery(query.limit, { fallback: 20, max: 50 }),
  };
}
