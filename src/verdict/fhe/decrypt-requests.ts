/**
 * Z3 — DB write helpers for the threshold-decrypt ceremony.
 *
 * Single-statement, idempotent helpers that wrap the four migration-026
 * tables. Higher-level orchestration (quorum collection, share
 * validation, release commit) lives in `threshold.ts` and the
 * resolver — this file is the persistence boundary only.
 *
 * State machine on `fhe_decrypt_requests.status`:
 *
 *   pending_shares ── enqueueDecryptRequest() called immediately after
 *      │              recordScoreSuccess() lands the encrypted score.
 *      │
 *      ▼
 *   quorum_reached ── markRequestQuorumReached(): coordinator collected
 *      │              ≥ threshold shares; validateQuorum passed; ready
 *      │              for aggregate + release.
 *      │
 *      ▼
 *   released ──── markRequestReleased(): aggregateShares returned the
 *                  bounded score, t1_resolutions.call_score got
 *                  populated, fhe_score_releases recorded the audit
 *                  trail.
 *
 *   expired/frozen: terminal failure states for ops. v0 doesn't write
 *      these automatically (no quorum-timeout daemon yet) — they exist
 *      so the CHECK constraint matches plan §3's lifecycle vocabulary.
 *
 * All helpers stamp `now` via the caller — the resolver passes a single
 * tick-wide nowIso() to keep timestamps consistent across tables.
 */
import type Database from "better-sqlite3";

export type DecryptRequestStatus =
  | "pending_shares"
  | "quorum_reached"
  | "released"
  | "expired"
  | "frozen";

export interface UpsertKeyHolderArgs {
  readonly db: Database.Database;
  readonly holder_id: string;
  readonly category: "murmur" | "attester" | "agent" | "partner";
  readonly display_name: string;
  /** ed25519 public key, lowercase hex (64 chars). */
  readonly public_identity: string;
  readonly now: string;
}

/**
 * Idempotent upsert for the holder registry. The mock-quorum calls
 * this at daemon boot for all 9 mock holders; a real KMS deployment
 * would seed these via an operator script tied to the EAS attestations
 * that prove each holder's public identity.
 *
 * Conflict policy: re-registering the same holder_id refreshes
 * display_name + public_identity + category but does NOT touch
 * `enabled`/`retired_at` — those are governance toggles, not
 * registration-time fields. A retired holder stays retired across
 * boots even if the mock-quorum re-registers them.
 */
export function upsertKeyHolder(args: UpsertKeyHolderArgs): void {
  args.db
    .prepare(
      `INSERT INTO fhe_key_holders
         (holder_id, category, display_name, public_identity, enabled, registered_at)
       VALUES (@holder_id, @category, @display_name, @public_identity, 1, @now)
       ON CONFLICT(holder_id) DO UPDATE SET
         category = excluded.category,
         display_name = excluded.display_name,
         public_identity = excluded.public_identity`,
    )
    .run({
      holder_id: args.holder_id,
      category: args.category,
      display_name: args.display_name,
      public_identity: args.public_identity,
      now: args.now,
    });
}

export interface KeyHolderRow {
  readonly holder_id: string;
  readonly category: "murmur" | "attester" | "agent" | "partner";
  readonly display_name: string;
  readonly public_identity: string;
  readonly enabled: boolean;
  readonly registered_at: string;
  readonly retired_at: string | null;
}

/** Enabled & non-retired holders, sorted for deterministic iteration. */
export function listActiveKeyHolders(
  db: Database.Database,
): KeyHolderRow[] {
  const rows = db
    .prepare(
      `SELECT holder_id, category, display_name, public_identity,
              enabled, registered_at, retired_at
       FROM fhe_key_holders
       WHERE enabled = 1 AND retired_at IS NULL
       ORDER BY category, holder_id`,
    )
    .all() as Array<{
      holder_id: string;
      category: "murmur" | "attester" | "agent" | "partner";
      display_name: string;
      public_identity: string;
      enabled: number;
      registered_at: string;
      retired_at: string | null;
    }>;
  return rows.map((r) => ({
    holder_id: r.holder_id,
    category: r.category,
    display_name: r.display_name,
    public_identity: r.public_identity,
    enabled: r.enabled === 1,
    registered_at: r.registered_at,
    retired_at: r.retired_at,
  }));
}

