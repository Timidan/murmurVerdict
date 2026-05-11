/**
 * FHE provider boundary for Murmur Verdict's operator-blind privacy path.
 *
 * Z0 establishes the interface contract; Z1 wires submission, Z2 wires
 * homomorphic scoring, Z3 plumbs the threshold-decrypt ceremony.
 *
 * Why a boundary at all
 * ---------------------
 * `submissions.ts` and `resolver.ts` must never import a vendor SDK
 * directly. Today's choice is Zama TFHE-rs over a local Rust sidecar
 * (see docs/operator-blind-privacy-plan.md §1). If Zama KMS cannot run
 * without a Nitro/AWS dependency in our trust root, we swap the
 * production provider for Fhenix CoFHE behind this same interface, and
 * the DB schema + API shape do not change.
 *
 * Wire model
 * ----------
 * Real production providers ("zama_local", later "zama_kms",
 * "fhenix_cofhe") run the FHE computation in a separate process (a
 * Rust sidecar over a Unix-domain socket; see
 * docker/fhe-sidecar/Dockerfile). Node calls into them via IPC. The
 * `mock` provider runs purely in-process — it does NOT encrypt, and
 * /v1/readyz refuses to mark it production-ready when
 * MURMUR_PROD_REQUIRE_OPERATOR_BLIND=1 (Z5 prod gate).
 *
 * The interface deliberately exposes only:
 *   - `getActivePublicKey()` — the key submissions encrypt against
 *   - `getCircuit(name, vector_len)` — compiled artifact handle
 *   - `scoreEncrypted(...)` — encrypted-prediction × public-outcome →
 *     encrypted-score, with a transcript hash so disputes can replay
 *   - `decryptScore(...)` — bounded-score decrypt only; the committee
 *     never decrypts predicted-outcome vectors
 *
 * Plaintext prediction NEVER crosses this boundary. The daemon must
 * not have a code path that hands the agent's payout-vector to the
 * provider in clear.
 *
 * Concrete `name` values today: `"mock"` | `"zama_local"`. Future
 * additions ("zama_kms", "fhenix_cofhe") extend this union AND add a
 * row to the `fhe_keysets.provider` enum.
 */

/**
 * A compiled FHE circuit. The actual artifact lives inside the
 * provider's process; Node just holds a handle. `name` matches the
 * `fhe_circuits.name` column ('half_l1_distance_binary' for
 * length-2 binary markets, 'half_l1_distance_n' for length-N
 * categorical). `vector_max_len` MUST match what the provider compiled
 * against — submitting a vector longer than `vector_max_len` is a
 * hard reject at Z1.
 */
export interface FheCircuit {
  /** Codex Z2 fix #7 — the row PK from fhe_circuits. Binding the
   *  circuit by ID (not opaque handle) means daemon mock + Rust
   *  sidecar can compute identical transcript hashes. */
  readonly circuit_id: string;
  /** Matches `fhe_circuits.name`. */
  readonly name: "half_l1_distance_binary" | "half_l1_distance_n";
  /** Opaque provider-specific handle (e.g. circuit hash, file path). */
  readonly handle: string;
  /** Max payout-vector length this compiled circuit accepts. */
  readonly vector_max_len: number;
  /** Provider that compiled this artifact. */
  readonly provider: FheProviderName;
}

/**
 * Active public key descriptor. The blob itself is not returned by
 * `getActivePublicKey()`; the agent fetches it via a separate endpoint
 * (Z1 wires that). Here we only return the metadata submissions need
 * to bind: keyset_id (DB FK), public_key_hash (commit-binding), and
 * provider (so the resolver picks the right scoring backend).
 */
export interface FheActiveKey {
  /** Matches `fhe_keysets.keyset_id`. */
  readonly keyset_id: string;
  /** sha256(public_key_blob), hex. Binds the commit preimage. */
  readonly public_key_hash: string;
  /** Provider that holds the secret share / runs the threshold. */
  readonly provider: FheProviderName;
}

export type FheProviderName = "mock" | "zama_local";

// Codex Z0 review fix — added "stub" between "mock" and "production". Z5's
// prod gate (MURMUR_PROD_REQUIRE_OPERATOR_BLIND=1) refuses any non-"production"
// mode, so the Zama Z0 stub must NOT claim "production" while throwing on
// every operation. "stub" makes the gate fail-closed on incomplete providers.
//
// Z3 — added "mock_quorum" for the single-process 5-of-9 mock holder pool
// (see fhe/mock-quorum.ts). The protocol data flow is the same as real
// Zama KMS quorum, but the holders all live in the daemon process so it
// is structurally not a real threshold ceremony. Z5's prod gate must
// refuse both "mock" AND "mock_quorum" — only "production" passes.
export type FheThresholdMode = "mock" | "mock_quorum" | "stub" | "production";

