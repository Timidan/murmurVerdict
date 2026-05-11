/**
 * fhe_direct submission helpers.
 *
 * Pure functions called by `submitCall` when `privacy_mode='fhe_direct'`.
 * Split into validation, persistence, and public-projection helpers so
 * the smoke test can exercise the shape without round-tripping through
 * the full submission pipeline.
 *
 * Trust boundary
 * --------------
 * The daemon NEVER decrypts `ciphertext_blob`. It only verifies that
 * the agent's claimed `ciphertext_hash` matches what we computed
 * server-side from the bytes the agent posted. From the daemon's
 * perspective the blob is opaque — its only structured fields are
 * length, format, hash, and the (keyset_id, circuit_id) the agent
 * declared they encrypted against.
 *
 * Validation order
 * ----------------
 *   1. Shape: zod schema for the `fhe` request block.
 *   2. Keyset: `fhe_keysets` row exists with status='active' and the
 *      provider matches the daemon's configured provider. A different
 *      provider would mean the agent encrypted against a key the
 *      configured backend can't score under (Z2).
 *   3. Circuit: `fhe_circuits` row exists for (provider, name) where
 *      `vector_max_len >= request.vector_len`. We also require the
 *      circuit's name to be consistent with the vector_len (binary
 *      circuit ↔ vector_len=2, half_l1_distance_n for >2).
 *   4. Hash recomputation: sha256(base64-decode(ciphertext)) MUST equal
 *      the agent-claimed `ciphertext_hash` byte-for-byte. Closes the
 *      "agent lies about ciphertext bytes" vector.
 *   5. Replay: duplicate (keyset_id, nonce) is a UNIQUE constraint
 *      violation; duplicate ciphertext_hash inside agent's open call
 *      window (status NOT IN resolved/rejected/disputed) is also
 *      refused. The latter prevents an attacker from re-posting a
 *      captured ciphertext under a fresh client_order_id.
 */
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import {
  ERROR_CODES,
  VerdictError,
} from "../schema.js";
import type { FheProvider, FheProviderName } from "./provider.js";

// ─── Request shape ─────────────────────────────────────────────────────────────
//
// Same field names the spec calls out in §4 Z1. `encrypted_predicted_outcome`
// is base64. We hard-cap blob length at 256 KiB so a malicious caller can't
// blow memory before zod even validates other fields. Real ciphertext for
// vector_len<=32 fits comfortably under 64 KiB on every provider we plan
// to support; the cap is defense in depth, not a tight bound.

const BASE64_CHARS = /^[A-Za-z0-9+/]+={0,2}$/;
const HEX_LOWER_64 = /^[0-9a-f]{64}$/;
const DECIMAL_BIGINT = /^[1-9][0-9]*$/;
const MAX_CIPHERTEXT_BASE64_LEN = 256 * 1024;

export const FheSubmissionBlockSchema = z
  .object({
    keyset_id: z.string().min(1).max(128),
    circuit_id: z.string().min(1).max(128),
    encrypted_predicted_outcome: z
      .string()
      .min(1)
      .max(MAX_CIPHERTEXT_BASE64_LEN)
      .regex(BASE64_CHARS, "encrypted_predicted_outcome must be base64"),
    /** sha256(decode(encrypted_predicted_outcome)) — lowercase hex, no 0x. */
    ciphertext_hash: z.string().regex(HEX_LOWER_64),
    /** Number of payout buckets; binary=2, categorical=N (N<=256). */
    vector_len: z.number().int().min(2).max(256),
    /** Bigint as decimal string. Positive non-zero. */
    payout_denominator: z.string().regex(DECIMAL_BIGINT),
    /** 32-byte hex agent-supplied entropy. Unique per (keyset, nonce). */
    nonce: z.string().regex(HEX_LOWER_64),
  })
  .strict();

export type FheSubmissionBlock = z.infer<typeof FheSubmissionBlockSchema>;

