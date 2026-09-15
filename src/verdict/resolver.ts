import type Database from "better-sqlite3";
import { Outcome } from "./schema.js";
import { submissionsRepo } from "./repos/sealed-call-submissions-repo.js";
import {
  markOracleUnavailable,
  resolveRevealedAdapter,
} from "./resolution-lifecycle.js";

// ─── Public types ────────────────────────────────────────────────────────────

export interface ResolverDeps {
  db: Database.Database;
  now: () => Date;
  /** Test hook so we can drive logs assertively; default no-op. */
  log?: (line: ResolverLogEvent) => void;
  /** Called for every call that becomes terminal (resolved, oracle_unavailable). */
  onResolved?: (call_id: string) => void | Promise<void>;
}

export type ResolverLogEvent =
  | { kind: "adapter_resolved"; call_id: string; adapter: string; outcome: Outcome; call_score: number | null }
  | { kind: "oracle_unavailable"; call_id: string; phase: "t0" | "t1" }
  | { kind: "still_pending"; call_id: string; phase: "t0" | "t1"; reason: string }
  | { kind: "tick_summary"; drained: number; resolved: number; oracle_unavailable: number };

export interface ResolverTickResult {
  /** Legacy `accepted` / `pending_t0` rows moved into `pending_t1` this tick; normally 0. */
  drained: number;
  resolved: number;
  oracle_unavailable: number;
}

/** Legacy statuses that must still drain to the adapter loop; new calls start at `pending_t1`. */
const DRAINING_STATUSES = ["accepted", "pending_t0"] as const;

// ─── Resolver ────────────────────────────────────────────────────────────────
//
// Every settlement is `adapter.observeResolution(...)` against the market's venue, scored by the
// payout-vector scorer. No oracle dependencies: just a database and a clock.

export class Resolver {
  private readonly db: Database.Database;
  private readonly now: () => Date;
  private readonly log: (line: ResolverLogEvent) => void;
  private readonly onResolved: NonNullable<ResolverDeps["onResolved"]>;
  constructor(deps: ResolverDeps) {
    this.db = deps.db;
    this.now = deps.now;
    this.log = deps.log ?? (() => undefined);
    this.onResolved = deps.onResolved ?? (() => undefined);
  }

  async tick(): Promise<ResolverTickResult> {
    const drained = this.drainLegacyPending();
    const t1 = await this.runAdapterPhase();
    const summary = {
      drained,
      resolved: t1.resolved,
      oracle_unavailable: t1.oracle_unavailable,
    };
    this.log({ kind: "tick_summary", ...summary });
    return summary;
  }

  /** Move legacy rows into `pending_t1` for this tick. CAS on the old statuses so a terminalized call is never resurrected. */
  private drainLegacyPending(): number {
    let drained = 0;
    for (const status of DRAINING_STATUSES) {
      for (const c of submissionsRepo.listPending(this.db, status)) {
        const transitioned = submissionsRepo.transitionStatus(
          this.db,
          c.call_id,
          [...DRAINING_STATUSES],
          "pending_t1",
        );
        if (!transitioned) continue;
        drained++;
        this.log({
          kind: "still_pending",
          call_id: c.call_id,
          phase: "t0",
          reason: `drained_legacy_status:${status}`,
        });
      }
    }
    return drained;
  }

  private async runAdapterPhase(): Promise<{
    resolved: number;
    oracle_unavailable: number;
  }> {
    const candidates = submissionsRepo.listPending(this.db, "pending_t1");
    let resolved = 0;
    let oracleUnavailable = 0;
    for (const c of candidates) {
      const ctx = submissionsRepo.loadResolverContext(this.db, c.call_id);
      if (!ctx) continue;

      // Sealed Fhenix is the only supported privacy mode. Anything else is a
      // row we cannot score; terminalize it rather than loop on it forever.
      if (ctx.privacy_mode !== "sealed_fhenix") {
        this.log({
          kind: "still_pending",
          call_id: ctx.call_id,
          phase: "t1",
          reason: `unsupported_privacy_mode:${ctx.privacy_mode ?? "null"}`,
        });
        if (await markOracleUnavailable({
          db: this.db,
          ctx,
          phase: "t1",
          now: this.now,
          log: this.log,
        })) {
          oracleUnavailable++;
          try {
            await this.onResolved(ctx.call_id);
          } catch {
            // terminal state already persisted
          }
        }
        continue;
      }

      // The venue may already have resolved, but Murmur cannot score a call
      // whose commitment is still sealed. Wait for the public reveal.
      if (ctx.commitment_json === null) {
        this.log({
          kind: "still_pending",
          call_id: ctx.call_id,
          phase: "t1",
          reason: "sealed_fhenix:awaiting_public_reveal",
        });
        continue;
      }

      const adapterResult = await resolveRevealedAdapter({
        db: this.db,
        ctx,
        now: this.now,
        log: this.log,
      });
      if (adapterResult.kind === "resolved") {
        resolved++;
        this.log({
          kind: "adapter_resolved",
          call_id: ctx.call_id,
          adapter: adapterResult.adapter,
          outcome: adapterResult.outcome,
          call_score: adapterResult.call_score,
        });
        try {
          await this.onResolved(ctx.call_id);
        } catch {
          // terminal state already persisted
        }
      } else if (adapterResult.kind === "oracle_unavailable") {
        oracleUnavailable++;
        try {
          await this.onResolved(ctx.call_id);
        } catch {
          // terminal state already persisted
        }
      }
    }
    return { resolved, oracle_unavailable: oracleUnavailable };
  }
}
