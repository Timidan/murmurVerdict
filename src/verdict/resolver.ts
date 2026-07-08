import type Database from "better-sqlite3";
import {
  HORIZONS_HOURS,
  Outcome,
  T0Policy,
} from "./schema.js";
import { marketsRepo } from "./repos/market-registry-repo.js";
import { anchorsRepo } from "./repos/resolution-repo.js";
import { submissionsRepo } from "./repos/sealed-call-submissions-repo.js";
import {
  OracleClient,
} from "../integrations/oracle.js";
import { derivePolicyFromMarket } from "./oracle-routing.js";
import { tryAnchorOracleFeed } from "./resolver-oracle-anchor.js";
import {
  markOracleUnavailable,
  resolveRevealedAdapter,
  resolveRevealedNativePrice,
} from "./resolution-lifecycle.js";

// ─── Public types ────────────────────────────────────────────────────────────

export interface ResolverDeps {
  db: Database.Database;
  oracle: OracleClient;
  now: () => Date;
  /** Test hook so we can drive logs assertively; default no-op. */
  log?: (line: ResolverLogEvent) => void;
  /** Called for every call that becomes terminal (resolved, oracle_unavailable). */
  onResolved?: (call_id: string) => void | Promise<void>;
}

export type ResolverLogEvent =
  | { kind: "anchored_t0"; call_id: string; feed: T0Policy["primary_feed"]; p0: string }
  | { kind: "anchored_t1"; call_id: string; feed: T0Policy["primary_feed"]; p1: string; outcome: Outcome }
  | { kind: "adapter_resolved"; call_id: string; adapter: string; outcome: Outcome; call_score: number | null }
  | { kind: "oracle_unavailable"; call_id: string; phase: "t0" | "t1" }
  | { kind: "still_pending"; call_id: string; phase: "t0" | "t1"; reason: string }
  | { kind: "tick_summary"; anchored: number; resolved: number; oracle_unavailable: number };

export interface ResolverTickResult {
  anchored: number;
  resolved: number;
  oracle_unavailable: number;
}

// ─── Resolver ────────────────────────────────────────────────────────────────

export class Resolver {
  private readonly db: Database.Database;
  private readonly oracle: OracleClient;
  private readonly now: () => Date;
  private readonly log: (line: ResolverLogEvent) => void;
  private readonly onResolved: NonNullable<ResolverDeps["onResolved"]>;
  constructor(deps: ResolverDeps) {
    this.db = deps.db;
    this.oracle = deps.oracle;
    this.now = deps.now;
    this.log = deps.log ?? (() => undefined);
    this.onResolved = deps.onResolved ?? (() => undefined);
  }

  async tick(): Promise<ResolverTickResult> {
    const t0 = await this.runT0Phase();
    const t1 = await this.runT1Phase();
    const summary = {
      anchored: t0.anchored,
      resolved: t1.resolved,
      oracle_unavailable: t0.oracle_unavailable + t1.oracle_unavailable,
    };
    this.log({ kind: "tick_summary", ...summary });
    return summary;
  }

  // ── t0 anchoring ──

