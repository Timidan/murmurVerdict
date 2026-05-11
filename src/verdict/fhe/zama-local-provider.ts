/**
 * ZamaLocalFheProvider — STUB. Z0 only wires `getActivePublicKey` and
 * `getCircuit`, both reading from `fhe_keysets` / `fhe_circuits`. The
 * `scoreEncrypted` and `decryptScore` entry points throw
 * `FheNotImplementedError("z2", ...)` until Z2 ships the Rust sidecar.
 *
 * Sidecar protocol (planned for Z2)
 * ---------------------------------
 * The real provider speaks to a sidecar over a Unix-domain socket
 * configured via `MURMUR_FHE_SIDECAR_SOCKET` (default
 * `/run/murmur/fhe-sidecar.sock`). Frames are length-prefixed:
 *
 *   ┌────────────┬────────────┬──────────────────────────────┐
 *   │ u32 BE len │ u8 op_code │ <opaque payload of len bytes>│
 *   └────────────┴────────────┴──────────────────────────────┘
 *
 * Op-codes are stable wire numbers. Z2 will add a TS enum + Rust
 * mirror in the sidecar crate:
 *
 *   0x01  GET_ACTIVE_KEY               req: empty                resp: keyset_metadata
 *   0x02  GET_CIRCUIT                  req: {name, vector_len}   resp: circuit_handle
 *   0x10  SCORE_ENCRYPTED              req: {circuit, predicted, resolved_num[], resolved_den}
 *                                      resp: {encrypted_score, transcript_hash}
 *   0x20  DECRYPT_SCORE_REQ            req: {encrypted_score, keyset_id}
 *                                      resp: {score_x1e9}   (only in single-party dev mode)
 *
 *   0xF0  ERROR                        resp: {code, message}
 *
 * Z3 replaces the simple `DECRYPT_SCORE_REQ` round-trip with a
 * quorum-based decrypt flow that posts a request to
 * `fhe_decrypt_requests` and waits for `fhe_decrypt_shares` to reach
 * threshold before returning the score. The sidecar surface stays
 * single-process for the share-combine step.
 *
 * Until that lands, this stub exists so the daemon can boot with
 * MURMUR_FHE_PROVIDER=zama_local without the file system complaining
 * about a missing socket. It seeds `fhe_keysets` with a row tagged
 * `provider='zama_local'` and `status='pending'` so /v1/meta surfaces
 * the wiring without offering encrypted submissions.
 */
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import {
  type FheActiveKey,
  type FheCircuit,
  type FheDecryptScoreArgs,
  type FheDecryptScoreResult,
  FheNotImplementedError,
  type FheProvider,
  type FheScoreEncryptedArgs,
  type FheScoreEncryptedResult,
  FheUnavailableError,
} from "./provider.js";
import {
  bytesToWire,
  sendRequest,
  type SidecarRequest,
  wireToBytes,
} from "./sidecar-client.js";

export interface ZamaLocalFheProviderOptions {
  readonly db: Database.Database;
  /**
   * Pre-shared placeholder public-key blob. Z2 replaces this with a
   * real keygen artifact obtained from the sidecar at boot. For Z0
   * the blob is a constant marker so the keyset_id stays stable
   * across restarts.
   */
  readonly placeholderPublicKey?: Buffer;
  /**
   * Override the sidecar socket path. Default reads
   * `MURMUR_FHE_SIDECAR_SOCKET` or `/var/run/murmur/fhe.sock` (matches
   * the Rust crate's clap default).
   */
  readonly socketPath?: string;
  /** Override the per-request sidecar IPC timeout. Default 30s. */
  readonly sidecarTimeoutMs?: number;
}

const DEFAULT_SIDECAR_SOCKET = "/var/run/murmur/fhe.sock";

const DEFAULT_PLACEHOLDER = Buffer.from(
  "murmur-zama-local-placeholder-public-key:v0",
  "utf8",
);

export class ZamaLocalFheProvider implements FheProvider {
  readonly name = "zama_local" as const;
  /**
   * Codex Z0 review fix — was "production" (intent-based), now "stub" so
   * Z5's prod gate fails CLOSED until the real Rust sidecar + threshold
   * release lands. Previously, enabling `MURMUR_FHE_PROVIDER=zama_local`
   * with a stub that throws on every op would have caused /v1/readyz to
   * report `threshold_mode: "production"`, fooling the prod gate.
   */
  readonly threshold_mode = "stub" as const;

  private readonly db: Database.Database;
  private readonly placeholderBlob: Buffer;
  private readonly socketPath: string;
  private readonly sidecarTimeoutMs: number | undefined;
  private cachedActive: FheActiveKey | null = null;

  constructor(opts: ZamaLocalFheProviderOptions) {
    this.db = opts.db;
    this.placeholderBlob = opts.placeholderPublicKey ?? DEFAULT_PLACEHOLDER;
    this.socketPath =
      opts.socketPath ??
      process.env.MURMUR_FHE_SIDECAR_SOCKET ??
      DEFAULT_SIDECAR_SOCKET;
    this.sidecarTimeoutMs = opts.sidecarTimeoutMs;
  }

