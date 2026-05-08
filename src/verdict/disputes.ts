import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  agentsRepo,
  anchorsRepo,
  disputesRepo,
  marketsRepo,
  resolutionsRepo,
  submissionsRepo,
  usageRepo,
} from "./db.js";
import {
  Dispute,
  DisputeGrounds,
  ERROR_CODES,
  OracleFeed,
  OracleFeedSchema,
  Outcome,
  ResolutionReceiptPayloadSchema,
  SCHEMA_VERSION,
  SCORING_VERSION,
  Side,
  VerdictError,
} from "./schema.js";
import { buildResolutionReceipt } from "../receipts/verdictReceipt.js";
import {
  computeSignedReturn,
  outcomeFromSignedReturn,
  scoreCall,
} from "./scoring.js";
import type { AssetId, HorizonHours } from "./schema.js";

// ─── Public types ────────────────────────────────────────────────────────────

export interface DisputeFileInput {
  /** keccak256 of the resolution receipt being disputed. */
  target_resolution_receipt_hash: `0x${string}`;
  grounds: DisputeGrounds;
  /** Optional human-readable note (≤ 1000 chars). */
  notes?: string;
  /** Who filed it — could be agent_id, operator handle, etc. */
  filed_by: string;
  now?: () => Date;
}

export interface DisputeFileResult {
  dispute_id: string;
  status: "open";
}

/**
 * Operator-supplied replay data. The dispute service does NOT fetch oracle data
 * itself — for v0.1 we trust the operator to source archived prices for the
 * disputed timestamps, and we replay the math. This is appropriate while
 * disputes are still admin-correct in nature; token-staked disputes ship
 * post-TGE.
 */
export interface ReplayInput {
  /** Override t0 anchor; if omitted, the existing anchor is used. */
  t0_override?: { t0: string; p0: string; feed: OracleFeed };
  /** Required: the t1 anchor under dispute. */
  t1_replay: { t1: string; p1: string; feed: OracleFeed };
}

export interface DisputeResolveInput {
  dispute_id: string;
  replay: ReplayInput;
  /** Whether to accept "no_change" replays (i.e. confirm the original outcome). */
  accept_unchanged?: boolean;
  pinReceipt?: (canonical_json: string) => Promise<string | null>;
  now?: () => Date;
}

export interface DisputeResolveResult {
  dispute_id: string;
  status: "upheld" | "rejected";
  /** New resolution receipt hash if upheld; null if rejected. */
  new_resolution_receipt_hash: `0x${string}` | null;
}

// ─── DisputeService ──────────────────────────────────────────────────────────

export interface DisputeServiceDeps {
  db: Database.Database;
}

export class DisputeService {
  private readonly db: Database.Database;

  constructor(deps: DisputeServiceDeps) {
    this.db = deps.db;
  }

  // ── file ──

  file(input: DisputeFileInput): DisputeFileResult {
    const now = (input.now ?? (() => new Date()))();
    const target = this.findResolutionByReceiptHash(
      input.target_resolution_receipt_hash,
    );
    if (!target) {
      throw new VerdictError(
        "no resolution receipt with that hash",
        ERROR_CODES.unknown_agent,
        404,
      );
    }
    const filed_at = nowIso(now);
    const dispute: Dispute = {
      dispute_id: randomUUID(),
      target_resolution_receipt_hash: input.target_resolution_receipt_hash,
      grounds: input.grounds,
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      filed_by: input.filed_by,
      filed_at,
      status: "open",
      resolved_at: null,
      new_resolution_receipt_hash: null,
    };
    disputesRepo.insert(this.db, dispute);
    usageRepo.emit(this.db, {
      event_id: randomUUID(),
      agent_id: target.agent_id,
      kind: "dispute_filed",
      ts: filed_at,
      attributes: {
        dispute_id: dispute.dispute_id,
        grounds: input.grounds,
        target_resolution_receipt_hash: input.target_resolution_receipt_hash,
        filed_by: input.filed_by,
      },
    });
    return { dispute_id: dispute.dispute_id, status: "open" };
  }

  // ── resolve via replay ──

