// ─── Phase-E plaintext cleanup boot hook (V2 §7.5 / BLOCKER #5) ─────────────
//
// Boot-time idempotent Phase-E cleanup hook. Decoupled from MIGRATION_015
// so an operator can flip MURMUR_PHASE_E_CLEANUP=1 at any time and have
// it take effect on next boot — vs the prior schema-version-gated trap
// where the scrub only ran on the SAME boot that crossed schema 15.
//
// Design:
//   - MIGRATION_015 (schema rebuild) is the structural change: relaxes
//     NOT NULL on the plaintext columns. Permanent + one-shot, gated by
//     schema_version.
//   - This hook is the data change: NULLs the relaxed columns on
//     committed-mode rows past pending_t0. Idempotent — runs every boot
//     when env is set, but only touches rows that still have plaintext.
//
// Idempotency proof: the candidatePredicate matches a row IFF at least
// one plaintext column is non-null. The UPDATE then NULLs all six
// columns. After a successful run, every targeted row fails the
// predicate on subsequent runs. So a second invocation against the
// same DB state is a guaranteed zero-row UPDATE.
//
// Modes:
//   - 'disabled'        — env unset; hook is a no-op.
//   - 'dry-run'         — counts matched rows without writing. Operator
//                         uses this to gauge blast radius.
//   - 'scrubbed'        — wrote to N > 0 rows.
//   - 'idempotent-noop' — env set, no rows match (already scrubbed).

import type Database from "better-sqlite3";

export type PhaseECleanupMode =
  | "disabled"
  | "dry-run"
  | "scrubbed"
  | "idempotent-noop";

export interface PhaseECleanupResult {
  mode: PhaseECleanupMode;
  affected: number;
}

export function runPhaseECleanupIfRequested(
  db: Database.Database,
): PhaseECleanupResult {
  if (process.env.MURMUR_PHASE_E_CLEANUP !== "1") {
    return { mode: "disabled", affected: 0 };
  }
  const dryRun = process.env.MURMUR_PHASE_E_DRY_RUN === "1";

  // Idempotency guard: only touch rows that still have plaintext. The
  // disjunction across all six columns means we match if any plaintext
  // is left after a partial earlier run.
  const candidatePredicate = `
    privacy_mode = 'committed'
      AND status NOT IN ('accepted', 'pending_t0')
      AND (side IS NOT NULL OR asset_id IS NOT NULL OR horizon_hours IS NOT NULL
           OR confidence IS NOT NULL OR rationale IS NOT NULL OR strategy_tag IS NOT NULL)
  `;

  if (dryRun) {
    const row = db
      .prepare(
        `SELECT COUNT(*) as n FROM submissions WHERE ${candidatePredicate}`,
      )
      .get() as { n: number };
    console.log(
      `[phase-e-cleanup] dry-run: would scrub ${row.n} committed-mode rows`,
    );
    return { mode: "dry-run", affected: row.n };
  }

  const result = db
    .prepare(
      `UPDATE submissions
         SET side = NULL,
             asset_id = NULL,
             horizon_hours = NULL,
             confidence = NULL,
             rationale = NULL,
             strategy_tag = NULL
       WHERE ${candidatePredicate}`,
    )
    .run();
  const n = result.changes;
  if (n === 0) {
    console.log("[phase-e-cleanup] idempotent no-op (no plaintext to scrub)");
    return { mode: "idempotent-noop", affected: 0 };
  }
  console.log(`[phase-e-cleanup] scrubbed ${n} committed-mode rows`);
  return { mode: "scrubbed", affected: n };
}