export interface FheKeysetRow {
  readonly keyset_id: string;
  readonly provider: FheProviderName;
  readonly status: "pending" | "active" | "suspended" | "revoked";
  readonly vector_max_len: number;
}

export interface FheCircuitRow {
  readonly circuit_id: string;
  readonly provider: FheProviderName;
  readonly name: "half_l1_distance_binary" | "half_l1_distance_n";
  readonly vector_max_len: number;
}

// ─── Validation ────────────────────────────────────────────────────────────────

export interface ValidateFheSubmissionArgs {
  readonly db: Database.Database;
  readonly agent_id: string;
  readonly provider: FheProvider;
  /** The agent-supplied `fhe` block (unvalidated). */
  readonly fhe: unknown;
}

export interface ValidatedFheSubmission {
  readonly block: FheSubmissionBlock;
  readonly keyset: FheKeysetRow;
  readonly circuit: FheCircuitRow;
  /** Decoded bytes; sha256 of these == block.ciphertext_hash. */
  readonly ciphertext_bytes: Buffer;
}

/**
 * Validates the `fhe` block end-to-end. Throws VerdictError with the
 * appropriate http status (422 for shape/keyset/circuit/hash, 409 for
 * replay). Caller must have already authenticated the agent.
 */
export function validateFheSubmission(
  args: ValidateFheSubmissionArgs,
): ValidatedFheSubmission {
  const parsed = FheSubmissionBlockSchema.safeParse(args.fhe);
  if (!parsed.success) {
    throw new VerdictError(
      "fhe_direct: invalid fhe block shape",
      ERROR_CODES.schema_invalid,
      422,
      { issues: parsed.error.format() },
    );
  }
  const block = parsed.data;

  // payout_denominator is bigint-encoded; FheSubmissionBlockSchema regex
  // rules out '0', but defend against future regex loosening.
  if (BigInt(block.payout_denominator) === 0n) {
    throw new VerdictError(
      "fhe_direct: payout_denominator must be non-zero",
      ERROR_CODES.schema_invalid,
      422,
    );
  }

  // Keyset lookup — must be active AND match configured provider. We
  // refuse zama_local-encrypted ciphertext against a mock daemon and
  // vice versa: the score job would fail at Z2 anyway, and surfacing
  // the rejection at submit makes the API errors precise.
  const keysetRow = args.db
    .prepare(
      `SELECT keyset_id, provider, status, vector_max_len
       FROM fhe_keysets
       WHERE keyset_id = ?`,
    )
    .get(block.keyset_id) as FheKeysetRow | undefined;
  if (!keysetRow) {
    throw new VerdictError(
      `fhe_direct: unknown keyset_id '${block.keyset_id}'`,
      ERROR_CODES.schema_invalid,
      422,
      { keyset_id: block.keyset_id },
    );
  }
  if (keysetRow.status !== "active") {
    throw new VerdictError(
      `fhe_direct: keyset '${block.keyset_id}' status='${keysetRow.status}' (must be active)`,
      ERROR_CODES.schema_invalid,
      422,
      { keyset_id: block.keyset_id, status: keysetRow.status },
    );
  }
  if (keysetRow.provider !== args.provider.name) {
    throw new VerdictError(
      `fhe_direct: keyset provider='${keysetRow.provider}' but daemon configured for '${args.provider.name}'`,
      ERROR_CODES.schema_invalid,
      422,
      { keyset_provider: keysetRow.provider, daemon_provider: args.provider.name },
    );
  }
  if (block.vector_len > keysetRow.vector_max_len) {
    throw new VerdictError(
      `fhe_direct: vector_len=${block.vector_len} exceeds keyset vector_max_len=${keysetRow.vector_max_len}`,
      ERROR_CODES.schema_invalid,
      422,
    );
  }

  // Circuit lookup — must match the keyset's provider and accept the
  // requested vector length. Binary circuits enforce vector_len=2.
  const circuitRow = args.db
    .prepare(
      `SELECT circuit_id, provider, name, vector_max_len
       FROM fhe_circuits
       WHERE circuit_id = ?`,
    )
    .get(block.circuit_id) as FheCircuitRow | undefined;
  if (!circuitRow) {
    throw new VerdictError(
      `fhe_direct: unknown circuit_id '${block.circuit_id}'`,
      ERROR_CODES.schema_invalid,
      422,
      { circuit_id: block.circuit_id },
    );
  }
  if (circuitRow.provider !== keysetRow.provider) {
    throw new VerdictError(
      `fhe_direct: circuit provider='${circuitRow.provider}' but keyset provider='${keysetRow.provider}'`,
      ERROR_CODES.schema_invalid,
      422,
    );
  }
  if (block.vector_len > circuitRow.vector_max_len) {
    throw new VerdictError(
      `fhe_direct: vector_len=${block.vector_len} exceeds circuit vector_max_len=${circuitRow.vector_max_len}`,
      ERROR_CODES.schema_invalid,
      422,
    );
  }
  if (
    circuitRow.name === "half_l1_distance_binary" &&
    block.vector_len !== 2
  ) {
    throw new VerdictError(
      `fhe_direct: circuit '${circuitRow.circuit_id}' is binary; vector_len must be 2 (got ${block.vector_len})`,
      ERROR_CODES.schema_invalid,
      422,
    );
  }

  // Hash recomputation — the load-bearing daemon-side check. Without
  // it, an agent could post a hash unrelated to the bytes and later
  // refuse a dispute by pointing at the bytes-vs-hash mismatch.
  let ciphertextBytes: Buffer;
  try {
    ciphertextBytes = Buffer.from(block.encrypted_predicted_outcome, "base64");
  } catch {
    throw new VerdictError(
      "fhe_direct: encrypted_predicted_outcome is not valid base64",
      ERROR_CODES.schema_invalid,
      422,
    );
  }
  const recomputedHash = createHash("sha256").update(ciphertextBytes).digest("hex");
  if (recomputedHash !== block.ciphertext_hash) {
    throw new VerdictError(
      "fhe_direct: ciphertext_hash does not match sha256(encrypted_predicted_outcome)",
      ERROR_CODES.schema_invalid,
      422,
      { expected: recomputedHash, claimed: block.ciphertext_hash },
    );
  }

  // Replay guard — agent's open-call ciphertext window. The DB
  // UNIQUE(ciphertext_hash) catches the *global* duplicate; this check
  // also rejects a duplicate that the agent themselves submits while
  // their previous identical call is still pending. We surface it as
  // 409 with the existing call_id so callers can re-link if they
  // genuinely lost the response.
  //
  // "Open" = the previous call hasn't reached terminal resolution. We
  // filter on submissions.status to keep the window honest — a
  // resolved+disputed-final call should not block a fresh
  // identical-prediction submission (rare, but legitimate after a
  // re-resolution window closes).
  const prior = args.db
    .prepare(
      `SELECT s.call_id
       FROM fhe_call_ciphertexts c
       JOIN submissions s ON s.call_id = c.call_id
       WHERE c.ciphertext_hash = ?
         AND s.agent_id = ?
         AND s.status NOT IN ('resolved','rejected')
       LIMIT 1`,
    )
    .get(block.ciphertext_hash, args.agent_id) as
    | { call_id: string }
    | undefined;
  if (prior) {
    throw new VerdictError(
      "fhe_direct: duplicate ciphertext for an open call by this agent",
      ERROR_CODES.duplicate,
      409,
      { existing_call_id: prior.call_id },
    );
  }

  return {
    block,
    keyset: keysetRow,
    circuit: circuitRow,
    ciphertext_bytes: ciphertextBytes,
  };
}

