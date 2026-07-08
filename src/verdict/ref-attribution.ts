import type Database from "better-sqlite3";

import {
  makeAgentSecurityEvent,
  type AgentSecurityEventIdAdapter,
} from "./agent-security-event.js";
import type {
  RefAgentDiscoverersQuery,
  RefTopSendersQuery,
} from "./ref-attribution-query.js";
import { refsRepo } from "./repos/ref-attribution-repo.js";
import { agentSecurityEventsRepo } from "./repos/agent-security-events-repo.js";
import {
  REF_MAX_LENGTH,
  sanitizeRef,
} from "./ref-token.js";
import { SCHEMA_VERSION } from "./schema.js";
import { nowIso } from "./time.js";

export const REF_AGENT_SLUG_MAX_LENGTH = 64;

export interface RefAttributionError {
  code: "invalid_ref";
  message: string;
}

export interface RefClickInput {
  db: Database.Database;
  ref: unknown;
  agentSlug?: unknown;
  now: () => Date;
}

export interface RefAttributionReadInstant {
  servedAt: Date;
}

export interface RefClickResult {
  ref: string;
  agent_slug: string | null;
  clicked_at: string;
}

export interface RefTopSendersSnapshot {
  served_at: string;
  senders: ReturnType<typeof refsRepo.topSenders>;
}

export interface RefAgentDiscoverersSnapshot {
  slug: string;
  discoverers: ReturnType<typeof refsRepo.discoverersForAgent>;
}

export interface RefTopSendersResponse extends RefTopSendersSnapshot {
  schema_version: typeof SCHEMA_VERSION;
}

export interface RefAgentDiscoverersResponse extends RefAgentDiscoverersSnapshot {
  schema_version: typeof SCHEMA_VERSION;
}

export interface DeleteRefSenderInput {
  db: Database.Database;
  ref: unknown;
  now: () => Date;
  actor?: string;
  newAgentSecurityEventId?: AgentSecurityEventIdAdapter;
}

export interface DeleteRefSenderResult {
  ref: string;
  deleted_rows: number;
}

export type RecordRefClickResponse =
  | { status: 204 }
  | { status: 400; body: RefAttributionError };

export type DeleteRefSenderResponse =
  | { status: 200; body: { deleted: number } }
  | { status: 400; body: RefAttributionError };

export interface RefAttributionJsonResponseTarget {
  json(body: unknown): unknown;
}

export interface RefAttributionStatusResponseTarget {
  status(code: number): {
    end(): unknown;
    json(body: unknown): unknown;
  };
}

export function sendRefAttributionJsonResponse(
  res: RefAttributionJsonResponseTarget,
  result: unknown,
): void {
  res.json(result);
}

export function sendRecordRefClickResponse(
  res: RefAttributionStatusResponseTarget,
  result: RecordRefClickResponse,
): void {
  if (result.status === 204) {
    res.status(204).end();
    return;
  }
  res.status(result.status).json(result.body);
}

export function sendDeleteRefSenderResponse(
  res: RefAttributionStatusResponseTarget,
  result: DeleteRefSenderResponse,
): void {
  res.status(result.status).json(result.body);
}

export function sanitizeRefAgentSlug(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  return raw.slice(0, REF_AGENT_SLUG_MAX_LENGTH);
}

export function recordRefClick(
  input: RefClickInput,
): RefClickResult | RefAttributionError {
  const ref = sanitizeRef(input.ref);
  if (!ref) return invalidRef();
  const agentSlug = sanitizeRefAgentSlug(input.agentSlug);
  const clickedAt = nowIso(input.now());
  refsRepo.bumpClick(input.db, ref, agentSlug, clickedAt);
  return {
    ref,
    agent_slug: agentSlug,
    clicked_at: clickedAt,
  };
}

export function recordRefClickResponse(input: RefClickInput): RecordRefClickResponse {
  const click = recordRefClick(input);
  if ("code" in click) return { status: 400, body: click };
  return { status: 204 };
}

export function refTopSendersSnapshot(
  db: Database.Database,
  opts: {
    query: RefTopSendersQuery;
  } & RefAttributionReadInstant,
): RefTopSendersSnapshot {
  return {
    served_at: nowIso(opts.servedAt),
    senders: refsRepo.topSenders(db, opts.query.limit),
  };
}

export function refTopSendersResponse(
  db: Database.Database,
  opts: {
    query: RefTopSendersQuery;
  } & RefAttributionReadInstant,
): RefTopSendersResponse {
  return {
    schema_version: SCHEMA_VERSION,
    ...refTopSendersSnapshot(db, opts),
  };
}

export function refAgentDiscoverersSnapshot(
  db: Database.Database,
  opts: {
    slug: unknown;
    query: RefAgentDiscoverersQuery;
  },
): RefAgentDiscoverersSnapshot {
  const slug = String(opts.slug ?? "");
  return {
    slug,
    discoverers: refsRepo.discoverersForAgent(db, slug, opts.query.limit),
  };
}

export function refAgentDiscoverersResponse(
  db: Database.Database,
  opts: {
    slug: unknown;
    query: RefAgentDiscoverersQuery;
  },
): RefAgentDiscoverersResponse {
  return {
    schema_version: SCHEMA_VERSION,
    ...refAgentDiscoverersSnapshot(db, opts),
  };
}

export function deleteRefSender(
  input: DeleteRefSenderInput,
): DeleteRefSenderResult | RefAttributionError {
  const ref = sanitizeRef(input.ref);
  if (!ref) return invalidRef();
  const deletedRows = input.db.transaction(() => {
    const deleted = refsRepo.deleteSender(input.db, ref);
    agentSecurityEventsRepo.emit(
      input.db,
      makeAgentSecurityEvent({
        kind: "admin_ref_delete",
        actor: input.actor ?? "admin_token",
        newEventId: input.newAgentSecurityEventId,
        payload: { ref, deleted_rows: deleted },
        createdAt: input.now(),
      }),
    );
    return deleted;
  })();
  return { ref, deleted_rows: deletedRows };
}

export function deleteRefSenderResponse(
  input: DeleteRefSenderInput,
): DeleteRefSenderResponse {
  const deleted = deleteRefSender(input);
  if ("code" in deleted) return { status: 400, body: deleted };
  return { status: 200, body: { deleted: deleted.deleted_rows } };
}

function invalidRef(): RefAttributionError {
  return {
    code: "invalid_ref",
    message: `ref must be 1-${REF_MAX_LENGTH} chars [a-zA-Z0-9_.-]`,
  };
}