  async resolve(input: DisputeResolveInput): Promise<DisputeResolveResult> {
    const now = (input.now ?? (() => new Date()))();
    const dispute = this.loadDispute(input.dispute_id);
    if (dispute.status !== "open") {
      throw new VerdictError(
        `dispute already ${dispute.status}`,
        ERROR_CODES.agent_not_authorized,
        409,
      );
    }
    disputesRepo.setStatus(this.db, dispute.dispute_id, "replay_in_progress");

    const target = this.findResolutionByReceiptHash(
      dispute.target_resolution_receipt_hash as `0x${string}`,
    );
    if (!target) {
      disputesRepo.setStatus(this.db, dispute.dispute_id, "rejected", nowIso(now), null);
      return { dispute_id: dispute.dispute_id, status: "rejected", new_resolution_receipt_hash: null };
    }

    const t0Anchor = anchorsRepo.getT0(this.db, target.call_id);
    const acceptanceHash = this.loadAcceptanceHash(target.call_id);

    const t0_iso = input.replay.t0_override?.t0 ?? t0Anchor?.t0 ?? null;
    const p0 = input.replay.t0_override?.p0 ?? t0Anchor?.p0 ?? null;
    const t0_feed_raw =
      input.replay.t0_override?.feed ?? (t0Anchor?.feed as OracleFeed | undefined) ?? null;

    if (!t0_iso || !p0 || !t0_feed_raw) {
      throw new VerdictError(
        "cannot replay: missing t0 anchor and no t0_override supplied",
        ERROR_CODES.schema_invalid,
        400,
      );
    }

    const t0_feed = OracleFeedSchema.parse(t0_feed_raw);
    const t1_feed = OracleFeedSchema.parse(input.replay.t1_replay.feed);

    const sub = submissionsRepo.loadResolverContext(this.db, target.call_id);
    if (!sub) {
      throw new VerdictError(
        "resolver context missing for call",
        ERROR_CODES.internal_error,
        500,
      );
    }
    const r = computeSignedReturn(
      sub.side as Side,
      p0,
      input.replay.t1_replay.p1,
    );
    // P4 Item 4 (Codex audit): replay must use the call's stamped market
    // policy, NOT the live markets row. Pull the historical snapshot
    // when the call has a market_id+market_config_version stamped.
    const histSnapshot =
      sub.market_id !== null && sub.market_config_version !== null
        ? marketsRepo.getConfigAt(
            this.db,
            sub.market_id,
            sub.market_config_version,
          )
        : null;
    const replayVoidBand = histSnapshot
      ? Number(histSnapshot.void_band)
      : undefined;
    const replayOutcome = outcomeFromSignedReturn(r, replayVoidBand);
    const replayScore = scoreCall({
      asset_id: sub.asset_id as AssetId,
      horizon_hours: sub.horizon_hours as HorizonHours,
      confidence: sub.confidence,
      signed_return: r,
      outcome: replayOutcome,
      ...(sub.horizon_seconds !== undefined
        ? { horizon_seconds: sub.horizon_seconds }
        : {}),
    });

    const same =
      replayOutcome === target.outcome &&
      String(input.replay.t1_replay.p1) === String(target.p1);
    if (same && !input.accept_unchanged) {
      disputesRepo.setStatus(this.db, dispute.dispute_id, "rejected", nowIso(now), null);
      return {
        dispute_id: dispute.dispute_id,
        status: "rejected",
        new_resolution_receipt_hash: null,
      };
    }

    const resolved_at = nowIso(now);
    // Pillar-4 wallet binding for replayed resolution receipts. The
    // disputed agent may have rotated wallets in between original and
    // replay — use whatever wallet the agent has NOW since this
    // receipt is the new source of truth post-dispute.
    const issuingAgent = agentsRepo.byId(this.db, sub.agent_id);
    const payload = ResolutionReceiptPayloadSchema.parse({
      schema_version: SCHEMA_VERSION,
      scoring_version: SCORING_VERSION,
      call_id: target.call_id,
      acceptance_receipt_hash: acceptanceHash,
      t0: t0_iso,
      p0,
      t0_feed,
      t1: input.replay.t1_replay.t1,
      p1: input.replay.t1_replay.p1,
      t1_feed,
      signed_return: r.toFixed(8),
      outcome: replayOutcome,
      call_score: replayScore.call_score,
      resolved_at,
      ...(issuingAgent?.wallet_address ? { agent_wallet: issuingAgent.wallet_address } : {}),
      ...(issuingAgent?.chain_id ? { chain_id: issuingAgent.chain_id } : {}),
    });
    const receipt = buildResolutionReceipt(payload);

    let cid: string | null = null;
    if (input.pinReceipt) {
      try {
        cid = (await input.pinReceipt(receipt.canonical_json)) ?? null;
      } catch {
        cid = null;
      }
    }

    const tx = this.db.transaction(() => {
      // Update primary resolution to the corrected values.
      resolutionsRepo.setResolution(this.db, {
        call_id: target.call_id,
        t1: input.replay.t1_replay.t1,
        p1: input.replay.t1_replay.p1,
        t1_feed,
        signed_return: r.toFixed(8),
        outcome: replayOutcome,
        call_score: replayScore.call_score,
        resolved_at,
      });
      // Persist a chained re_resolution receipt referencing the OLD resolution
      // receipt as previous_hash for full audit trail.
      resolutionsRepo.recordResolutionReceipt(this.db, {
        receipt_hash: receipt.receipt_hash,
        call_id: target.call_id,
        canonical_json: receipt.canonical_json,
        ...(cid !== null ? { filecoin_cid: cid } : {}),
        previous_hash: dispute.target_resolution_receipt_hash as `0x${string}`,
        created_at: resolved_at,
        kind: "re_resolution",
      });
      submissionsRepo.setStatus(this.db, target.call_id, "re_resolved");
      disputesRepo.setStatus(
        this.db,
        dispute.dispute_id,
        "upheld",
        resolved_at,
        receipt.receipt_hash,
      );
      usageRepo.emit(this.db, {
        event_id: randomUUID(),
        agent_id: target.agent_id,
        kind: "dispute_resolved",
        ts: resolved_at,
        attributes: {
          dispute_id: dispute.dispute_id,
          status: "upheld",
          new_outcome: replayOutcome,
          new_resolution_receipt_hash: receipt.receipt_hash,
          previous_resolution_receipt_hash: dispute.target_resolution_receipt_hash,
        },
      });
    });
    tx();

    return {
      dispute_id: dispute.dispute_id,
      status: "upheld",
      new_resolution_receipt_hash: receipt.receipt_hash,
    };
  }

