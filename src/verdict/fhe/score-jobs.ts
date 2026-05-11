/**
 * Z2 — fhe_score_jobs helpers.
 *
 * The resolver owns the lifecycle of an encrypted-score job; this
 * module just exposes the three transitions it needs. Pure functions,
 * single-statement DB writes, no transactions of their own (the
 * resolver wraps multi-step state changes in its own transaction).
 *
 * Status machine (mirrors MIGRATION_025):
 *
 *   (no row)
 *      │
 *      ▼
 *   queued ─── enqueueScoreJob() called by resolver before sidecar IPC.
 *      │
 *      ▼
 *   running ── set when scoreEncrypted starts (optional in v0; the
 *              30s sidecar budget is short enough that we mostly skip
 *              this state and write directly to the terminal one).
 *      │
 *      ├──▶ scored_pending_decrypt ── recordScoreSuccess(): sidecar
 *      │                              returned encrypted_score +
 *      │                              transcript_hash. Z3 owns the
 *      │                              decrypt → call_score transition.
 *      │
 *      └──▶ failed ─────── recordScoreFailure(): sidecar unavailable
 *                          or returned an error. attempts++, last_error
 *                          stamped. Resolver may transition back to
 *                          'queued' next tick (a retry just re-runs
 *                          enqueueScoreJob — the UPSERT is idempotent
 *                          on call_id).
 *
 * NEVER write the plaintext prediction or the cleartext score here. The
 * row is operator-visible by design — only the score CIPHERTEXT, its
 * hash, and the transcript hash live here. The bounded plaintext score
 * lands on `t1_resolutions.call_score` after Z3 threshold release.
 */
import type Database from "better-sqlite3";

/** Stable status strings; mirrored in MIGRATION_025's CHECK. */
export type FheScoreJobStatus =
  | "queued"
  | "running"
  | "scored_pending_decrypt"
  | "failed";

export interface EnqueueScoreJobArgs {
  readonly db: Database.Database;
  readonly call_id: string;
  readonly provider: string;
  readonly circuit_id: string;
  readonly now: string;
}

/**
 * Upserts an fhe_score_jobs row in status='queued'. Idempotent on
 * call_id — calling twice (e.g. resolver retry) just refreshes the
 * row's created_at without losing the attempts counter, which only
 * recordScoreFailure increments.
 */
export function enqueueScoreJob(args: EnqueueScoreJobArgs): void {
  args.db
    .prepare(
      `INSERT INTO fhe_score_jobs
         (call_id, status, provider, circuit_id, attempts, created_at)
       VALUES (@call_id, 'queued', @provider, @circuit_id, 0, @now)
       ON CONFLICT(call_id) DO UPDATE SET
         status = 'queued',
         provider = excluded.provider,
         circuit_id = excluded.circuit_id`,
    )
    .run({
      call_id: args.call_id,
      provider: args.provider,
      circuit_id: args.circuit_id,
      now: args.now,
    });
}

export interface RecordScoreFailureArgs {
  readonly db: Database.Database;
  readonly call_id: string;
  readonly error: string;
  readonly now: string;
}

/**
 * Bumps attempts, stamps last_error/last_attempt_at, and flips status
 * to 'failed'. The caller (resolver) is responsible for deciding
 * whether to retry — this helper only records the attempt.
 *
 * Pre-condition: the row exists (enqueueScoreJob was called first).
 * If it doesn't, the UPDATE is a no-op and the failure isn't recorded;
 * that's acceptable because it means we never tried to score in the
 * first place.
 */
export function recordScoreFailure(args: RecordScoreFailureArgs): void {
  args.db
    .prepare(
      `UPDATE fhe_score_jobs
       SET status = 'failed',
           attempts = attempts + 1,
           last_attempt_at = @now,
           last_error = @error
       WHERE call_id = @call_id`,
    )
    .run({
      call_id: args.call_id,
      error: args.error,
      now: args.now,
    });
}

export interface RecordScoreSuccessArgs {
  readonly db: Database.Database;
  readonly call_id: string;
  readonly encrypted_score: Uint8Array;
  readonly score_ciphertext_hash: string;
  readonly transcript_hash: string;
  readonly now: string;
}

/**
 * Persists the encrypted-score blob + transcript binding to
 * fhe_score_jobs in status='scored_pending_decrypt'. Z3 reads this row
 * to drive the threshold decrypt request; until Z3 lands, the score
 * stays here.
 *
 * Like recordScoreFailure, this also increments attempts so the
 * operator can see "this call took N tries to score" in
 * /v1/calls/:id-style introspection.
 */
export function recordScoreSuccess(args: RecordScoreSuccessArgs): void {
  args.db
    .prepare(
      `UPDATE fhe_score_jobs
       SET status = 'scored_pending_decrypt',
           attempts = attempts + 1,
           last_attempt_at = @now,
           last_error = NULL,
           score_ciphertext = @score_ciphertext,
           score_ciphertext_hash = @score_ciphertext_hash,
           transcript_hash = @transcript_hash,
           computed_at = @now
       WHERE call_id = @call_id`,
    )
    .run({
      call_id: args.call_id,
      score_ciphertext: Buffer.from(args.encrypted_score),
      score_ciphertext_hash: args.score_ciphertext_hash,
      transcript_hash: args.transcript_hash,
      now: args.now,
    });
}

export interface FheScoreJobRow {
  readonly call_id: string;
  readonly status: FheScoreJobStatus;
  readonly provider: string;
  readonly circuit_id: string;
  readonly score_ciphertext_hash: string | null;
  readonly transcript_hash: string | null;
  readonly attempts: number;
  readonly last_error: string | null;
  readonly computed_at: string | null;
  readonly created_at: string;
}

/**
 * Reads the score-job row for /v1/calls/:id and similar introspection
 * surfaces. The score_ciphertext blob is deliberately NOT returned —
 * only the hash. The blob lives in the DB and is consumed by Z3's
 * decrypt request flow; exposing it through the API would be safe
 * (it's encrypted) but provides no caller-facing value.
 */
export function loadFheScoreJob(
  db: Database.Database,
  call_id: string,
): FheScoreJobRow | null {
  const row = db
    .prepare(
      `SELECT call_id, status, provider, circuit_id,
              score_ciphertext_hash, transcript_hash, attempts,
              last_error, computed_at, created_at
       FROM fhe_score_jobs
       WHERE call_id = ?`,
    )
    .get(call_id) as
    | {
        call_id: string;
        status: FheScoreJobStatus;
        provider: string;
        circuit_id: string;
        score_ciphertext_hash: string | null;
        transcript_hash: string | null;
        attempts: number;
        last_error: string | null;
        computed_at: string | null;
        created_at: string;
      }
    | undefined;
  return row ?? null;
}

/**
 * Returns the encrypted_score blob for Z3 to feed into the threshold
 * decrypt request. Kept on its own helper so the read path is
 * explicit — the blob is bytes, not the rest of the row, and Z3 is
 * the only caller that should be reading it.
 */
export function loadFheScoreCiphertext(
  db: Database.Database,
  call_id: string,
): Buffer | null {
  const row = db
    .prepare(
      "SELECT score_ciphertext FROM fhe_score_jobs WHERE call_id = ?",
    )
    .get(call_id) as { score_ciphertext: Buffer | null } | undefined;
  return row?.score_ciphertext ?? null;
}
