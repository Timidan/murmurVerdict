import type Database from "better-sqlite3";

import {
  anchorsRepo,
  resolutionsRepo,
} from "./repos/resolution-repo.js";
import { submissionsRepo } from "./repos/sealed-call-submissions-repo.js";
import { usageRepo } from "./repos/usage-events-repo.js";
import type {
  ResolutionLifecycleLog,
  ResolverContext,
} from "./resolution-lifecycle-types.js";
import { makeResolutionUsage } from "./resolution-usage.js";
import { nowIso } from "./time.js";

export async function markOracleUnavailable(input: {
  db: Database.Database;
  ctx: ResolverContext;
  phase: "t0" | "t1";
  now: () => Date;
  log: ResolutionLifecycleLog;
}): Promise<boolean> {
  const resolvedAt = nowIso(input.now());
  const t0row = anchorsRepo.getT0(input.db, input.ctx.call_id);
  const tx = input.db.transaction(() => {
    // setResolution returns false when the submission is already in a terminal
    // status (resolved/disputed/etc.) — a concurrent writer beat us to it.
    // Skip the rest of the tx so we don't double-stamp status/usage events.
    const written = resolutionsRepo.setResolution(input.db, {
      call_id: input.ctx.call_id,
      t1: resolvedAt,
      // No canonical price was observed. Record the genuine t0 anchor feed if
      // this call ever anchored; otherwise NULL — never a fabricated feed
      // (migration 055 dropped the placeholder "chainlink:base:ETH-USD").
      p1: null,
      t1_feed: t0row?.feed ?? null,
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
