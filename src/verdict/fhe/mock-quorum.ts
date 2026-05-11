/**
 * Z3 — single-process mock 5-of-9 quorum.
 *
 * Real production needs a Zama KMS threshold MPC ceremony with
 * secret-shared private keys, signed partial decrypts, key rotation,
 * drand-style randomness for non-interactive quorum. Z3 v0 explicitly
 * ships a mock pool that exercises the protocol data flow without real
 * MPC, so the cutover to production is a holder-pool swap behind the
 * `ThresholdHolder` interface.
 *
 * What this file is
 * -----------------
 *   - 9 in-process holders (1 Murmur ops + 3 attesters + 3 agents +
 *     2 partners) generated at daemon boot. Each holder has a fresh
 *     ed25519 key pair held in module memory; the pubkey is persisted
 *     into `fhe_key_holders.public_identity` so the transcript on
 *     /v1/calls/:id/fhe-transcript verifies third-party.
 *   - Each holder verifies the request body against current DB state
 *     before signing. Specifically: it recomputes
 *     sha256(canonicalTranscriptBytes(...)) against the score_job row
 *     and refuses to sign if the daemon's request_hash disagrees. That
 *     's the splice-attack defense (plan §3 "Holders independently
 *     verify... against DB state before signing").
 *   - The signed payload is (request_hash || partial_decrypt). The
 *     mock partial_decrypt is the same mock-provider score blob the
 *     resolver already persisted — aggregation reduces to "all holders
 *     agree on the score blob".
 *
 * What this file is NOT
 * ---------------------
 *   - Not threshold cryptography. The private keys are NOT secret-
 *     shared. Any single mock holder can decrypt the score on its own.
 *     The point of the mock is to exercise the COORDINATION protocol
 *     (request → quorum policy → signed shares → release transcript)
 *     so production swaps the holder implementations without touching
 *     the resolver, the API, or the DB schema.
 *   - Not a key ceremony. There is no DKG, no key rotation, no
 *     emergency key revoke. Those land with the real Zama KMS
 *     integration (plan §3 says "Quarterly key rotation is documented
 *     but NOT implemented in v0" — Z3b follow-up).
 *
 * threshold_mode reporting
 * ------------------------
 * When the mock pool is the active holder pool, the provider's
 * `threshold_mode` is `"mock_quorum"` (distinct from the older `"mock"`
 * for Z0/Z2 mock provider that didn't have a quorum at all, and from
 * `"production"` which is reserved for the real off-process Zama KMS).
 * Z5's prod gate refuses both `"mock"` AND `"mock_quorum"` as non-
 * production threshold modes.
 */
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  sign as edSign,
  type KeyObject,
} from "node:crypto";
import type Database from "better-sqlite3";
import {
  canonicalTranscriptBytes,
  type FheScoreRange,
} from "./provider.js";
import {
  type HolderCategory,
  type HolderRecord,
  type PartialDecryptRequest,
  type PartialDecryptShare,
  type ThresholdHolder,
} from "./threshold.js";
import { upsertKeyHolder } from "./decrypt-requests.js";

interface MockHolderSpec {
  readonly holder_id: string;
  readonly category: HolderCategory;
  readonly display_name: string;
}

/**
 * The fixed 9-seat composition mandated by plan §3. Order is stable
 * across boots so the holder_id stays the same identity — the
 * underlying ed25519 keypair regenerates at boot, but Z3 v0 doesn't
 * persist private keys (real KMS does that). Tests can therefore not
 * use these IDs to roundtrip a sealed ciphertext between two boots —
 * which is fine, mock_quorum is not for that.
 */
const MOCK_HOLDER_SEATS: readonly MockHolderSpec[] = [
  { holder_id: "mock_murmur_ops_1", category: "murmur", display_name: "Murmur Ops (mock)" },
  { holder_id: "mock_attester_1", category: "attester", display_name: "Attester #1 (mock)" },
  { holder_id: "mock_attester_2", category: "attester", display_name: "Attester #2 (mock)" },
  { holder_id: "mock_attester_3", category: "attester", display_name: "Attester #3 (mock)" },
  { holder_id: "mock_agent_1", category: "agent", display_name: "Agent Committee #1 (mock)" },
  { holder_id: "mock_agent_2", category: "agent", display_name: "Agent Committee #2 (mock)" },
  { holder_id: "mock_agent_3", category: "agent", display_name: "Agent Committee #3 (mock)" },
  { holder_id: "mock_partner_1", category: "partner", display_name: "Partner Infra #1 (mock)" },
  { holder_id: "mock_partner_2", category: "partner", display_name: "Partner Infra #2 (mock)" },
];

