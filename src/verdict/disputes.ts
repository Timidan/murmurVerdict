import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
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
  Side,
  VerdictError,
} from "./schema.js";
import {
  computeSignedReturn,
  outcomeFromSignedReturn,
  scoreCall,
} from "./scoring.js";
import type { AssetId, HorizonHours } from "./schema.js";

// ─── Public types ────────────────────────────────────────────────────────────

export interface DisputeFileInput {
  /**
   * call_id of the resolution under dispute.
   *
   * Wave 4b: receipts subsystem dropped. Disputes now key on the call_id
   * directly — a call has at most one current resolution, so the lookup is
   * unambiguous.
   */
  target_call_id: string;
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
  now?: () => Date;
}

export interface DisputeResolveResult {
  dispute_id: string;
  status: "upheld" | "rejected";
  /** ISO8601 timestamp of the replacement resolution if upheld; null if rejected. */
  replacement_resolved_at: string | null;
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
    const target = this.findResolutionByCallId(input.target_call_id);
    if (!target) {
      throw new VerdictError(
        "no resolution found for that call_id",
        ERROR_CODES.unknown_agent,
        404,
      );
    }
    const filed_at = nowIso(now);
    const dispute: Dispute = {
      dispute_id: randomUUID(),
      target_call_id: input.target_call_id,
      grounds: input.grounds,
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      filed_by: input.filed_by,
      filed_at,
      status: "open",
      resolved_at: null,
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
        target_call_id: input.target_call_id,
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

    const target = this.findResolutionByCallId(dispute.target_call_id);
    if (!target) {
      disputesRepo.setStatus(this.db, dispute.dispute_id, "rejected", nowIso(now));
      return {
        dispute_id: dispute.dispute_id,
        status: "rejected",
        replacement_resolved_at: null,
      };
    }

    const t0Anchor = anchorsRepo.getT0(this.db, target.call_id);

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

    OracleFeedSchema.parse(t0_feed_raw);
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
      disputesRepo.setStatus(this.db, dispute.dispute_id, "rejected", nowIso(now));
      return {
        dispute_id: dispute.dispute_id,
        status: "rejected",
        replacement_resolved_at: null,
      };
    }

    const resolved_at = nowIso(now);

    const tx = this.db.transaction(() => {
      // Wave 4b: dispute resolve updates the t1_resolutions row in place.
      // The receipts table is gone; setResolution's ON CONFLICT clause
      // overwrites the disputed row with the replay-corrected values.
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
      submissionsRepo.setStatus(this.db, target.call_id, "re_resolved");
      disputesRepo.setStatus(
        this.db,
        dispute.dispute_id,
        "upheld",
        resolved_at,
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
          target_call_id: target.call_id,
          replacement_resolved_at: resolved_at,
        },
      });
    });
    tx();

    return {
      dispute_id: dispute.dispute_id,
      status: "upheld",
      replacement_resolved_at: resolved_at,
    };
  }

  // ── helpers ──

  private findResolutionByCallId(
    call_id: string,
  ): {
    call_id: string;
    agent_id: string;
    outcome: Outcome;
    p1: string;
  } | null {
    const row = this.db
      .prepare(
        `SELECT t.call_id, s.agent_id, t.outcome, t.p1
         FROM t1_resolutions t
         JOIN submissions s ON s.call_id = t.call_id
         WHERE t.call_id = ?`,
      )
      .get(call_id) as
      | { call_id: string; agent_id: string; outcome: Outcome; p1: string }
      | undefined;
    return row ?? null;
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