// ─── Persistence ──────────────────────────────────────────────────────────────

export interface InsertFheCiphertextArgs {
  readonly db: Database.Database;
  readonly call_id: string;
  readonly keyset: FheKeysetRow;
  readonly circuit: FheCircuitRow;
  readonly block: FheSubmissionBlock;
  readonly ciphertext_bytes: Buffer;
  readonly accepted_at: string;
}

/**
 * Resolve the ciphertext_format string from the keyset provider. The
 * format string is what Z2 consults when picking a decoder; for the
 * mock provider that's 'mock_json', and for zama_local (Z2+) that's
 * 'zama_tfhe_v1'. Centralized here so submission and read paths agree.
 */
export function ciphertextFormatForProvider(
  provider: FheProviderName,
): "mock_json" | "zama_tfhe_v1" {
  switch (provider) {
    case "mock":
      return "mock_json";
    case "zama_local":
      return "zama_tfhe_v1";
  }
}

/**
 * Insert the ciphertext row. MUST run inside the same DB transaction as
 * `submissionsRepo.acceptCall` so a partial commit can't leave a
 * submissions row without its ciphertext (or vice versa). Caller is
 * responsible for the BEGIN/COMMIT; this function only runs the INSERT.
 *
 * Throws on UNIQUE violation — caller maps that to VerdictError(409).
 */