/**
 * Inputs for the homomorphic score computation.
 *
 * `encrypted_predicted_outcome` is opaque ciphertext bytes — the
 * agent encrypted these client-side against the active keyset's
 * public key. The daemon never sees plaintext.
 *
 * `resolved_outcome_numerators` / `resolved_outcome_denominator`
 * encode the public payout vector as a clear fraction array (e.g.
 * `[1n, 0n]` over denominator `1n` for a binary YES win). Provider
 * implementations evaluate `1 - halfL1Distance(predicted, resolved)`
 * on the encrypted side.
 */
export interface FheScoreEncryptedArgs {
  readonly circuit: FheCircuit;
  readonly encrypted_predicted_outcome: Uint8Array;
  readonly resolved_outcome_numerators: bigint[];
  readonly resolved_outcome_denominator: bigint;
  // Codex Z2 review fix #6 — `keyset_id` + `ciphertext_format` are required
  // for real Zama bytes. They're forward-compat for Z2-proper's
  // `zama_tfhe_v1` path; today's mock provider tolerates them as metadata.
  // The transcript hash (FAIL #7 fix below) ALSO binds them, so caller +
  // provider must agree on the values used.
  readonly keyset_id: string;
  readonly ciphertext_format: string;
  // Codex Z2 review fix #7 — `call_id` so the transcript hash can bind
  // the exact call this score is for. Without it, an attacker could
  // splice a score from call A onto call B's resolution.
  readonly call_id: string;
}

export interface FheScoreEncryptedResult {
  /** Encrypted score blob. Decrypts to a bounded value in [0, 1]. */
  readonly encrypted_score: Uint8Array;
  /**
   * Hash of the canonical transcript binding (codex Z2 review fix #7).
   * Both daemon-side providers and the Rust sidecar MUST hash the same
   * canonical bytes, per `canonicalTranscriptBytes()` in this module.
   * Binds: { domain, call_id, keyset_id, circuit_id, score_ciphertext_hash,
   * resolved_outcome_hash, score_range }.
   */
  readonly transcript_hash: string;
  /** sha256 hex of `encrypted_score` bytes — convenience for caller. */
  readonly score_ciphertext_hash: string;
}

/**
 * The bounded range of a decrypted FHE score. v0 is always [0, 1] (the
 * halfL1Distance complement), but Z3+ adapters might emit other ranges
 * (e.g. log-loss scaled to [-1, 0]). Carrying it in the transcript hash
 * means dispute replay can verify the bound the score was computed under.
 */
export interface FheScoreRange {
  readonly min: number;
  readonly max: number;
}

/**
 * Compute the canonical UTF-8 JSON bytes that both the daemon-side mock
 * and the Rust sidecar MUST hash to produce identical transcript hashes
 * (codex Z2 review fix #7). The shape is sorted-key JSON; no whitespace.
 * sha256 over the result is the `transcript_hash` returned by
 * `scoreEncrypted`.
 *
 * The fields are NOT optional. Cross-language byte equality requires:
 *   - exact field order (alphabetical)
 *   - hex hashes lowercase
 *   - numerators/denominators as decimal strings (bigint-safe)
 *   - score_range as `{max,min}` (alphabetical)
 *
 * Any future change to the canonical shape needs a domain bump
 * (TRANSCRIPT_DOMAIN_V1 → V2) so old transcripts don't silently re-verify.
 */
export const TRANSCRIPT_DOMAIN_V1 = "MURMUR_FHE_SCORE_TRANSCRIPT_V1" as const;

export function canonicalTranscriptBytes(input: {
  call_id: string;
  keyset_id: string;
  circuit_id: string;
  score_ciphertext_hash: string;
  resolved_outcome_hash: string;
  score_range: FheScoreRange;
}): Uint8Array {
  // Sorted keys for byte equality across implementations.
  const obj = {
    call_id: input.call_id,
    circuit_id: input.circuit_id,
    domain: TRANSCRIPT_DOMAIN_V1,
    keyset_id: input.keyset_id,
    resolved_outcome_hash: input.resolved_outcome_hash.toLowerCase(),
    score_ciphertext_hash: input.score_ciphertext_hash.toLowerCase(),
    score_range: { max: input.score_range.max, min: input.score_range.min },
  };
  return new TextEncoder().encode(JSON.stringify(obj));
}

