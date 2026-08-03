import type Database from "better-sqlite3";

import { resolutionsRepo } from "./repos/resolution-repo.js";
import { submissionsRepo } from "./repos/sealed-call-submissions-repo.js";
import { usageRepo } from "./repos/usage-events-repo.js";
import type {
  ResolutionLifecycleLog,
  ResolverContext,
} from "./resolution-lifecycle-types.js";
import { makeResolutionUsage } from "./resolution-usage.js";
import { nowIso } from "./time.js";

/**
 * Terminalize a call Murmur cannot score — the venue adapter is missing,
 * misconfigured, or returned an unscoreable outcome.
 *
 * The persisted outcome string stays `"oracle_unavailable"`. That is a LEGACY
 * PERSISTED VALUE, not a statement about a price oracle: it is the terminal
 * null-score bucket the leaderboard already knows to exclude, and historical
 * rows carry it. Renaming it would require rewriting stored rows, which this
 * removal explicitly does not do.
 *
 * There is only a `t1` phase now — the t0 price-anchoring phase is gone.
 */
export async function markOracleUnavailable(input: {
  db: Database.Database;
  ctx: ResolverContext;
  phase: "t1";
  now: () => Date;
  log: ResolutionLifecycleLog;
}): Promise<boolean> {
  const resolvedAt = nowIso(input.now());
  const tx = input.db.transaction(() => {
    // setResolution returns false when the submission is already in a terminal
    // status (resolved/disputed/etc.) — a concurrent writer beat us to it.
    // Skip the rest of the tx so we don't double-stamp status/usage events.
    const written = resolutionsRepo.setResolution(input.db, {
      call_id: input.ctx.call_id,
      t1: resolvedAt,
      // p1 / t1_feed / signed_return are legacy price-anchor evidence columns
      // (migration 055 made them nullable). Murmur observes no prices, so they
      // are always NULL on any row written from here.
      p1: null,
      t1_feed: null,
      signed_return: null,
      outcome: "oracle_unavailable",
      call_score: null,
      resolved_at: resolvedAt,
    });
    if (!written) return false;
    submissionsRepo.setStatus(input.db, input.ctx.call_id, "resolved");
    usageRepo.emit(
      input.db,
      makeResolutionUsage(input.ctx.agent_id, "resolution_completed", {
        call_id: input.ctx.call_id,
        outcome: "oracle_unavailable",
        phase: input.phase,
      }, input.now),
    );
    return true;
  });
  const written = tx();
  if (!written) return false;
  input.log({
    kind: "oracle_unavailable",
    call_id: input.ctx.call_id,
    phase: input.phase,
  });
  return true;
}
