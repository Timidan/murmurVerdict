import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { agentsRepo, submissionsRepo, usageRepo } from "../verdict/db.js";
import { submitCall, type SubmissionContext } from "../verdict/submissions.js";
import {
  AgentSlugSchema,
  ERROR_CODES,
  HORIZONS_HOURS,
  HorizonHours,
  REGISTERED_STRATEGY_TAGS,
  SCHEMA_VERSION,
  Side,
  SubmittedCall,
  VerdictError,
  VerifiedIdentityKindSchema,
  type VerifiedIdentityKind,
} from "../verdict/schema.js";

// ─── Tagged-post parser ──────────────────────────────────────────────────────
//
// Format: `#MurmurCall <ASSET> <SIDE> <HORIZON> <CONFIDENCE> [— optional rationale]`
//   ASSET      ∈ { ETH }
//   SIDE       ∈ { BUY, SELL }
//   HORIZON    ∈ { 1H, 4H, 24H, 168H }
//   CONFIDENCE: percent integer (51–95) OR decimal (0.51–0.95)
//
// Examples:
//   "#MurmurCall ETH BUY 4H 72"
//   "#MurmurCall ETH SELL 24H 0.85 — euphoria fade in 5d"
//   "#murmurcall ETH SELL 168h 60% rolling exhaustion thesis"
//
// Anything that does not start with `#MurmurCall` (case-insensitive) is
// rejected outright. We do not LLM-parse free-form posts.

export interface ParsedTaggedCall {
  asset_id: "base:ETH:USD";
  side: Side;
  horizon_hours: HorizonHours;
  confidence: number;
  rationale?: string;
}

export class TaggedParseError extends Error {
  constructor(message: string, public readonly text: string) {
    super(message);
    this.name = "TaggedParseError";
  }
}

const TAG_PREFIX_RE = /^\s*#murmurcall\b\s*/i;
const HORIZON_MAP: Record<string, HorizonHours> = {
  "1H": 1,
  "4H": 4,
  "24H": 24,
  "168H": 168,
};

export function parseTaggedPost(raw: string): ParsedTaggedCall {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new TaggedParseError("empty post", raw);
  }
  const tagMatch = TAG_PREFIX_RE.exec(raw);
  if (!tagMatch) throw new TaggedParseError("missing #MurmurCall tag", raw);
  const remainder = raw.slice(tagMatch[0].length);
  const tokens = remainder.trim().split(/\s+/);
  if (tokens.length < 4) {
    throw new TaggedParseError("expected at least 4 tokens after tag", raw);
  }
  const [assetTok, sideTok, horizonTok, confTok, ...rest] = tokens;
  const asset = (assetTok ?? "").toUpperCase();
  if (asset !== "ETH") {
    throw new TaggedParseError(`unsupported asset ${assetTok}`, raw);
  }
  const sideU = (sideTok ?? "").toUpperCase();
  if (sideU !== "BUY" && sideU !== "SELL") {
    throw new TaggedParseError(`bad side ${sideTok}`, raw);
  }
  const horizonU = (horizonTok ?? "").toUpperCase();
  const horizon = HORIZON_MAP[horizonU];
  if (!horizon) {
    throw new TaggedParseError(
      `bad horizon ${horizonTok} (need ${HORIZONS_HOURS.map((h) => `${h}H`).join("|")})`,
      raw,
    );
  }
  const confidence = parseConfidence(confTok ?? "");
  if (confidence === null) {
    throw new TaggedParseError(`bad confidence ${confTok}`, raw);
  }
  const rationaleRaw = rest.join(" ").trim();
  // Strip leading em-dash / hyphen separators if present.
  const rationale = rationaleRaw
    .replace(/^[—–-]\s*/, "")
    .slice(0, 240)
    .trim();
  return {
    asset_id: "base:ETH:USD",
    side: sideU as Side,
    horizon_hours: horizon,
    confidence,
    rationale: rationale.length > 0 ? rationale : undefined,
  };
}