  // ── helpers ──

  private findResolutionByReceiptHash(
    receipt_hash: `0x${string}`,
  ): {
    call_id: string;
    agent_id: string;
    outcome: Outcome;
    p1: string;
  } | null {
    const row = this.db
      .prepare(
        `SELECT r.call_id, s.agent_id, t.outcome, t.p1
         FROM receipts r
         JOIN submissions s ON s.call_id = r.call_id
         JOIN t1_resolutions t ON t.call_id = r.call_id
         WHERE r.receipt_hash = ? AND r.kind IN ('resolution','re_resolution')
         ORDER BY r.created_at DESC
         LIMIT 1`,
      )
      .get(receipt_hash) as
      | { call_id: string; agent_id: string; outcome: Outcome; p1: string }
      | undefined;
    return row ?? null;
  }

  private loadAcceptanceHash(call_id: string): `0x${string}` {
    const row = this.db
      .prepare(
        "SELECT receipt_hash FROM receipts WHERE call_id = ? AND kind = 'acceptance'",
      )
      .get(call_id) as { receipt_hash: string } | undefined;
    if (!row) {
      throw new VerdictError(
        "no acceptance receipt for call",
        ERROR_CODES.internal_error,
        500,
      );
    }
    return row.receipt_hash as `0x${string}`;
  }

  private loadDispute(dispute_id: string): Dispute {
    const row = this.db
      .prepare("SELECT * FROM disputes WHERE dispute_id = ?")
      .get(dispute_id) as Dispute | undefined;
    if (!row) {
      throw new VerdictError("dispute not found", ERROR_CODES.unknown_agent, 404);
    }
    return row;
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function nowIso(d: Date): string {
  return d.toISOString().replace(/\.\d+Z$/, "Z");
}