  private async runT0Phase(): Promise<{
    anchored: number;
    oracle_unavailable: number;
  }> {
    const candidates = [
      ...submissionsRepo.listPending(this.db, "accepted"),
      ...submissionsRepo.listPending(this.db, "pending_t0"),
    ];
    let anchored = 0;
    let oracleUnavailable = 0;
    for (const c of candidates) {
      const ctx = submissionsRepo.loadResolverContext(this.db, c.call_id);
      if (!ctx) continue;
      // Wave 3b BLOCKER fix — policyFromCtx now walks the markets registry
      // on every tick. A retired/deleted market or a half-configured
      // policy would previously throw out of the per-call loop and crash
      // the entire pass. Bound the throw to this call: log + route to
      // oracle_unavailable so the rest of the tick keeps making progress.
      let policy: T0Policy | null;
      try {
        policy = this.policyFromCtx(ctx);
      } catch (err) {
        this.log({
          kind: "still_pending",
          call_id: ctx.call_id,
          phase: "t0",
          reason: `policy_derivation_failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
        if (await markOracleUnavailable({
          db: this.db,
          ctx,
          phase: "t0",
          now: this.now,
          log: this.log,
        })) {
          oracleUnavailable++;
        }
        continue;
      }
      // Wave 4a — adapter-resolved markets (Polymarket Gamma + future
      // event-feed adapters) return null policy. They don't anchor
      // against a price feed at t0; the t1 path's adapter.observeResolution
      // dispatch is the only resolution surface. Skip the t0 anchor step
      // and move the call straight into pending_t1 so the t1 loop picks it
      // up next tick.
      if (policy === null) {
        if (ctx.status === "accepted" || ctx.status === "pending_t0") {
          submissionsRepo.setStatus(this.db, ctx.call_id, "pending_t1");
        }
        this.log({
          kind: "still_pending",
          call_id: ctx.call_id,
          phase: "t0",
          reason: "adapter_resolved_market:no_t0_anchor",
        });
        continue;
      }
      const outcome = await tryAnchorOracleFeed({
        db: this.db,
        oracle: this.oracle,
        mustBeAfterIso: ctx.accepted_at,
        elapsedSec: this.elapsedSecSince(ctx.accepted_at),
        policy,
      });
      if (outcome.kind === "anchored") {
        // T0 anchor + status change must commit atomically: a crash between
        // the two leaves submissions stuck in pending_t0 with the anchor row
        // already written, breaking the resolver's two-phase invariant.
        const t0AnchorTx = this.db.transaction(() => {
          anchorsRepo.setT0(this.db, {
            call_id: ctx.call_id,
            t0: outcome.observation.feed_timestamp,
            p0: outcome.observation.price,
            feed: outcome.observation.feed,
            source_id: outcome.observation.source_id,
            anchored_at: this.nowIso(),
          });
          submissionsRepo.setStatus(this.db, ctx.call_id, "pending_t1");
        });
        t0AnchorTx();
        anchored++;
        this.log({
          kind: "anchored_t0",
          call_id: ctx.call_id,
          feed: outcome.observation.feed,
          p0: outcome.observation.price,
        });
      } else if (outcome.kind === "oracle_unavailable") {
        if (await markOracleUnavailable({
          db: this.db,
          ctx,
          phase: "t0",
          now: this.now,
          log: this.log,
        })) {
          oracleUnavailable++;
        }
      } else {
        if (ctx.status === "accepted") {
          submissionsRepo.setStatus(this.db, ctx.call_id, "pending_t0");
        }
        this.log({
          kind: "still_pending",
          call_id: ctx.call_id,
          phase: "t0",
          reason: outcome.reason,
        });
      }
    }
    return { anchored, oracle_unavailable: oracleUnavailable };
  }

  // ── t1 resolution ──

  private async runT1Phase(): Promise<{
    resolved: number;
    oracle_unavailable: number;
  }> {
    const candidates = submissionsRepo.listPending(this.db, "pending_t1");
    let resolved = 0;
    let oracleUnavailable = 0;
    for (const c of candidates) {
      const ctx = submissionsRepo.loadResolverContext(this.db, c.call_id);
      if (!ctx) continue;

      const t0row = anchorsRepo.getT0(this.db, ctx.call_id);
      let policy: T0Policy | null;
      try {
        policy = this.policyFromCtx(ctx);
      } catch (err) {
        this.log({
          kind: "still_pending",
          call_id: ctx.call_id,
          phase: "t1",
          reason: `policy_derivation_failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
        if (await markOracleUnavailable({
          db: this.db,
          ctx,
          phase: "t1",
          now: this.now,
          log: this.log,
        })) {
          oracleUnavailable++;
        }
        continue;
      }

      if (policy === null) {
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
        continue;
      }

      if (!t0row) continue;

      // Phase 2c: prefer the canonical horizon_seconds (no precision loss
      // for sub-hour markets). horizon_hours is retained as a back-compat
      // surface but the t1 anchor uses seconds directly.
      const t1Iso = isoFromUnixMs(
        Date.parse(t0row.t0) + ctx.horizon_seconds * 1000,
      );
      const elapsedSinceT1 = this.elapsedSecSince(t1Iso);
      if (elapsedSinceT1 < 0) continue; // not yet

      const outcome = await tryAnchorOracleFeed({
        db: this.db,
        oracle: this.oracle,
        mustBeAfterIso: t1Iso,
        elapsedSec: elapsedSinceT1,
        policy,
      });

      if (outcome.kind === "anchored") {
        const obs = outcome.observation;

        if (ctx.privacy_mode === "sealed_fhenix") {
          if (ctx.commitment_json === null) {
            this.log({
              kind: "still_pending",
              call_id: ctx.call_id,
              phase: "t1",
              reason: "sealed_fhenix:awaiting_public_reveal",
            });
            continue;
          }
          const revealedResult = await resolveRevealedNativePrice({
            db: this.db,
            ctx,
            t0row,
            obs,
            now: this.now,
            log: this.log,
          });
          if (revealedResult.kind === "resolved") {
            resolved++;
            this.log({
              kind: "anchored_t1",
              call_id: ctx.call_id,
              feed: obs.feed,
              p1: obs.price,
              outcome: revealedResult.outcome,
            });
            try {
              await this.onResolved(ctx.call_id);
            } catch {
              // terminal state already persisted
            }
          } else if (revealedResult.kind === "oracle_unavailable") {
            oracleUnavailable++;
            try {
              await this.onResolved(ctx.call_id);
            } catch {
              // terminal state already persisted
            }
          }
          continue;
        }

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
            // swallow — terminal state already persisted
          }
        }
      } else if (outcome.kind === "oracle_unavailable") {
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
            // swallow — terminal state already persisted
          }
        }
      } else {
        this.log({
          kind: "still_pending",
          call_id: ctx.call_id,
          phase: "t1",
          reason: outcome.reason,
        });
      }
    }
    return { resolved, oracle_unavailable: oracleUnavailable };
  }

  // ── helpers ──

  private elapsedSecSince(iso: string): number {
    return (this.now().getTime() - Date.parse(iso)) / 1000;
  }

  private nowIso(): string {
    return this.now().toISOString().replace(/\.\d+Z$/, "Z");
  }

  /**
   * Wave 3 — the oracle_policies table is gone (MIGRATION_031). The
   * resolver re-derives a call's T0Policy from its market_id on every
   * read by walking the markets registry via derivePolicyFromMarket().
   *
   * Wave 4a — derivePolicyFromMarket can return null for adapter-resolved
   * markets (Polymarket Gamma + future event-feed adapters). The T0/T1
   * anchoring loops short-circuit on null: those markets resolve via
   * adapter.observeResolution(...) on every tick rather than anchoring
   * against a price feed at t0+horizon.
   *
   * The trade-off vs the old per-call snapshot:
   *   - A market frozen between submit and the resolver tick swaps the
   *     policy under us. With receipts/disputes gone (Wave 1/3a) there
   *     is no off-chain attestation pinned to the original policy.
   *   - The markets registry is still the source of truth for
   *     "which feeds anchor this market today"; a v0.3 dispute path
   *     that needs snapshotted policies would re-introduce a typed
   *     per-call audit log rather than the SQL join.
   */
  private policyFromCtx(
    ctx: NonNullable<ReturnType<typeof submissionsRepo.loadResolverContext>>,
  ): T0Policy | null {
    if (!ctx.market_id) {
      throw new Error(
        `call ${ctx.call_id} has no market_id; cannot derive oracle policy`,
      );
    }
    const market = marketsRepo.get(this.db, ctx.market_id);
    if (!market) {
      throw new Error(
        `call ${ctx.call_id} references unknown market_id ${ctx.market_id}`,
      );
    }
    return derivePolicyFromMarket(this.db, market);
  }

}

function isoFromUnixMs(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");
}

export { feedToOracleId } from "./oracle-routing.js";
export { adapterToLegacyObservation } from "./resolver-oracle-anchor.js";

// Keep import surface stable for test harness.
export const _exposed = { HORIZONS_HOURS };
