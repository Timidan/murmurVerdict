import type Database from "better-sqlite3";
import {
  AcceptanceReceiptPayloadSchema,
  ResolutionReceiptPayloadSchema,
} from "./schema.js";
import { canonicalHash } from "../receipts/canonical.js";
import {
  computeSignedReturn,
  outcomeFromSignedReturn,
  scoreCall,
} from "./scoring.js";
import type { AssetId, HorizonHours, Side } from "./schema.js";

// ─── /v1/calls/:id/verify ─────────────────────────────────────────────────────
//
// Independent recomputation of the receipt chain from the canonical JSON
// stored in `receipts.canonical_json`. Rebuilds:
//   - acceptance_receipt_hash   (canonical hash of the stored payload)
//   - resolution_receipt_hash   (same)
//   - signed_return             (from t0/p0/p1)
//   - outcome                   (from signed_return, void band, scoring formula)
//   - call_score                (from horizon, confidence, expected vol, signed return)
// and compares each independently-recomputed value against the stored value.
//
// PASS = every dimension matches. FAIL = any dimension mismatches, with detail.
// A third party with the canonical JSON can run the same checks themselves.

export interface VerifyResult {
  call_id: string;
  passes: boolean;
  checks: VerifyCheck[];
  /** Frozen scoring/schema versions used during recomputation. */
  scoring_version: number;
  schema_version: number;
  /** When the verification ran. */
  verified_at: string;
}

export interface VerifyCheck {
  name:
    | "acceptance_receipt_hash"
    | "resolution_receipt_hash"
    | "signed_return"
    | "outcome"
    | "call_score";
  status: "match" | "mismatch" | "skipped";
  stored: string | number | null;
  recomputed: string | number | null;
  /** Optional note for skipped/missing data. */
  note?: string;
}

export class VerifyError extends Error {
  constructor(message: string, public readonly code: "not_found" | "malformed_data") {
    super(message);
    this.name = "VerifyError";
  }
}