export interface EnqueueDecryptRequestArgs {
  readonly db: Database.Database;
  readonly request_id: string;
  readonly call_id: string;
  readonly score_ciphertext_hash: string;
  readonly transcript_hash: string;
  readonly resolved_outcome_hash: string;
  readonly keyset_id: string;
  readonly now: string;
  readonly expires_at?: string | null;
}

/**
 * Insert a decrypt request in status='pending_shares'. UNIQUE
 * (call_id, score_ciphertext_hash) makes the call idempotent: a
 * resolver retry that re-runs scoreEncrypted with the same ciphertext
 * hash hits ON CONFLICT and returns the existing request_id.
 *
 * Returns the request_id that wound up persisted — the caller-supplied
 * one on insert, or the pre-existing one on conflict.
 */
export function enqueueDecryptRequest(args: EnqueueDecryptRequestArgs): string {
  args.db
    .prepare(
      `INSERT INTO fhe_decrypt_requests
         (request_id, call_id, score_ciphertext_hash, transcript_hash,
          resolved_outcome_hash, keyset_id, status, created_at, expires_at)
       VALUES (@request_id, @call_id, @score_ciphertext_hash, @transcript_hash,
               @resolved_outcome_hash, @keyset_id, 'pending_shares', @now, @expires_at)
       ON CONFLICT(call_id, score_ciphertext_hash) DO NOTHING`,
    )
    .run({
      request_id: args.request_id,
      call_id: args.call_id,
      score_ciphertext_hash: args.score_ciphertext_hash,
      transcript_hash: args.transcript_hash,
      resolved_outcome_hash: args.resolved_outcome_hash,
      keyset_id: args.keyset_id,
      now: args.now,
      expires_at: args.expires_at ?? null,
    });
  const row = args.db
    .prepare(
      `SELECT request_id FROM fhe_decrypt_requests
       WHERE call_id = ? AND score_ciphertext_hash = ?`,
    )
    .get(args.call_id, args.score_ciphertext_hash) as
    | { request_id: string }
    | undefined;
  if (!row) {
    throw new Error(
      `enqueueDecryptRequest: row missing after insert (call_id=${args.call_id})`,
    );
  }
  return row.request_id;
}

export interface DecryptRequestRow {
  readonly request_id: string;
  readonly call_id: string;
  readonly score_ciphertext_hash: string;
  readonly transcript_hash: string;
  readonly resolved_outcome_hash: string;
  readonly keyset_id: string;
  readonly status: DecryptRequestStatus;
  readonly created_at: string;
  readonly released_at: string | null;
  readonly expires_at: string | null;
}

export function getDecryptRequest(
  db: Database.Database,
  request_id: string,
): DecryptRequestRow | null {
  const row = db
    .prepare(
      `SELECT request_id, call_id, score_ciphertext_hash, transcript_hash,
              resolved_outcome_hash, keyset_id, status, created_at,
              released_at, expires_at
       FROM fhe_decrypt_requests
       WHERE request_id = ?`,
    )
    .get(request_id) as DecryptRequestRow | undefined;
  return row ?? null;
}