const DEFAULT_SCORE_RANGE: FheScoreRange = { min: 0, max: 1 };

interface MockHolderState {
  readonly record: HolderRecord;
  readonly privateKey: KeyObject;
}

/**
 * In-process implementation of `ThresholdHolder`. The bound `state`
 * carries the ed25519 keypair and the holder metadata; producing a
 * partial decrypt is a synchronous sign-and-return.
 *
 * The DB pointer is captured at construction so the holder can do
 * the splice-attack defense (verify the score_job row matches the
 * transcript_hash the daemon is asking it to sign).
 */
class MockHolder implements ThresholdHolder {
  constructor(
    private readonly db: Database.Database,
    private readonly state: MockHolderState,
  ) {}

  get record(): HolderRecord {
    return this.state.record;
  }

  async producePartialDecrypt(
    req: PartialDecryptRequest,
  ): Promise<PartialDecryptShare> {
    // Plan §3 hard rule: each holder INDEPENDENTLY verifies the
    // request body matches DB state before signing. We recompute the
    // canonical transcript hash from the score_job row and refuse to
    // sign if it doesn't match. This catches a splice attack where
    // the daemon (or a curious operator) tries to feed a holder a
    // request with a forged transcript_hash that doesn't bind to the
    // actual DB-recorded score.
    const jobRow = this.db
      .prepare(
        `SELECT fsj.score_ciphertext, fsj.score_ciphertext_hash,
                fsj.transcript_hash, fsj.circuit_id,
                fcc.keyset_id
         FROM fhe_score_jobs fsj
         JOIN fhe_call_ciphertexts fcc ON fcc.call_id = fsj.call_id
         WHERE fsj.call_id = ? AND fsj.status = 'scored_pending_decrypt'`,
      )
      .get(req.call_id) as
      | {
          score_ciphertext: Buffer;
          score_ciphertext_hash: string;
          transcript_hash: string;
          circuit_id: string;
          keyset_id: string;
        }
      | undefined;
    if (!jobRow) {
      throw new Error(
        `holder ${this.state.record.holder_id} refuses to sign: no scored_pending_decrypt job for call=${req.call_id}`,
      );
    }
    if (jobRow.score_ciphertext_hash !== req.score_ciphertext_hash) {
      throw new Error(
        `holder ${this.state.record.holder_id} refuses to sign: score_ciphertext_hash mismatch (job=${jobRow.score_ciphertext_hash}, request=${req.score_ciphertext_hash})`,
      );
    }
    if (jobRow.transcript_hash !== req.transcript_hash) {
      throw new Error(
        `holder ${this.state.record.holder_id} refuses to sign: transcript_hash drift (job=${jobRow.transcript_hash}, request=${req.transcript_hash})`,
      );
    }
    if (jobRow.keyset_id !== req.keyset_id) {
      throw new Error(
        `holder ${this.state.record.holder_id} refuses to sign: keyset_id mismatch`,
      );
    }
    // Re-derive the canonical transcript bytes from the score-job
    // row (this is the value the resolver hashed at score-time) and
    // confirm the hash the daemon is asking us to sign matches.
    const recomputed = createHash("sha256")
      .update(
        canonicalTranscriptBytes({
          call_id: req.call_id,
          keyset_id: jobRow.keyset_id,
          circuit_id: jobRow.circuit_id,
          score_ciphertext_hash: jobRow.score_ciphertext_hash,
          resolved_outcome_hash: req.resolved_outcome_hash,
          score_range: DEFAULT_SCORE_RANGE,
        }),
      )
      .digest("hex");
    if (recomputed !== req.transcript_hash) {
      throw new Error(
        `holder ${this.state.record.holder_id} refuses to sign: recomputed transcript_hash=${recomputed} does not match request=${req.transcript_hash}`,
      );
    }

    // The mock partial_decrypt is just the full score ciphertext
    // bytes — see threshold.ts/aggregateShares for why. Real Zama
    // KMS would return a polynomial share here.
    const partial_decrypt = new Uint8Array(jobRow.score_ciphertext);
    const msg = Buffer.concat([
      Buffer.from(req.transcript_hash, "hex"),
      Buffer.from(partial_decrypt),
    ]);
    const sig = edSign(null, msg, this.state.privateKey);
    return {
      holder_id: this.state.record.holder_id,
      category: this.state.record.category,
      partial_decrypt,
      share_signature: sig.toString("hex"),
    };
  }
}

