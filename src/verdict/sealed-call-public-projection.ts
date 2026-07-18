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

export interface PublicMarketCallProjection extends PublicAgentCallProjection {
  display_name: string;
}

export interface ListPublicMarketCallProjectionsInput {
  db: Database.Database;
  market_id: string;
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

/**
 * Recent calls on one market, newest first — the per-market twin of
 * {@link listPublicAgentCallProjections}. Same operator-blind projection:
 * pending sealed rows surface existence + timestamps + agent identity
 * only (plaintext direction/confidence/rationale columns are never
 * selected); resolved-side fields ride in from t1_resolutions.
 */
export function listPublicMarketCallProjections(
  input: ListPublicMarketCallProjectionsInput,
): PublicMarketCallProjection[] {
  const limit = Math.max(1, Math.min(500, Math.floor(input.limit)));
  const rows = input.db
    .prepare(
      `SELECT s.call_id, s.status,
              s.submitted_at, s.accepted_at,
              s.privacy_mode, s.commit_hash,
              s.adapter_id, s.market_family, s.market_id,
              a.display_slug, a.display_name,
              r.outcome, r.call_score, r.signed_return, r.resolved_at
         FROM submissions s
         JOIN agents a ON a.agent_id = s.agent_id
         LEFT JOIN t1_resolutions r ON r.call_id = s.call_id
        WHERE s.market_id = ?
        ORDER BY s.accepted_at DESC
        LIMIT ?`,
    )
    .all(input.market_id, limit) as PublicCallSqlRow[];
  return rows.map((row) => ({
    ...projectPublicCallRow(
      row,
      typeof row.display_slug === "string" ? row.display_slug : undefined,
    ),
    display_name: stringOrDefault(row.display_name, "unknown"),
  }));
}

/**
 * The native-price gate for the resolved-side `signed_return` field — the ONE
 * place that knows the "native-price" adapter literal. Non-native adapters
 * (venue / prediction-market families) never carry a scalar return, so every
 * public surface (REST agent/market list, RSS, SSE/webhook) omits the field for
 * them by routing its gate decision through here.
 */
export function isNativePriceAdapter(adapter_id: unknown): boolean {
  return adapter_id === "native-price";
}

/** Input for {@link projectPublicResolvedCallFields}. */
export interface ResolvedCallProjectionInput {
  adapter_id?: string | null;
  market_family?: string | null;
  market_id?: string | null;
  outcome: string;
  call_score: number | null;
  signed_return: string | null;
  resolved_at: string;
}

/** Resolved-side public field set — see {@link projectPublicResolvedCallFields}. */
export interface PublicResolvedCallFields {
  outcome: string;
  call_score: number | null;
  signed_return?: string | null;
  resolved_at: string;
  adapter_id: string;
  market_family: string;
  market_id?: string;
}

/**
 * SINGLE OWNER of the resolved-side public field set: outcome, call_score, the
 * native-price `signed_return` gate, resolved_at, and the adapter / market-family
 * defaults. The SSE/webhook `call.resolved` event (publicResolvedCallEvent in
 * public-event-fanout.ts) builds its resolved half from THIS function so its
 * wire shape cannot drift from the REST/RSS row projections in this module,
 * which apply the same gate via {@link isNativePriceAdapter}.
 *
 * `signed_return` is surfaced ONLY for native-price adapters (the scalar-return
 * concept doesn't apply to venue/prediction-market adapters); it is omitted for
 * every other adapter. `market_id` is omitted when absent.
 */
export function projectPublicResolvedCallFields(
  input: ResolvedCallProjectionInput,
): PublicResolvedCallFields {
  const adapter_id = stringOrDefault(input.adapter_id, "native-price");
  const market_family = stringOrDefault(input.market_family, "financial-direction");
  const market_id = typeof input.market_id === "string" ? input.market_id : null;
  return {
    outcome: input.outcome,
    call_score: input.call_score ?? null,
    ...(isNativePriceAdapter(adapter_id)
      ? { signed_return: input.signed_return }
      : {}),
    resolved_at: input.resolved_at,
    adapter_id,
    market_family,
    ...(market_id ? { market_id } : {}),
  };
}

export function projectPublicCallRow(
  row: PublicCallSqlRow,
  agent_slug?: string,
): PublicAgentCallProjection {
  const adapter_id = stringOrDefault(row.adapter_id, "native-price");
  const market_family = stringOrDefault(row.market_family, "financial-direction");
  const market_id = typeof row.market_id === "string" ? row.market_id : null;
  const isNativePrice = isNativePriceAdapter(adapter_id);
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
  const isNativePrice = isNativePriceAdapter(row.adapter_id);
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