export function getDecryptRequestByCallId(
  db: Database.Database,
  call_id: string,
): DecryptRequestRow | null {
  const row = db
    .prepare(
      `SELECT request_id, call_id, score_ciphertext_hash, transcript_hash,
              resolved_outcome_hash, keyset_id, status, created_at,
              released_at, expires_at
       FROM fhe_decrypt_requests
       WHERE call_id = ?
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(call_id) as DecryptRequestRow | undefined;
  return row ?? null;
}

export function listPendingDecryptRequests(
  db: Database.Database,
): DecryptRequestRow[] {
  return db
    .prepare(
      `SELECT request_id, call_id, score_ciphertext_hash, transcript_hash,
              resolved_outcome_hash, keyset_id, status, created_at,
              released_at, expires_at
       FROM fhe_decrypt_requests
       WHERE status = 'pending_shares'
       ORDER BY created_at ASC`,
    )
    .all() as DecryptRequestRow[];
}

export interface PersistShareArgs {
  readonly db: Database.Database;
  readonly share_id: string;
  readonly request_id: string;
  readonly holder_id: string;
  readonly partial_decrypt: Uint8Array;
  readonly share_signature: string;
  readonly now: string;
}

/**
 * Persist a single holder's partial-decrypt share. UNIQUE
 * (request_id, holder_id) deduplicates duplicate submissions —
 * idempotency is the contract here so a webhook-driven holder can
 * resubmit on its own retry policy without flooding the table.
 */
export function persistDecryptShare(args: PersistShareArgs): void {
  args.db
    .prepare(
      `INSERT INTO fhe_decrypt_shares
         (share_id, request_id, holder_id, partial_decrypt,
          share_signature, submitted_at)
       VALUES (@share_id, @request_id, @holder_id, @partial_decrypt,
               @share_signature, @now)
       ON CONFLICT(request_id, holder_id) DO NOTHING`,
    )
    .run({
      share_id: args.share_id,
      request_id: args.request_id,
      holder_id: args.holder_id,
      partial_decrypt: Buffer.from(args.partial_decrypt),
      share_signature: args.share_signature,
      now: args.now,
    });
}

export interface DecryptShareRow {
  readonly share_id: string;
  readonly request_id: string;
  readonly holder_id: string;
  readonly partial_decrypt: Buffer;
  readonly share_signature: string;
  readonly submitted_at: string;
}

export function listSharesForRequest(
  db: Database.Database,
  request_id: string,
): DecryptShareRow[] {
  return db
    .prepare(
      `SELECT share_id, request_id, holder_id, partial_decrypt,
              share_signature, submitted_at
       FROM fhe_decrypt_shares
       WHERE request_id = ?
       ORDER BY submitted_at ASC`,
    )
    .all(request_id) as DecryptShareRow[];
}

export function setRequestStatus(
  db: Database.Database,
  request_id: string,
  status: DecryptRequestStatus,
  now: string,
): void {
  if (status === "released") {
    db.prepare(
      `UPDATE fhe_decrypt_requests
       SET status = 'released', released_at = ?
       WHERE request_id = ?`,
    ).run(now, request_id);
  } else {
    db.prepare(
      `UPDATE fhe_decrypt_requests
       SET status = ?
       WHERE request_id = ?`,
    ).run(status, request_id);
  }
}

export interface PersistReleaseArgs {
  readonly db: Database.Database;
  readonly request_id: string;
  readonly call_id: string;
  readonly released_score: number;
  /** JSON array of {holder_id, public_identity, share_signature}. */
  readonly quorum_signatures: string;
  readonly now: string;
}

export function persistScoreRelease(args: PersistReleaseArgs): void {
  args.db
    .prepare(
      `INSERT INTO fhe_score_releases
         (request_id, call_id, released_score, quorum_signatures, released_at)
       VALUES (@request_id, @call_id, @released_score, @quorum_signatures, @now)
       ON CONFLICT(request_id) DO NOTHING`,
    )
    .run({
      request_id: args.request_id,
      call_id: args.call_id,
      released_score: args.released_score,
      quorum_signatures: args.quorum_signatures,
      now: args.now,
    });
}

export interface ScoreReleaseRow {
  readonly request_id: string;
  readonly call_id: string;
  readonly released_score: number;
  readonly quorum_signatures: string;
  readonly released_at: string;
}

export function getScoreRelease(
  db: Database.Database,
  request_id: string,
): ScoreReleaseRow | null {
  const row = db
    .prepare(
      `SELECT request_id, call_id, released_score, quorum_signatures, released_at
       FROM fhe_score_releases
       WHERE request_id = ?`,
    )
    .get(request_id) as ScoreReleaseRow | undefined;
  return row ?? null;
}