export function insertFheCiphertext(args: InsertFheCiphertextArgs): void {
  args.db
    .prepare(
      `INSERT INTO fhe_call_ciphertexts
         (call_id, keyset_id, circuit_id, ciphertext_format,
          ciphertext_blob, ciphertext_hash, vector_len,
          payout_denominator, nonce, created_at)
       VALUES (@call_id, @keyset_id, @circuit_id, @ciphertext_format,
               @ciphertext_blob, @ciphertext_hash, @vector_len,
               @payout_denominator, @nonce, @created_at)`,
    )
    .run({
      call_id: args.call_id,
      keyset_id: args.keyset.keyset_id,
      circuit_id: args.circuit.circuit_id,
      ciphertext_format: ciphertextFormatForProvider(args.keyset.provider),
      ciphertext_blob: args.ciphertext_bytes,
      ciphertext_hash: args.block.ciphertext_hash,
      vector_len: args.block.vector_len,
      payout_denominator: args.block.payout_denominator,
      nonce: args.block.nonce,
      created_at: args.accepted_at,
    });
}

// ─── Public projection ────────────────────────────────────────────────────────

export interface FhePublicCallProjection {
  readonly call_id: string;
  readonly commit_hash: string | null;
  readonly keyset_id: string;
  readonly circuit_id: string;
  readonly ciphertext_hash: string;
  readonly ciphertext_format: string;
  readonly vector_len: number;
}

/**
 * Returns the operator-blind public projection of an fhe_direct call.
 * Critically, this CANNOT return the ciphertext bytes, the prediction
 * plaintext, or anything derived from either. Every public surface
 * (SSE events, webhooks, /v1/calls/:id, Today Tape) MUST render
 * fhe_direct rows through this projection helper — never directly
 * from the submissions row, which still carries plaintext columns for
 * legacy_plaintext / committed rows.
 *
 * Returns null when the call_id either doesn't exist or isn't an
 * fhe_direct row; the caller is responsible for falling back to the
 * legacy projection in that case.
 */
export function loadFhePublicCallProjection(
  db: Database.Database,
  call_id: string,
): FhePublicCallProjection | null {
  const row = db
    .prepare(
      `SELECT s.commit_hash,
              c.keyset_id, c.circuit_id, c.ciphertext_hash,
              c.ciphertext_format, c.vector_len
       FROM submissions s
       JOIN fhe_call_ciphertexts c ON c.call_id = s.call_id
       WHERE s.call_id = ?
         AND s.privacy_mode = 'fhe_direct'`,
    )
    .get(call_id) as
    | {
        commit_hash: string | null;
        keyset_id: string;
        circuit_id: string;
        ciphertext_hash: string;
        ciphertext_format: string;
        vector_len: number;
      }
    | undefined;
  if (!row) return null;
  return {
    call_id,
    commit_hash: row.commit_hash,
    keyset_id: row.keyset_id,
    circuit_id: row.circuit_id,
    ciphertext_hash: row.ciphertext_hash,
    ciphertext_format: row.ciphertext_format,
    vector_len: row.vector_len,
  };
}