export function verifyReceiptChain(
  db: Database.Database,
  call_id: string,
  now: () => Date = () => new Date(),
): VerifyResult {
  const checks: VerifyCheck[] = [];

  const subRow = db
    .prepare(
      `SELECT s.*, p.murmur_score, p.murmur_playbook, p.risk_flags_json,
              p.data_freshness_seconds, p.market_regime,
              op.primary_feed, op.fallback_feed, op.primary_max_staleness_sec,
              op.fallback_max_staleness_sec, op.t0_grace_seconds, op.t0_extended_grace_seconds
       FROM submissions s
       JOIN preflights p ON p.call_id = s.call_id
       JOIN oracle_policies op ON op.call_id = s.call_id
       WHERE s.call_id = ?`,
    )
    .get(call_id) as Record<string, unknown> | undefined;
  if (!subRow) throw new VerifyError("call not found", "not_found");

  const acceptanceRow = db
    .prepare(
      `SELECT receipt_hash, canonical_json
       FROM receipts WHERE call_id = ? AND kind = 'acceptance'`,
    )
    .get(call_id) as
    | { receipt_hash: string; canonical_json: string }
    | undefined;
  if (!acceptanceRow) throw new VerifyError("acceptance receipt missing", "malformed_data");

  // ── Acceptance receipt hash ──
  let acceptancePayload: unknown;
  try {
    acceptancePayload = JSON.parse(acceptanceRow.canonical_json);
  } catch {
    throw new VerifyError("acceptance canonical_json unparseable", "malformed_data");
  }
  const parsedAcceptance = AcceptanceReceiptPayloadSchema.safeParse(acceptancePayload);
  if (!parsedAcceptance.success) {
    throw new VerifyError("acceptance payload failed schema", "malformed_data");
  }
  const recomputedAcceptanceHash = canonicalHash(parsedAcceptance.data);
  checks.push({
    name: "acceptance_receipt_hash",
    status: recomputedAcceptanceHash === acceptanceRow.receipt_hash ? "match" : "mismatch",
    stored: acceptanceRow.receipt_hash,
    recomputed: recomputedAcceptanceHash,
  });

  // ── Resolution side (skip if unresolved) ──
  const resolutionRow = db
    .prepare(
      `SELECT r.outcome, r.signed_return, r.call_score, r.t1, r.p1, r.t1_feed, r.resolved_at,
              rec.receipt_hash, rec.canonical_json, rec.previous_hash
       FROM t1_resolutions r
       LEFT JOIN receipts rec ON rec.call_id = r.call_id AND rec.kind IN ('resolution','re_resolution')
       WHERE r.call_id = ?
       ORDER BY rec.created_at DESC
       LIMIT 1`,
    )
    .get(call_id) as
    | {
        outcome: string;
        signed_return: string;
        call_score: number | null;
        t1: string;
        p1: string;
        t1_feed: string;
        resolved_at: string;
        receipt_hash: string | null;
        canonical_json: string | null;
        previous_hash: string | null;
      }
    | undefined;

  if (!resolutionRow || !resolutionRow.canonical_json || !resolutionRow.receipt_hash) {
    checks.push({
      name: "resolution_receipt_hash",
      status: "skipped",
      stored: null,
      recomputed: null,
      note: resolutionRow ? "resolution row exists but no receipt yet" : "not yet resolved",
    });
    checks.push({
      name: "signed_return",
      status: "skipped",
      stored: null,
      recomputed: null,
      note: "not yet resolved",
    });
    checks.push({
      name: "outcome",
      status: "skipped",
      stored: null,
      recomputed: null,
      note: "not yet resolved",
    });
    checks.push({
      name: "call_score",
      status: "skipped",
      stored: null,
      recomputed: null,
      note: "not yet resolved",
    });
  } else {
    let resolutionPayload: unknown;
    try {
      resolutionPayload = JSON.parse(resolutionRow.canonical_json);
    } catch {
      throw new VerifyError("resolution canonical_json unparseable", "malformed_data");
    }
    const parsedResolution = ResolutionReceiptPayloadSchema.safeParse(resolutionPayload);
    if (!parsedResolution.success) {
      throw new VerifyError("resolution payload failed schema", "malformed_data");
    }
    const recomputedResolutionHash = canonicalHash(parsedResolution.data);
    checks.push({
      name: "resolution_receipt_hash",
      status: recomputedResolutionHash === resolutionRow.receipt_hash ? "match" : "mismatch",
      stored: resolutionRow.receipt_hash,
      recomputed: recomputedResolutionHash,
    });

    // Pull t0 anchor for signed-return recomputation.
    const t0Row = db
      .prepare("SELECT t0, p0 FROM t0_anchors WHERE call_id = ?")
      .get(call_id) as { t0: string; p0: string } | undefined;

    if (
      t0Row &&
      resolutionRow.outcome !== "oracle_unavailable" &&
      Number(resolutionRow.p1) > 0
    ) {
      const r = computeSignedReturn(
        subRow.side as Side,
        t0Row.p0,
        resolutionRow.p1,
      );
      const recomputedSignedReturn = r.toFixed(8);
      checks.push({
        name: "signed_return",
        status: recomputedSignedReturn === resolutionRow.signed_return ? "match" : "mismatch",
        stored: resolutionRow.signed_return,
        recomputed: recomputedSignedReturn,
      });

      const recomputedOutcome = outcomeFromSignedReturn(r);
      checks.push({
        name: "outcome",
        status: recomputedOutcome === resolutionRow.outcome ? "match" : "mismatch",
        stored: resolutionRow.outcome,
        recomputed: recomputedOutcome,
      });

      const recomputedScore = scoreCall({
        asset_id: subRow.asset_id as AssetId,
        horizon_hours: subRow.horizon_hours as HorizonHours,
        confidence: subRow.confidence as number,
        signed_return: r,
        outcome: recomputedOutcome,
      }).call_score;
      const stored = resolutionRow.call_score;
      const matchesScore =
        stored === null && recomputedScore === null
          ? true
          : stored !== null &&
            recomputedScore !== null &&
            Math.abs(stored - recomputedScore) < 1e-9;
      checks.push({
        name: "call_score",
        status: matchesScore ? "match" : "mismatch",
        stored,
        recomputed: recomputedScore,
      });
    } else {
      // oracle_unavailable / placeholder data — skip semantic checks
      checks.push({
        name: "signed_return",
        status: "skipped",
        stored: resolutionRow.signed_return,
        recomputed: null,
        note: "oracle_unavailable or missing t0 anchor",
      });
      checks.push({
        name: "outcome",
        status: "skipped",
        stored: resolutionRow.outcome,
        recomputed: null,
        note: "oracle_unavailable or missing t0 anchor",
      });
      checks.push({
        name: "call_score",
        status: "skipped",
        stored: resolutionRow.call_score,
        recomputed: null,
        note: "oracle_unavailable or missing t0 anchor",
      });
    }
  }

  const passes = checks.every((c) => c.status !== "mismatch");
  return {
    call_id,
    passes,
    checks,
    scoring_version: 1,
    schema_version: 1,
    verified_at: now().toISOString().replace(/\.\d+Z$/, "Z"),
  };
}
