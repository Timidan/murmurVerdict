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
  type FheEncryptPredictedArgs,
  type FheEncryptPredictedResult,
  FheNotImplementedError,
  type FheProvider,
  type FheScoreEncryptedArgs,
  type FheScoreEncryptedResult,
  type FheThresholdMode,
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
   * Codex Z0 review fix — was "production" (intent-based), then "stub"
   * so Z5's prod gate fails CLOSED until the real Rust sidecar +
   * threshold release lands.
   *
   * Z3 — when `MURMUR_FHE_THRESHOLD_MODE=mock_5of9` is set at boot, the
   * daemon registers the in-process MockQuorumPool and decryptScore
   * routes through that pool (instead of throwing). In that
   * configuration we report `"mock_quorum"` so /v1/readyz exposes the
   * mode AND Z5's prod gate refuses it (real prod requires the off-
   * process Zama KMS pool, which reports `"production"`).
   *
   * Resolution order:
   *   - real production holder pool registered → "production"
   *   - mock_quorum env opt-in                → "mock_quorum"
   *   - otherwise (Z2 + scoring sidecar)      → "stub"
   */
  readonly threshold_mode: FheThresholdMode;

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
    // Threshold mode is environment-driven: Z3 v0 only writes
    // "mock_quorum" (when the operator opts into the single-process
    // pool) or "stub" (Z2 default). "production" never gets set here
    // — that branch lands when a real off-process Zama KMS pool ships.
    this.threshold_mode =
      process.env.MURMUR_FHE_THRESHOLD_MODE === "mock_5of9"
        ? "mock_quorum"
        : "stub";
  }

  async getActivePublicKey(): Promise<FheActiveKey> {
    if (this.cachedActive) return this.cachedActive;
    // Real path: hit the Rust sidecar over UDS for the live keyset.
    // The sidecar generates a TFHE-rs key pair at its own boot and
    // holds the server key in-process; we surface its keyset_id +
    // public_key_hash to the daemon and stamp them into fhe_keysets.
    const sidecarOpts: { socketPath: string; timeoutMs?: number } = {
      socketPath: this.socketPath,
    };
    if (this.sidecarTimeoutMs !== undefined) {
      sidecarOpts.timeoutMs = this.sidecarTimeoutMs;
    }
    const resp = await sendRequest({ op: "get_active_keyset" }, sidecarOpts);
    if (resp.kind === "error") {
      throw new FheUnavailableError("get_active_keyset", resp.message);
    }
    if (resp.kind !== "keyset_info") {
      throw new FheUnavailableError(
        "get_active_keyset",
        `unexpected response kind '${resp.kind}'`,
      );
    }
    // Stamp the row 'active'. Sidecar-provided public_key_blob is
    // intentionally empty (the 180MB server key stays inside the
    // sidecar process) — we persist a deterministic stub here so the
    // FK target still satisfies submissions.commit_hash linkage.
    const blob = this.placeholderBlob;
    this.db
      .prepare(
        `INSERT INTO fhe_keysets
           (keyset_id, provider, public_key_blob, public_key_hash,
            status, vector_max_len, created_at, activated_at, notes)
         VALUES (@keyset_id, 'zama_local', @blob, @hash,
                 'active', 32, @now, @now,
                 'zama_local real — TFHE-rs sidecar keypair')
         ON CONFLICT(keyset_id) DO UPDATE SET
           status='active',
           activated_at=COALESCE(fhe_keysets.activated_at, excluded.activated_at)`,
      )
      .run({
        keyset_id: resp.keyset_id,
        blob,
        hash: resp.public_key_hash,
        now: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
      });
    this.cachedActive = {
      keyset_id: resp.keyset_id,
      public_key_hash: resp.public_key_hash,
      provider: "zama_local",
    };
    return this.cachedActive;
  }

  async getCircuit(
    name: FheCircuit["name"],
    vectorLen: number,
  ): Promise<FheCircuit> {
    // Real path: ask the sidecar; cache the row.
    const sidecarOpts: { socketPath: string; timeoutMs?: number } = {
      socketPath: this.socketPath,
    };
    if (this.sidecarTimeoutMs !== undefined) {
      sidecarOpts.timeoutMs = this.sidecarTimeoutMs;
    }
    const resp = await sendRequest(
      { op: "get_circuit", name, vector_max_len: vectorLen },
      sidecarOpts,
    );
    if (resp.kind === "error") {
      throw new FheUnavailableError("get_circuit", resp.message);
    }
    if (resp.kind !== "circuit_info") {
      throw new FheUnavailableError(
        "get_circuit",
        `unexpected response kind '${resp.kind}'`,
      );
    }
    // Stamp the row so /v1/meta + Z3 release paths can join on it.
    const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
    this.db
      .prepare(
        `INSERT INTO fhe_circuits
           (circuit_id, name, description, vector_max_len, compiled_at,
            provider, handle)
         VALUES (?, ?, ?, ?, ?, 'zama_local', ?)
         ON CONFLICT(circuit_id) DO NOTHING`,
      )
      .run(
        resp.circuit_id,
        resp.name,
        `Real TFHE-rs circuit (name=${resp.name}, vector_max_len=${resp.vector_max_len})`,
        resp.vector_max_len,
        now,
        resp.handle,
      );
    return {
      circuit_id: resp.circuit_id,
      name: resp.name as FheCircuit["name"],
      handle: resp.handle,
      vector_max_len: resp.vector_max_len,
      provider: "zama_local",
    };
  }

  async encryptPredicted(
    args: FheEncryptPredictedArgs,
  ): Promise<FheEncryptPredictedResult> {
    // Real path: TFHE-rs FheUint8 encryption inside the Rust sidecar.
    const sidecarOpts: { socketPath: string; timeoutMs?: number } = {
      socketPath: this.socketPath,
    };
    if (this.sidecarTimeoutMs !== undefined) {
      sidecarOpts.timeoutMs = this.sidecarTimeoutMs;
    }
    const resp = await sendRequest(
      {
        op: "encrypt_predicted",
        keyset_id: args.keyset.keyset_id,
        circuit_id: args.circuit.circuit_id,
        numerators: [...args.numerators],
        denominator: args.denominator,
      } as SidecarRequest,
      sidecarOpts,
    );
    if (resp.kind === "error") {
      throw new FheUnavailableError("encrypt_predicted", resp.message);
    }
    if (resp.kind !== "predicted_ciphertext") {
      throw new FheUnavailableError(
        "encrypt_predicted",
        `unexpected response kind '${resp.kind}'`,
      );
    }
    return {
      ciphertext: wireToBytes(resp.ciphertext),
      ciphertext_hash: resp.ciphertext_hash,
      nonce: resp.nonce,
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
    // Z3 — single-operator decrypt is permanently dead on the
    // operator-blind path. The score is only ever decrypted by the
    // threshold quorum (mock or real Zama KMS), and the resolver
    // drives that flow directly through the quorum coordinator in
    // `routes/fhe-threshold.ts` and `mock-quorum.ts`. The provider's
    // decryptScore entry point exists to keep the FheProvider
    // interface honest about the operation it represents, but no
    // production caller invokes it — including the sidecar, which
    // also returns `decrypt_via_quorum_only`.
    //
    // Surface a stable, distinguishable error so a caller that finds
    // this in a stack trace (a curious operator running a debug
    // script, say) understands it's not a wave-not-implemented
    // placeholder but a deliberate architectural refusal.
    throw new FheNotImplementedError("z3", "decryptScore_via_quorum_only");
  }
}
