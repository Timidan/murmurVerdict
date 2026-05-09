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
// one plaintext column the row is allowed to scrub at this stage is
// still non-null. The UPDATE then NULLs exactly those columns. After a
// successful run, every targeted row fails the predicate on subsequent
// runs. So a second invocation against the same DB state is a
// guaranteed zero-row UPDATE.
//
// Codex review v5 P2 #1 — horizon_hours preservation for pending_t1:
// The daemon's reveal-grace fallback (loadResolutionSubject in
// resolution-subject.ts) computes fallbackAfterMs from
// (accepted_at + horizon_hours*3_600_000 + REVEAL_GRACE_MS) WHENEVER
// call_private_envelopes.fallback_after IS NULL. If we scrub
// horizon_hours on a `committed` row sitting in `pending_t1` whose
// envelope still has fallback_after=NULL, the daemon would later try
// to decrypt at horizon_hours=NULL (parsed as NaN) — collapsing the
// reveal window to "always past" and breaking the privacy guarantee.
// So: keep horizon_hours on rows that need it. side/asset_id/
// confidence/rationale/strategy_tag are still scrubbed for pending_t1.
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

  // Per-row helper: whether horizon_hours is allowed to be scrubbed.
  // Encoded as a correlated subquery so it works in UPDATE WHERE without
  // needing UPDATE-FROM (which would force an INNER join semantics).
  //
  //   - status NOT IN ('accepted','pending_t0','pending_t1')         → scrub OK
  //         (call window closed; daemon never re-needs horizon_hours)
  //   - status='pending_t1' AND envelope.fallback_after IS NOT NULL  → scrub OK
  //         (daemon's fallback timestamp pre-stamped, so it doesn't
  //          recompute from horizon_hours; see resolution-subject.ts)
  //   - status='pending_t1' AND envelope.fallback_after IS NULL      → preserve
  //         (daemon needs horizon_hours to compute fallbackAfterMs;
  //          dropping it would collapse the reveal window to "always
  //          past" — privacy regression)
  //   - committed row with NO envelope row at all → preserve at pending_t1
  //         (fail-safe: matches the "fallback_after IS NULL" branch)
  const horizonScrubbablePredicate = `(
    submissions.status NOT IN ('accepted', 'pending_t0', 'pending_t1')
    OR (
      SELECT e.fallback_after
        FROM call_private_envelopes e
       WHERE e.call_id = submissions.call_id
    ) IS NOT NULL
  )`;

  // Idempotency guard: only touch rows that still have at least one
  // scrubbable plaintext column. horizon_hours counts ONLY when the row
  // is allowed to scrub it on this run (otherwise the predicate would
  // re-flag the row forever, breaking idempotency).
  const anyScrubbableNonNull = `(
    side IS NOT NULL
    OR asset_id IS NOT NULL
    OR confidence IS NOT NULL
    OR rationale IS NOT NULL
    OR strategy_tag IS NOT NULL
    OR (horizon_hours IS NOT NULL AND ${horizonScrubbablePredicate})
  )`;

  const candidatePredicate = `
    privacy_mode = 'committed'
      AND status NOT IN ('accepted', 'pending_t0')
      AND ${anyScrubbableNonNull}
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

  // CASE expression for horizon_hours so the row-keep semantics are
  // expressed inline; other columns scrub unconditionally on candidate
  // rows. Using the same correlated subquery against
  // call_private_envelopes keeps a single source of truth for the
  // fallback_after read.
  const result = db
    .prepare(
      `UPDATE submissions
         SET side = NULL,
             asset_id = NULL,
             horizon_hours = CASE
               WHEN ${horizonScrubbablePredicate} THEN NULL
               ELSE horizon_hours
             END,
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