  async getActivePublicKey(): Promise<FheActiveKey> {
    if (this.cachedActive) return this.cachedActive;
    const hash = createHash("sha256").update(this.placeholderBlob).digest("hex");
    const keyset_id = `kset_zama_local_${hash.slice(0, 12)}`;
    // Z0 seeds the row in `pending` so /v1/meta accurately reports
    // that the provider is wired but not accepting submissions yet.
    // Z2's bootstrap will flip an instance to `active` only after the
    // sidecar reports a real keygen.
    this.db
      .prepare(
        `INSERT INTO fhe_keysets
           (keyset_id, provider, public_key_blob, public_key_hash,
            status, vector_max_len, created_at, notes)
         VALUES (@keyset_id, 'zama_local', @blob, @hash,
                 'pending', 32, @now,
                 'zama_local stub — Z0 placeholder, sidecar offline')
         ON CONFLICT(keyset_id) DO NOTHING`,
      )
      .run({
        keyset_id,
        blob: this.placeholderBlob,
        hash,
        now: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
      });
    this.cachedActive = {
      keyset_id,
      public_key_hash: hash,
      provider: "zama_local",
    };
    return this.cachedActive;
  }

  async getCircuit(
    name: FheCircuit["name"],
    vectorLen: number,
  ): Promise<FheCircuit> {
    // Z0 surface only — return whatever the DB has. Z2 will dispatch
    // to the sidecar's circuit registry once the IPC is wired.
    const row = this.db
      .prepare(
        `SELECT circuit_id, handle FROM fhe_circuits
         WHERE provider = 'zama_local' AND name = ? AND vector_max_len = ?
         ORDER BY compiled_at DESC LIMIT 1`,
      )
      .get(name, vectorLen) as { circuit_id: string; handle: string } | undefined;
    if (!row) {
      throw new FheNotImplementedError(
        "z2",
        `getCircuit(${name}, ${vectorLen}) — no compiled artifact; Z2 sidecar bootstrap will register one`,
      );
    }
    return {
      circuit_id: row.circuit_id,
      name,
      handle: row.handle,
      vector_max_len: vectorLen,
      provider: "zama_local",
    };
  }

  async scoreEncrypted(
    args: FheScoreEncryptedArgs,
  ): Promise<FheScoreEncryptedResult> {
    if (args.circuit.provider !== "zama_local") {
      throw new Error(
        `zama_local provider cannot run circuit compiled by '${args.circuit.provider}'`,
      );
    }
    if (args.resolved_outcome_denominator === 0n) {
      throw new Error(
        "scoreEncrypted: resolved_outcome_denominator must be non-zero",
      );
    }
    // Look up the sidecar's circuit_id from `fhe_circuits`. The handle
    // returned by getCircuit() is provider-internal; the sidecar
    // wants the circuit_id PK so it can dispatch to its compiled
    // artifact registry.
    const row = this.db
      .prepare(
        `SELECT circuit_id FROM fhe_circuits
         WHERE provider = 'zama_local'
           AND name = ?
           AND vector_max_len = ?
         ORDER BY compiled_at DESC LIMIT 1`,
      )
      .get(args.circuit.name, args.circuit.vector_max_len) as
      | { circuit_id: string }
      | undefined;
    if (!row) {
      throw new FheUnavailableError(
        "scoreEncrypted",
        `no fhe_circuits row for zama_local/${args.circuit.name}/${args.circuit.vector_max_len}`,
      );
    }
    const req: SidecarRequest = {
      op: "score_encrypted",
      call_id: args.call_id,
      keyset_id: args.keyset_id,
      circuit_id: row.circuit_id,
      ciphertext_format: args.ciphertext_format,
      encrypted_predicted_outcome: bytesToWire(args.encrypted_predicted_outcome),
      resolved_outcome_numerators: args.resolved_outcome_numerators.map((n) =>
        n.toString(),
      ),
      resolved_outcome_denominator: args.resolved_outcome_denominator.toString(),
    };
    const resp = await sendRequest(req, {
      socketPath: this.socketPath,
      ...(this.sidecarTimeoutMs !== undefined
        ? { timeoutMs: this.sidecarTimeoutMs }
        : {}),
    });
    if (resp.kind === "error") {
      // The sidecar's `not_implemented_z2_real` stub is what Z2-prep
      // would emit; the Z2 handler change replaces it with real
      // computation. Either way the resolver treats this as transient
      // and retries on the next tick — no plaintext downgrade.
      throw new FheUnavailableError(
        "scoreEncrypted",
        `sidecar error code='${resp.code}' message='${resp.message}'`,
      );
    }
    if (resp.kind !== "score_ciphertext") {
      throw new FheUnavailableError(
        "scoreEncrypted",
        `unexpected sidecar response kind='${resp.kind}'`,
      );
    }
    return {
      encrypted_score: wireToBytes(resp.encrypted_score),
      transcript_hash: resp.transcript_hash,
      score_ciphertext_hash: resp.score_ciphertext_hash,
    };
  }

  async decryptScore(
    _args: FheDecryptScoreArgs,
  ): Promise<FheDecryptScoreResult> {
    // Z3 owns this. The sidecar handler also returns
    // 'requires_threshold_z3' so even a curious caller can't fish a
    // single-party decrypt out of the dev sidecar.
    throw new FheNotImplementedError("z3", "decryptScore");
  }
}
