import type Database from "better-sqlite3";

import {
  projectCallRow,
  type CallRowFields,
  type PublicCallProjection,
} from "./projections.js";
import type { PublicRssCallRow } from "./public-rss.js";
import {
  fhenixSealedCallsRepo,
} from "./repos/fhenix-sealed-calls-repo.js";
import {
  resolutionsRepo,
  type FullCallResolutionView,
} from "./repos/resolution-repo.js";
import {
  publicFhenixRevealEvidence,
  type PublicFhenixRevealEvidence,
} from "./fhenix-reveal-public-evidence.js";

export interface PublicAgentCallProjection extends PublicCallProjection {
  adapter_id: string;
  market_family: string;
  market_id?: string;
}

export interface ListPublicAgentCallProjectionsInput {
  db: Database.Database;
  agent_id: string;
  agent_slug?: string;
  limit: number;
}

export interface PublicSealedCallSubmission {
  call_id: string;
  agent_id: string;
  client_order_id?: string;
  market_id: string | null;
  horizon_seconds: number;
  accepted_at: string;
  status: string;
  privacy_mode: string;
  commit_hash: string | null;
  submitted_at?: string;
}

export interface PublicSealedCallView {
  submission: PublicSealedCallSubmission;
  t0: FullCallResolutionView["t0"];
  resolution: FullCallResolutionView["resolution"];
  fhenix?: PublicFhenixRevealEvidence;
}

export type PublicSealedCallViewAudience =
  | "public-summary"
  | "public-call-detail";

interface PublicSealedCallViewVisibility {
  includeClientOrderId: boolean;
  includeFhenix: boolean;
}

const publicSealedCallViewVisibility: Record<
  PublicSealedCallViewAudience,
  PublicSealedCallViewVisibility
> = {
  "public-summary": {
    includeClientOrderId: false,
    includeFhenix: false,
  },
  "public-call-detail": {
    includeClientOrderId: true,
    includeFhenix: true,
  },
};

export interface LoadPublicSealedCallViewInput {
  db: Database.Database;
  call_id: string;
  audience?: PublicSealedCallViewAudience;
}

type PublicCallSqlRow = Record<string, unknown>;

export function listPublicAgentCallProjections(
  input: ListPublicAgentCallProjectionsInput,
): PublicAgentCallProjection[] {
  const limit = Math.max(1, Math.min(500, Math.floor(input.limit)));
  const rows = input.db
    .prepare(
      `SELECT s.call_id, s.status,
              s.submitted_at, s.accepted_at,
              s.privacy_mode, s.commit_hash,
              s.adapter_id, s.market_family, s.market_id,
              r.outcome, r.call_score, r.signed_return, r.resolved_at
         FROM submissions s
         LEFT JOIN t1_resolutions r ON r.call_id = s.call_id
        WHERE s.agent_id = ?
        ORDER BY s.accepted_at DESC
        LIMIT ?`,
    )
    .all(input.agent_id, limit) as PublicCallSqlRow[];
  return rows.map((row) => projectPublicCallRow(row, input.agent_slug));
}

export function projectPublicCallRow(
  row: PublicCallSqlRow,
  agent_slug?: string,
): PublicAgentCallProjection {
  const adapter_id = stringOrDefault(row.adapter_id, "native-price");
  const market_family = stringOrDefault(row.market_family, "financial-direction");
  const market_id = typeof row.market_id === "string" ? row.market_id : null;
  const isNativePrice = adapter_id === "native-price";
  const fields: CallRowFields = {
    call_id: row.call_id as string,
    status: row.status as string,
    accepted_at: row.accepted_at as string,
    privacy_mode: nullableString(row.privacy_mode),
    commit_hash: nullableString(row.commit_hash),
    acceptance_receipt_hash: null,
    submitted_at: nullableString(row.submitted_at),
    ...(hasField(row, "outcome") ? { outcome: nullableString(row.outcome) } : {}),
    ...(hasField(row, "call_score")
      ? { call_score: nullableNumber(row.call_score) }
      : {}),
    ...(isNativePrice && hasField(row, "signed_return")
      ? { signed_return: nullableString(row.signed_return) }
      : {}),
    ...(hasField(row, "resolved_at")
      ? { resolved_at: nullableString(row.resolved_at) }
      : {}),
  };
  const projected = projectCallRow(fields, agent_slug);
  return {
    ...projected,
    adapter_id,
    market_family,
    ...(market_id ? { market_id } : {}),
  };
}

export function publicRssCallRow(
  row: PublicAgentCallProjection,
): PublicRssCallRow {
  const isNativePrice = row.adapter_id === "native-price";
  return {
    call_id: row.call_id,
    status: row.status,
    is_sealed_scrubbed: true,
    submitted_at: row.submitted_at ?? "",
    accepted_at: row.accepted_at,
    adapter_id: row.adapter_id,
    market_family: row.market_family,
    outcome: row.outcome ?? null,
    call_score: row.call_score ?? null,
    signed_return: isNativePrice ? row.signed_return ?? null : null,
    resolved_at: row.resolved_at ?? null,
  };
}

export function loadPublicSealedCallView(
  input: LoadPublicSealedCallViewInput,
): PublicSealedCallView | null {
  const visibility =
    publicSealedCallViewVisibility[input.audience ?? "public-summary"];
  const full = resolutionsRepo.loadFullCall(input.db, input.call_id);
  if (!full) return null;
  const projected = projectCallRow({
    call_id: full.submission.call_id,
    status: full.submission.status,
    accepted_at: full.submission.accepted_at,
    privacy_mode: full.submission.privacy_mode,
    commit_hash: full.submission.commit_hash,
    acceptance_receipt_hash: null,
    submitted_at: full.submission.submitted_at,
  });
  const view: PublicSealedCallView = {
    submission: {
      call_id: full.submission.call_id,
      agent_id: full.submission.agent_id,
      ...(visibility.includeClientOrderId
        ? { client_order_id: full.submission.client_order_id }
        : {}),
      market_id: full.submission.market_id,
      horizon_seconds: full.submission.horizon_seconds,
      accepted_at: full.submission.accepted_at,
      status: full.submission.status,
      privacy_mode: projected.privacy_mode,
      commit_hash: projected.commit_hash,
      ...(projected.submitted_at ? { submitted_at: projected.submitted_at } : {}),
    },
    t0: full.t0,
    resolution: full.resolution,
  };
  if (
    visibility.includeFhenix &&
    full.submission.privacy_mode === "sealed_fhenix"
  ) {
    const fhenix = publicFhenixRevealEvidence(
      fhenixSealedCallsRepo.byCallId(input.db, input.call_id),
    );
    if (fhenix) view.fhenix = fhenix;
  }
  return view;
}

function stringOrDefault(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function hasField(row: PublicCallSqlRow, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(row, field);
}