/**
 * Pool of 9 mock holders. Constructed once at daemon boot from
 * `initMockQuorumPool(db)` — keypairs live in module memory for the
 * process lifetime, pubkeys are persisted into fhe_key_holders.
 *
 * The pool is exposed read-only via `holders()` so the quorum
 * coordinator can iterate seats deterministically (helpful for the
 * smoke test: "give me 5 specific seats" without a random walk).
 */
export class MockQuorumPool {
  private readonly seats: ReadonlyArray<MockHolder>;
  private readonly byHolderId: ReadonlyMap<string, MockHolder>;

  private constructor(seats: ReadonlyArray<MockHolder>) {
    this.seats = seats;
    const map = new Map<string, MockHolder>();
    for (const s of seats) map.set(s.record.holder_id, s);
    this.byHolderId = map;
  }

  /**
   * Boot-time entry point. Generates 9 ed25519 keypairs (one per seat),
   * upserts each holder into `fhe_key_holders`, and returns a pool
   * ready to serve quorum requests.
   */
  static init(db: Database.Database, nowIso: string): MockQuorumPool {
    const seats: MockHolder[] = [];
    for (const spec of MOCK_HOLDER_SEATS) {
      const { publicKey, privateKey } = generateKeyPairSync("ed25519");
      // Extract the raw 32-byte ed25519 pubkey from the SPKI DER:
      // the last 32 bytes of a length-44 SPKI ed25519 export.
      const spki = publicKey.export({ type: "spki", format: "der" });
      const raw = spki.subarray(spki.length - 32);
      const publicIdentity = raw.toString("hex");
      upsertKeyHolder({
        db,
        holder_id: spec.holder_id,
        category: spec.category,
        display_name: spec.display_name,
        public_identity: publicIdentity,
        now: nowIso,
      });
      const record: HolderRecord = {
        holder_id: spec.holder_id,
        category: spec.category,
        display_name: spec.display_name,
        public_identity: publicIdentity,
        enabled: true,
      };
      seats.push(new MockHolder(db, { record, privateKey }));
    }
    return new MockQuorumPool(seats);
  }

  holders(): ReadonlyArray<ThresholdHolder> {
    return this.seats;
  }

  getHolderById(id: string): ThresholdHolder | null {
    return this.byHolderId.get(id) ?? null;
  }

  /**
   * Convenience for the resolver: deterministically pick a quorum-
   * valid 5-seat subset (1 partner + 1 partner-or-attester +
   * 2 attesters + 1 agent → satisfies threshold=5, non_agent≥2,
   * non_murmur≥2). Real production would just call every active
   * holder and accept the first ≥threshold valid replies, but the
   * mock pool is in-process so we can be deterministic.
   */
  selectDefaultQuorumSubset(): ReadonlyArray<ThresholdHolder> {
    const pick = (id: string): ThresholdHolder => {
      const h = this.byHolderId.get(id);
      if (!h) throw new Error(`mock-quorum seat missing: ${id}`);
      return h;
    };
    return [
      pick("mock_attester_1"),
      pick("mock_attester_2"),
      pick("mock_partner_1"),
      pick("mock_partner_2"),
      pick("mock_agent_1"),
    ];
  }
}

/**
 * Convenience helper exposed for tests / future routes:  rebuild a
 * KeyObject from the raw ed25519 pubkey hex for verifyShare callers.
 * Kept out of threshold.ts (which already does this inline) so the
 * route handler can pre-warm public-key parsing if perf ever matters.
 */
export function publicKeyFromIdentityHex(hex: string): KeyObject {
  return createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      Buffer.from(hex, "hex"),
    ]),
    format: "der",
    type: "spki",
  });
}