function parseConfidence(token: string): number | null {
  if (!token) return null;
  const trimmed = token.replace(/[%]\s*$/, "");
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return null;
  let asDecimal = n;
  if (n >= 51 && n <= 95) asDecimal = n / 100;
  if (asDecimal < 0.51 || asDecimal > 0.95) return null;
  return asDecimal;
}

// ─── Shadow source identity ──────────────────────────────────────────────────

export interface ShadowSource {
  kind: VerifiedIdentityKind;
  /** External handle as it appears in the wild (e.g. "@some_handle"). */
  value: string;
  /** Human display name for the auto-created shadow agent. */
  display_name?: string;
}

const MAX_SLUG_LENGTH = 48;

function sanitizeForSlug(s: string): string {
  return s
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function shadowSlugFor(source: ShadowSource): string {
  const base = `shadow-${source.kind}-${sanitizeForSlug(source.value)}`;
  const trimmed = base.slice(0, MAX_SLUG_LENGTH).replace(/-+$/, "");
  // Validate against the same regex as user-supplied slugs so we never insert junk.
  return AgentSlugSchema.parse(trimmed);
}

// ─── Ingest pipeline ─────────────────────────────────────────────────────────

export interface IngestDeps {
  db: Database.Database;
  ctx: SubmissionContext;
  now?: () => Date;
  /** Override submitCall (for tests). */
  submit?: typeof submitCall;
}

export interface ShadowIngestInput {
  source: ShadowSource;
  /** Raw post text including the `#MurmurCall` tag. */
  post_text: string;
  /** When the post was published. */
  posted_at: string;
  /** External post URL or message ID, useful for auditing. */
  source_url?: string;
}

export interface ShadowIngestResult {
  status: "accepted" | "skipped" | "rejected";
  call_id?: string;
  agent_id: string;
  display_slug: string;
  reason?: string;
}

/**
 * Find or create the shadow agent profile for this source. Idempotent: a
 * shadow agent maps 1:1 to a `(kind, value)` verified identity row.
 */
export function findOrCreateShadowAgent(
  db: Database.Database,
  source: ShadowSource,
): { agent_id: string; display_slug: string } {
  const kind = VerifiedIdentityKindSchema.parse(source.kind);
  // Prefer existing identity binding (works for both shadow + verified agents).
  const existing = db
    .prepare(
      `SELECT a.agent_id, a.display_slug, a.kind
       FROM verified_identities vi
       JOIN agents a ON a.agent_id = vi.agent_id
       WHERE vi.kind = ? AND vi.value = ?`,
    )
    .get(kind, source.value) as
    | { agent_id: string; display_slug: string; kind: string }
    | undefined;
  if (existing) {
    return { agent_id: existing.agent_id, display_slug: existing.display_slug };
  }
  const slug = shadowSlugFor(source);
  const created_at = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const agent_id = randomUUID();
  agentsRepo.insert(db, {
    agent_id,
    display_slug: slug,
    kind: "shadow",
    display_name: source.display_name ?? source.value,
    bio: undefined,
    verified_identities: [{ kind, value: source.value, verified_at: created_at }],
    created_at,
  });
  return { agent_id, display_slug: slug };
}

/**
 * Ingest a tagged public post into the system. Only `#MurmurCall …`-format
 * posts are accepted. Anything else returns `rejected` with a reason; the
 * caller is responsible for not retrying.
 */
export async function ingestShadowPost(
  deps: IngestDeps,
  input: ShadowIngestInput,
): Promise<ShadowIngestResult> {
  const submit = deps.submit ?? submitCall;
  const now = deps.now ?? (() => new Date());

  let parsed: ParsedTaggedCall;
  try {
    parsed = parseTaggedPost(input.post_text);
  } catch (err) {
    const reason = err instanceof TaggedParseError ? err.message : "parse_error";
    return { status: "rejected", agent_id: "", display_slug: "", reason };
  }

  const { agent_id, display_slug } = findOrCreateShadowAgent(deps.db, input.source);

  const submitted_at_iso = isoZ(input.posted_at) ?? nowIso(now());
  // Public-post `client_order_id` derives from agent + post timestamp + parsed
  // call shape. Re-ingesting the same post returns the same accepted call.
  const client_order_id = makeClientOrderId({
    agent_id,
    submitted_at_iso,
    side: parsed.side,
    horizon_hours: parsed.horizon_hours,
    confidence: parsed.confidence,
  });

  const payload: SubmittedCall = {
    schema_version: SCHEMA_VERSION,
    agent_id,
    client_order_id,
    asset_id: parsed.asset_id,
    side: parsed.side,
    horizon_hours: parsed.horizon_hours,
    confidence: parsed.confidence,
    submitted_at: submitted_at_iso,
    rationale: parsed.rationale,
    strategy_tag:
      parsed.rationale && parsed.rationale.length > 0
        ? undefined
        : REGISTERED_STRATEGY_TAGS[0], // fallback so schema's "rationale OR strategy_tag" rule is satisfied
  };

  try {
    const result = await submit({
      db: deps.db,
      ctx: { ...deps.ctx, now },
      identity: { agent_id },
      payload,
    });
    usageRepo.emit(deps.db, {
      event_id: randomUUID(),
      agent_id,
      kind: "shadow_card_posted",
      ts: nowIso(now()),
      attributes: {
        call_id: result.call.call_id,
        source_kind: input.source.kind,
        source_value: input.source.value,
        source_url: input.source_url,
      },
    });
    return {
      status: result.idempotent_hit ? "skipped" : "accepted",
      call_id: result.call.call_id,
      agent_id,
      display_slug,
    };
  } catch (err) {
    if (err instanceof VerdictError) {
      if (err.code === ERROR_CODES.duplicate || err.code === ERROR_CODES.rate_limited) {
        return {
          status: "skipped",
          agent_id,
          display_slug,
          reason: err.code,
        };
      }
      return {
        status: "rejected",
        agent_id,
        display_slug,
        reason: err.code,
      };
    }
    throw err;
  }
}

/**
 * Lookback list used by the claim flow: returns shadow call_ids tied to the
 * given external identity within the lookback window. Caller decides whether
 * to import them.
 */
export function listShadowCallsForIdentity(
  db: Database.Database,
  source: ShadowSource,
  sinceIso: string,
): Array<{ call_id: string; agent_id: string }> {
  const rows = db
    .prepare(
      `SELECT s.call_id, s.agent_id
       FROM verified_identities vi
       JOIN agents a ON a.agent_id = vi.agent_id
       JOIN submissions s ON s.agent_id = a.agent_id
       WHERE vi.kind = ? AND vi.value = ? AND s.submitted_at >= ?`,
    )
    .all(source.kind, source.value, sinceIso) as Array<{
    call_id: string;
    agent_id: string;
  }>;
  return rows;
}

// Deliberately ignore submissionsRepo here; the listShadowCallsForIdentity
// query goes direct for performance and to avoid a bespoke repo method.
void submissionsRepo;

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeClientOrderId(args: {
  agent_id: string;
  submitted_at_iso: string;
  side: Side;
  horizon_hours: HorizonHours;
  confidence: number;
}): string {
  const stamp = args.submitted_at_iso.replace(/[:.\-Z]/g, "");
  const conf = Math.round(args.confidence * 100);
  return `shadow-${args.agent_id.slice(0, 8)}-${stamp}-${args.side}-${args.horizon_hours}-${conf}`.slice(
    0,
    128,
  );
}

function isoZ(s: string | undefined | null): string | null {
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().replace(/\.\d+Z$/, "Z");
}

function nowIso(d: Date): string {
  return d.toISOString().replace(/\.\d+Z$/, "Z");
}
