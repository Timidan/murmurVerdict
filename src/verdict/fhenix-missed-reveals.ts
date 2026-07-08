import type Database from "better-sqlite3";

import { fhenixSealedCallsRepo } from "./repos/fhenix-sealed-calls-repo.js";
import { submissionsRepo } from "./repos/sealed-call-submissions-repo.js";
import { usageRepo } from "./repos/usage-events-repo.js";
import { makeRevealUsage } from "./fhenix-reveal-ingestion-shared.js";

export function markMissedFhenixReveals(input: {
  db: Database.Database;
  cutoffIso: string;
  terminalAt: string;
  now: () => Date;
}): number {
  const rows = fhenixSealedCallsRepo.listMissable(input.db, input.cutoffIso);
  let marked = 0;
  for (const row of rows) {
    const changed = input.db.transaction(() => {
      const ok = fhenixSealedCallsRepo.markMissedReveal(input.db, {
        call_id: row.call_id,
        terminal_at: input.terminalAt,
        invalid_reason: "reveal_timeout",
      });
      if (!ok) return false;
      submissionsRepo.setStatus(input.db, row.call_id, "missed_reveal");
      usageRepo.emit(
        input.db,
        makeRevealUsage(row.agent_id, "resolution_completed", {
          call_id: row.call_id,
          outcome: "missed_reveal",
        }, input.now),
      );
      return true;
    })();
    if (changed) marked++;
  }
  return marked;
}