/**
 * Hash a canonical resolved outcome to a stable sha256 hex. Both sides
 * must hash this exact shape so the transcript binding survives the
 * Rust ↔ TS boundary.
 */
export function canonicalResolvedOutcomeBytes(
  numerators: readonly bigint[],
  denominator: bigint,
): Uint8Array {
  const obj = {
    denominator: denominator.toString(),
    numerators: numerators.map((n) => n.toString()),
  };
  return new TextEncoder().encode(JSON.stringify(obj));
}

export interface FheDecryptScoreArgs {
  readonly encrypted_score: Uint8Array;
  /** Must match an existing `fhe_keysets.keyset_id`. */
  readonly keyset_id: string;
}

export interface FheDecryptScoreResult {
  /** Bounded score in [0, 1]. */
  readonly score: number;
}

/**
 * The provider boundary. Implementations live under `src/verdict/fhe/`
 * and are constructed once in `src/daemon/index.ts` based on
 * MURMUR_FHE_PROVIDER=mock|zama_local.
 */
export interface FheProvider {
  readonly name: FheProviderName;
  /**
   * `mock` means the provider has NO real threshold ceremony — used
   * for CI/offline smoke. `production` means the active keyset is
   * backed by a real quorum (Zama KMS or equivalent). Z5's
   * MURMUR_PROD_REQUIRE_OPERATOR_BLIND readiness gate refuses to
   * promote `mock` to prod.
   */
  readonly threshold_mode: FheThresholdMode;

  /**
   * Returns the metadata for the keyset currently accepting new
   * submissions. Throws if no keyset is `active`.
   */
  getActivePublicKey(): Promise<FheActiveKey>;

  /**
   * Returns the compiled circuit handle for the given circuit name
   * and required vector length. Implementations may keep a small
   * cache; `name` + `vectorLen` is the cache key. Throws if no
   * circuit is registered for the combination.
   */
  getCircuit(name: FheCircuit["name"], vectorLen: number): Promise<FheCircuit>;

  /**
   * Compute the encrypted score for a single call. Pure with respect
   * to the inputs; calling twice with the same args must yield the
   * same `transcript_hash`.
   *
   * MUST NOT log, persist, or otherwise leak the prediction
   * plaintext. The mock provider relies on this contract too — it
   * keeps the cleartext only inside the function scope.
   */
  scoreEncrypted(args: FheScoreEncryptedArgs): Promise<FheScoreEncryptedResult>;

  /**
   * Decrypts an encrypted score. The committee never decrypts
   * predicted-outcome ciphertexts; this entry point is bounded to
   * the score range by design.
   *
   * In a real provider this either (a) reconstructs from threshold
   * shares supplied out-of-band, or (b) issues a decrypt request to
   * the KMS and awaits quorum (Z3). The mock variant decrypts
   * locally because its "encryption" is the identity transform.
   */
  decryptScore(args: FheDecryptScoreArgs): Promise<FheDecryptScoreResult>;
}

/**
 * Marker error thrown by Z0-stub providers (zama-local) for entry
 * points that legitimately need to wait for later waves. Callers
 * downstream (e.g. submitCall) should special-case this code to
 * return a clear "z1_not_implemented" / "z2_not_implemented" error
 * rather than a 500.
 */
export class FheNotImplementedError extends Error {
  constructor(
    public readonly wave: "z1" | "z2" | "z3",
    public readonly entry: string,
  ) {
    super(`FHE entry '${entry}' is not implemented until ${wave}`);
    this.name = "FheNotImplementedError";
  }
}

/**
 * Z2 — transient sidecar failure. Distinct from FheNotImplementedError
 * (which is "this wave never wired it"). The resolver maps this onto
 * "leave the call pending_t1, retry on next tick, do NOT downgrade to
 * plaintext scoring." Plan §5 cold-start posture: a missing sidecar is
 * not a license to expose the prediction.
 *
 * Carries the underlying socket-level message verbatim so the operator
 * can diagnose without trawling sidecar logs.
 */
export class FheUnavailableError extends Error {
  constructor(
    public readonly entry: string,
    public readonly cause_message: string,
  ) {
    super(`FHE entry '${entry}' unavailable: ${cause_message}`);
    this.name = "FheUnavailableError";
  }
}
