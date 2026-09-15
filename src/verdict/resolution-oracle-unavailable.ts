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
 * Terminalize a call Murmur can't score (adapter missing, misconfigured, or unscoreable outcome).
 * `oracle_unavailable` is a persisted legacy value for the null-score bucket, not a price-oracle claim.
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
    // False when a concurrent writer already terminalized; skip so status/usage aren't double-stamped.
    const written = resolutionsRepo.setResolution(input.db, {
      call_id: input.ctx.call_id,
      t1: resolvedAt,
      // Legacy price-anchor columns; always NULL here.
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
