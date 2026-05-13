import { createHash, randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import {
  canonicalResolvedOutcomeBytes,
  canonicalTranscriptBytes,
  FheNotImplementedError,
  type FheActiveKey,
  type FheCircuit,
  type FheDecryptScoreArgs,
  type FheDecryptScoreResult,
  type FheEncryptPredictedArgs,
  type FheEncryptPredictedResult,
  type FheProvider,
  type FheScoreEncryptedArgs,
  type FheScoreEncryptedResult,
  type FheThresholdMode,
} from "./provider.js";

/**
 * MockFheProvider — deterministic, in-process, NOT cryptographically
 * private. Used for offline CI smoke tests and the `docker compose up`
 * dev loop. Z5's `/v1/readyz` MUST refuse to mark this provider as
 * production-ready when MURMUR_PROD_REQUIRE_OPERATOR_BLIND=1.
 *
 * Wire format
 * -----------
 * "Encrypted" bytes are a UTF-8 JSON document:
 *
 *   { "v": 1, "kind": "predicted",
 *     "numerators": ["1", "0"], "denominator": "1" }
 *
 *   { "v": 1, "kind": "score", "score_x1e9": 500000000 }
 *
 * bigints serialize as decimal strings. The `kind` discriminator
 * prevents accidentally feeding a predicted-vector blob into
 * `decryptScore` (a real provider would reject this via ciphertext
 * type tags; the mock matches the contract).
 *
 * Scoring math mirrors `markets-core.halfL1Distance`: the predicted
 * vector is taken as-is with its denominator, the resolved vector is
 * taken with its own denominator, and we cross-rescale before
 * subtracting so different bases compare correctly:
 *
 *   call_score = 1 − halfL1Distance(predicted, resolved)
 *
 * The mock keeps a single hardcoded `mock-active-keyset` row in the
 * DB on first `getActivePublicKey()` call so /v1/meta has something
 * to surface and Z1 has a valid FK target for new submissions.
 */
export interface MockFheProviderOptions {
  /** DB handle for materializing the mock keyset row + circuits. */
  readonly db: Database.Database;
  /** Vector lengths this mock supports. Defaults to [2, 32]. */
  readonly supportedVectorLens?: readonly number[];
  /** Deterministic key seed override; defaults to a stable string. */
  readonly seed?: string;
}

const MOCK_PUBLIC_KEY_SEED = "murmur-mock-fhe-public-key:v0";
const MOCK_KEYSET_ID_PREFIX = "kset_mock_";

interface PredictedBlob {
  readonly v: 1;
  readonly kind: "predicted";
  readonly numerators: string[];
  readonly denominator: string;
}

interface ScoreBlob {
  readonly v: 1;
  readonly kind: "score";
  /** Score scaled to 1e9 for fixed-point determinism on the wire. */
  readonly score_x1e9: number;
}

export class MockFheProvider implements FheProvider {
  readonly name = "mock" as const;
  /**
   * Z3 — when the daemon opts into `MURMUR_FHE_THRESHOLD_MODE=mock_5of9`
   * AND the mock-provider is the scoring backend, we bump the reported
   * threshold mode to `"mock_quorum"`. Without the env opt-in it stays
   * `"mock"` (no quorum at all — the daemon mock decrypts in-process,
   * legacy Z0/Z1/Z2 posture). Z5's prod gate refuses both.
   */
  readonly threshold_mode: FheThresholdMode;

  private readonly db: Database.Database;
  private readonly supportedLens: readonly number[];
  private readonly seed: string;
  private cachedActive: FheActiveKey | null = null;

  constructor(opts: MockFheProviderOptions) {
    this.db = opts.db;
    this.supportedLens = opts.supportedVectorLens ?? [2, 32];
    this.seed = opts.seed ?? MOCK_PUBLIC_KEY_SEED;
    this.threshold_mode =
      process.env.MURMUR_FHE_THRESHOLD_MODE === "mock_5of9"
        ? "mock_quorum"
        : "mock";
  }

  async getActivePublicKey(): Promise<FheActiveKey> {
    if (this.cachedActive) return this.cachedActive;
    const blob = Buffer.from(this.seed, "utf8");
    const hash = createHash("sha256").update(blob).digest("hex");
    const keyset_id = `${MOCK_KEYSET_ID_PREFIX}${hash.slice(0, 12)}`;
    // Idempotent upsert: the mock provider is stateless across boots,
    // but the keyset row is needed for Z1's FK to land.
    this.db
      .prepare(
        `INSERT INTO fhe_keysets
           (keyset_id, provider, public_key_blob, public_key_hash,
            status, vector_max_len, created_at, activated_at, notes)
         VALUES (@keyset_id, 'mock', @blob, @hash,
                 'active', @vector_max_len, @now, @now,
                 'mock provider — NOT operator-blind; CI/dev only')
         ON CONFLICT(keyset_id) DO UPDATE SET
           status='active',
           activated_at=COALESCE(fhe_keysets.activated_at, excluded.activated_at)`,
      )
      .run({
        keyset_id,
        blob,
        hash,
        vector_max_len: Math.max(...this.supportedLens),
        now: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
      });
    this.cachedActive = {
      keyset_id,
      public_key_hash: hash,
      provider: "mock",
    };
    return this.cachedActive;
  }

  async getCircuit(
    name: FheCircuit["name"],
    vectorLen: number,
  ): Promise<FheCircuit> {
    if (!this.supportedLens.includes(vectorLen)) {
      throw new Error(
        `mock provider: vectorLen=${vectorLen} not in supported set [${this.supportedLens.join(",")}]`,
      );
    }
    if (name === "half_l1_distance_binary" && vectorLen !== 2) {
      throw new Error(
        `mock provider: half_l1_distance_binary requires vectorLen=2, got ${vectorLen}`,
      );
    }
    // Deterministic handle: hash of (name, vectorLen, seed).
    const handle = createHash("sha256")
      .update(`${name}|${vectorLen}|${this.seed}`)
      .digest("hex");
    const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
    this.db
      .prepare(
        `INSERT INTO fhe_circuits
           (circuit_id, name, description, vector_max_len, compiled_at,
            provider, handle)
         VALUES (@circuit_id, @name, @desc, @vlen, @now, 'mock', @handle)
         ON CONFLICT(circuit_id) DO NOTHING`,
      )
      .run({
        circuit_id: `circ_mock_${handle.slice(0, 12)}`,
        name,
        desc:
          name === "half_l1_distance_binary"
            ? "Binary half-L1 distance (mock)"
            : `Length-N half-L1 distance, N<=${vectorLen} (mock)`,
        vlen: vectorLen,
        now,
        handle,
      });
    return {
      circuit_id: `circ_mock_${handle.slice(0, 12)}`,
      name,
      handle,
      vector_max_len: vectorLen,
      provider: "mock",
    };
  }

  async encryptPredicted(
    args: FheEncryptPredictedArgs,
  ): Promise<FheEncryptPredictedResult> {
    if (args.numerators.length > args.circuit.vector_max_len) {
      throw new Error(
        `encryptPredicted: vector len ${args.numerators.length} exceeds circuit max ${args.circuit.vector_max_len}`,
      );
    }
    if (args.keyset.provider !== "mock") {
      throw new Error(
        `encryptPredicted: keyset.provider must be 'mock' for MockFheProvider (got '${args.keyset.provider}')`,
      );
    }
    // Mirror the wire shape `scoreEncrypted` already parses. bigint
    // strings round-trip as-is; we leave them in agent-supplied form so
    // a deterministic test can build the same blob the agent SDK would.
    const blob: PredictedBlob = {
      v: 1,
      kind: "predicted",
      numerators: [...args.numerators],
      denominator: args.denominator,
    };
    const ciphertext = new TextEncoder().encode(JSON.stringify(blob));
    const ciphertext_hash = createHash("sha256").update(ciphertext).digest("hex");
    // 32 random bytes hex — matches the FheBlockSchema's nonce regex.
    const nonce = randomBytes(32).toString("hex");
    return { ciphertext, ciphertext_hash, nonce };
  }

  async scoreEncrypted(
    args: FheScoreEncryptedArgs,
  ): Promise<FheScoreEncryptedResult> {
    if (args.circuit.provider !== "mock") {
      throw new Error(
        `mock provider cannot run circuit compiled by '${args.circuit.provider}'`,
      );
    }
    if (args.resolved_outcome_denominator === 0n) {
      throw new Error("scoreEncrypted: resolved_outcome_denominator must be non-zero");
    }
    const predicted = decodePredicted(args.encrypted_predicted_outcome);
    if (predicted.numerators.length !== args.resolved_outcome_numerators.length) {
      throw new Error(
        `scoreEncrypted: length mismatch (predicted=${predicted.numerators.length}, resolved=${args.resolved_outcome_numerators.length})`,
      );
    }
    if (predicted.numerators.length > args.circuit.vector_max_len) {
      throw new Error(
        `scoreEncrypted: predicted vector length ${predicted.numerators.length} exceeds circuit max ${args.circuit.vector_max_len}`,
      );
    }
    // 1 − halfL1Distance(predicted, resolved). Inlined rather than
    // importing markets-core to keep the mock provider free of
    // resolver-side dependencies (it must be loadable in CI without a
    // full daemon graph).
    const dPred = predicted.denominator;
    const dRes = args.resolved_outcome_denominator;
    let absSum = 0n;
    for (let i = 0; i < predicted.numerators.length; i++) {
      const p = (predicted.numerators[i] ?? 0n) * dRes;
      const r = (args.resolved_outcome_numerators[i] ?? 0n) * dPred;
      const d = p - r;
      absSum += d < 0n ? -d : d;
    }
    const commonDenom = dPred * dRes;
    const halfL1 = Number(absSum) / 2 / Number(commonDenom);
    const score = Math.max(0, Math.min(1, 1 - halfL1));
    const score_x1e9 = Math.round(score * 1_000_000_000);

    const blob: ScoreBlob = {
      v: 1,
      kind: "score",
      score_x1e9,
    };
    const encrypted_score = Buffer.from(JSON.stringify(blob), "utf8");
    // Codex Z2 review fix #7 — canonical transcript bytes per the
    // cross-language spec in provider.ts. Hashes:
    //   { domain, call_id, circuit_id, keyset_id,
    //     score_ciphertext_hash, resolved_outcome_hash, score_range }
    // Both the daemon mock AND the Rust sidecar must produce the same
    // bytes. The previous transcript bound only (circuit_handle,
    // ciphertext_hash, raw outcome) which made cross-side verification
    // impossible and let an attacker splice scores between calls.
    const score_ciphertext_hash = createHash("sha256")
      .update(encrypted_score)
      .digest("hex");
    const resolved_outcome_hash = createHash("sha256")
      .update(
        canonicalResolvedOutcomeBytes(
          args.resolved_outcome_numerators,
          args.resolved_outcome_denominator,
        ),
      )
      .digest("hex");
    const transcript_hash = createHash("sha256")
      .update(
        canonicalTranscriptBytes({
          call_id: args.call_id,
          keyset_id: args.keyset_id,
          circuit_id: args.circuit.circuit_id,
          score_ciphertext_hash,
          resolved_outcome_hash,
          score_range: { min: 0, max: 1 },
        }),
      )
      .digest("hex");
    return { encrypted_score, transcript_hash, score_ciphertext_hash };
  }

  async decryptScore(_args: FheDecryptScoreArgs): Promise<FheDecryptScoreResult> {
    // Codex Z3 review FAIL #1 — single-operator decrypt path is REMOVED,
    // not flagged. Z3's mock-quorum is the only legitimate way to
    // recover the cleartext score (it parses the partial_decrypt bytes
    // inside aggregateShares() in src/verdict/fhe/threshold.ts).
    //
    // Earlier this method decoded the score blob locally, which would
    // have let an operator with daemon access bypass quorum entirely
    // by constructing the encrypted_score from DB state and calling
    // `mockProvider.decryptScore()` directly. The operator-blind
    // invariant requires that single-party decryption be impossible,
    // not just inconvenient. Mirrors the zama-local stub posture.
    throw new FheNotImplementedError("z3", "decryptScore_via_quorum_only");
  }
}

/**
 * Encode a predicted payout vector as a mock-provider ciphertext.
 * Z1 will call this client-side equivalent before submitting; Z0
 * smoke uses it directly to feed `scoreEncrypted`.
 */
export function mockEncodePredicted(
  numerators: bigint[],
  denominator: bigint,
): Uint8Array {
  if (denominator === 0n) {
    throw new Error("mockEncodePredicted: denominator must be non-zero");
  }
  const blob: PredictedBlob = {
    v: 1,
    kind: "predicted",
    numerators: numerators.map((n) => n.toString()),
    denominator: denominator.toString(),
  };
  return Buffer.from(JSON.stringify(blob), "utf8");
}

function decodePredicted(bytes: Uint8Array): {
  numerators: bigint[];
  denominator: bigint;
} {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch (err) {
    throw new Error(
      `mock provider: encrypted_predicted_outcome is not valid JSON (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (
    !raw ||
    typeof raw !== "object" ||
    (raw as PredictedBlob).v !== 1 ||
    (raw as PredictedBlob).kind !== "predicted"
  ) {
    throw new Error(
      "mock provider: blob is not a v1 predicted ciphertext (wrong kind?)",
    );
  }
  const blob = raw as PredictedBlob;
  return {
    numerators: blob.numerators.map((s) => BigInt(s)),
    denominator: BigInt(blob.denominator),
  };
}

function decodeScore(bytes: Uint8Array): ScoreBlob {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch (err) {
    throw new Error(
      `mock provider: encrypted_score is not valid JSON (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (
    !raw ||
    typeof raw !== "object" ||
    (raw as ScoreBlob).v !== 1 ||
    (raw as ScoreBlob).kind !== "score" ||
    typeof (raw as ScoreBlob).score_x1e9 !== "number"
  ) {
    throw new Error(
      "mock provider: blob is not a v1 score ciphertext (wrong kind?)",
    );
  }
  return raw as ScoreBlob;
}

