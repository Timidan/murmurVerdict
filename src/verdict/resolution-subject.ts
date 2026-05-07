import type Database from "better-sqlite3";
import {
  agentsRepo,
  callPrivateEnvelopesRepo,
  callRevealsRepo,
  type CallRevealRow,
} from "./db.js";
import type { AgeContext } from "./age-envelope.js";
import { decryptEnvelope } from "./age-envelope.js";
import type { DrandContext } from "./drand-envelope.js";
import { decryptDrandEnvelope } from "./drand-envelope.js";
import {
  buildCommitPreimage,
  computeCommitHash,
  REVEAL_GRACE_MS,
} from "./commit-preimage.js";

/**
 * Resolution subject loader (P2 Phase C-2).
 *
 * The resolver needs the plaintext (side, asset, horizon, confidence)
 * to compute signed_return + outcome + score at horizon expiry. Per
 * privacy_mode the plaintext can come from four places, in priority:
 *
 *   1. AGENT REVEAL  — call_reveals row written by POST /reveal.
 *      The agent published the canonical preimage voluntarily.
 *      Most preferred: the agent owned their reveal moment.
 *   2. DAEMON FALLBACK — past fallback_after, daemon decrypts the
 *      age envelope using its identity. Inserts a call_reveals row
 *      with revealed_via='daemon_fallback' so subsequent reads use
 *      the same plaintext (idempotent, atomic).
 *   3. DRAND FALLBACK — past the drand round, anyone can fetch the
 *      released beacon and tlock-decrypt the ciphertext. Inserts a
 *      call_reveals row with revealed_via='drand_fallback'. Daemon-
 *      LESS path: only the network is trusted.
 *   4. LEGACY PLAINTEXT — pre-P2 (privacy_mode='legacy_plaintext')
 *      rows store plaintext directly in submissions. The loader
 *      hydrates a call_reveals row with revealed_via='legacy_plaintext'
 *      on first access so the rest of the pipeline can treat all
 *      sources uniformly.
 *
 * The loader is idempotent — calling it twice for the same call_id
 * returns the same plaintext (the second call hits an existing
 * call_reveals row). It's also non-throwing for the "not yet
 * revealable" case: returns null so the resolver can skip the call
 * this tick and try again next tick.
 */

export type ResolutionSubjectSource =
  | "agent"
  | "daemon_fallback"
  | "drand_fallback"
  | "legacy_plaintext"
  | "fhevm_compute";

export interface ResolutionSubject {
  call_id: string;
  source: ResolutionSubjectSource;
  side: "BUY" | "SELL";
  asset_id: string;
  horizon_hours: number;
  confidence: number;
  rationale: string | null;
  strategy_tag: string | null;
  /** Wallet bound at submit time. Carries into the v2 resolution receipt. */
  agent_wallet: string | null;
  chain_id: string | null;
  /** keccak256 of the canonical preimage. Verifier checks against
   *  receipt.commit.hash. Null for legacy_plaintext rows since they
   *  predate the commit-reveal contract. */
  commit_preimage_hash: string | null;
  /** Schema tag of the preimage (e.g. murmur-verdict-v0.2-commit@1). */
  commit_preimage_schema: string | null;
  revealed_at: string;
  reveal_hash_valid: boolean;
}

/**
 * Result discriminator: either a usable subject or a defer.
 */
export type SubjectResult =
  | { ok: true; subject: ResolutionSubject }
  | {
      ok: false;
      reason:
        | "not_yet_revealable"
        | "envelope_missing"
        | "decrypt_failed"
        | "hash_mismatch"
        | "call_not_found";
      detail?: string;
    };

export async function loadResolutionSubject(
  db: Database.Database,
  call_id: string,
  opts: {
    ageCtx?: AgeContext;
    drandCtx?: DrandContext;
    now?: () => Date;
  } = {},
): Promise<SubjectResult> {
  const now = (opts.now ?? (() => new Date()))();

  // Read the submission row to learn the privacy mode + commit_hash.
  const subRow = db
    .prepare(
      `SELECT call_id, agent_id, asset_id, side, horizon_hours, confidence,
              rationale, strategy_tag, accepted_at, privacy_mode, commit_hash
       FROM submissions WHERE call_id = ?`,
    )
    .get(call_id) as
    | {
        call_id: string;
        agent_id: string;
        asset_id: string;
        side: "BUY" | "SELL";
        horizon_hours: number;
        confidence: number;
        rationale: string | null;
        strategy_tag: string | null;
        accepted_at: string;
        privacy_mode: string | null;
        commit_hash: string | null;
      }
    | undefined;
  if (!subRow) return { ok: false, reason: "call_not_found" };

  const issuingAgent = agentsRepo.byId(db, subRow.agent_id);
  const agentWallet = issuingAgent?.wallet_address ?? null;
  const chainId = issuingAgent?.chain_id ?? null;

  // (1) call_reveals already exists — fast path, but only if the row still
  // proves the committed preimage. A stale/corrupt row with
  // reveal_hash_valid=0 must not drive scoring.
  const existing = callRevealsRepo.byCallId(db, call_id);
  if (existing) {
    if (
      subRow.privacy_mode === "committed" &&
      !isValidCommittedReveal(existing, subRow.commit_hash)
    ) {
      return {
        ok: false,
        reason: "hash_mismatch",
        detail: "existing call_reveals row does not match commit_hash",
      };
    }
    return { ok: true, subject: rowToSubject(existing) };
  }

  // (4) Legacy plaintext: hydrate call_reveals from submissions row.
  if (subRow.privacy_mode !== "committed") {
    const revealedAt = nowIso(now);
    const row: CallRevealRow = {
      call_id,
      side: subRow.side,
      asset_id: subRow.asset_id,
      horizon_hours: subRow.horizon_hours,
      confidence: subRow.confidence,
      rationale: subRow.rationale,
      strategy_tag: subRow.strategy_tag,
      salt: null,
      t0: null,
      agent_wallet: agentWallet,
      chain_id: chainId,
      commit_preimage_json: null,
      commit_preimage_hash: null,
      revealed_at: revealedAt,
      revealed_via: "legacy_plaintext",
      reveal_hash_valid: 0,
    };
    insertIfAbsent(db, row);
    const final = callRevealsRepo.byCallId(db, call_id);
    return {
      ok: true,
      subject: final ? rowToSubject(final) : rowToSubject(row),
    };
  }

  // Committed-mode path. Need the envelope row.
  const envRow = callPrivateEnvelopesRepo.byCallId(db, call_id);
  if (!envRow) return { ok: false, reason: "envelope_missing" };

  // Try (2) daemon fallback past fallback_after.
  const fallbackAfterMs = envRow.fallback_after
    ? Date.parse(envRow.fallback_after)
    : Date.parse(subRow.accepted_at) +
      subRow.horizon_hours * 3_600_000 +
      REVEAL_GRACE_MS;
  if (now.getTime() >= fallbackAfterMs && opts.ageCtx?.identity) {
    try {
      const plaintextBytes = await decryptEnvelope(
        opts.ageCtx,
        envRow.encrypted_body,
      );
      const subject = await materializeFromCiphertext({
        db,
        call_id,
        envBody: plaintextBytes,
        commit_hash: subRow.commit_hash,
        commit_preimage_schema: envRow.commit_preimage_schema,
        agentWallet,
        chainId,
        revealed_via: "daemon_fallback",
        nowIso: nowIso(now),
      });
      if (subject) return { ok: true, subject };
    } catch {
      // Fall through to drand try.
    }
  }

  // Try (3) drand fallback past round time.
  if (
    envRow.drand_round &&
    envRow.drand_ciphertext &&
    opts.drandCtx?.available
  ) {
    const roundTimeMs = drandRoundTimeMs(opts.drandCtx, envRow.drand_round);
    if (roundTimeMs !== null && now.getTime() >= roundTimeMs) {
      try {
        const plaintextBytes = await decryptDrandEnvelope(
          opts.drandCtx,
          envRow.drand_ciphertext,
        );
        const subject = await materializeFromCiphertext({
          db,
          call_id,
          envBody: plaintextBytes,
          commit_hash: subRow.commit_hash,
          commit_preimage_schema: envRow.commit_preimage_schema,
          agentWallet,
          chainId,
          revealed_via: "drand_fallback",
          nowIso: nowIso(now),
        });
        if (subject) return { ok: true, subject };
      } catch (err) {
        return {
          ok: false,
          reason: "decrypt_failed",
          detail: err instanceof Error ? err.message : "drand decrypt failed",
        };
      }
    }
  }

  return { ok: false, reason: "not_yet_revealable" };
}

// ─── helpers ────────────────────────────────────────────────────────────────

function rowToSubject(row: CallRevealRow): ResolutionSubject {
  return {
    call_id: row.call_id,
    source: row.revealed_via,
    side: row.side,
    asset_id: row.asset_id,
    horizon_hours: row.horizon_hours,
    confidence: row.confidence,
    rationale: row.rationale,
    strategy_tag: row.strategy_tag,
    agent_wallet: row.agent_wallet,
    chain_id: row.chain_id,
    commit_preimage_hash: row.commit_preimage_hash,
    commit_preimage_schema: row.commit_preimage_json
      ? safeJsonField(row.commit_preimage_json, "domain")
      : null,
    revealed_at: row.revealed_at,
    reveal_hash_valid: row.reveal_hash_valid === 1,
  };
}

function safeJsonField(json: string, _field: string): string | null {
  // The commit_preimage_json carries the canonical domain field; we
  // surface it back as commit_preimage_schema for the v2 resolution
  // receipt's `reveal.commit_preimage_schema`. Defensive parse in case
  // a future schema rotation leaves an old row in place.
  try {
    JSON.parse(json);
    return "murmur-verdict-v0.2-commit@1";
  } catch {
    return null;
  }
}

interface MaterializeArgs {
  db: Database.Database;
  call_id: string;
  envBody: Uint8Array;
  commit_hash: string | null;
  commit_preimage_schema: string;
  agentWallet: string | null;
  chainId: string | null;
  revealed_via: "daemon_fallback" | "drand_fallback";
  nowIso: string;
}

async function materializeFromCiphertext(
  args: MaterializeArgs,
): Promise<ResolutionSubject | null> {
  // The envelope plaintext was written at submit time as
  // JSON.stringify({ preimage_canonical: <stringified preimage>, rationale, strategy_tag }).
  // Parse it back, recompute commit_hash from the preimage, verify
  // against the stored commit_hash on submissions, then write a
  // call_reveals row.
  let parsed: { preimage_canonical: string; rationale: string | null; strategy_tag: string | null };
  try {
    parsed = JSON.parse(new TextDecoder().decode(args.envBody)) as typeof parsed;
  } catch {
    return null;
  }

  let preimageObj: ReturnType<typeof buildCommitPreimage>;
  try {
    preimageObj = JSON.parse(parsed.preimage_canonical) as ReturnType<
      typeof buildCommitPreimage
    >;
  } catch {
    return null;
  }

  const recomputed = computeCommitHash(preimageObj);
  const valid =
    args.commit_hash &&
    recomputed.toLowerCase() === args.commit_hash.toLowerCase();
  if (!valid) return null;
  const row: CallRevealRow = {
    call_id: args.call_id,
    side: preimageObj.side,
    asset_id: preimageObj.asset_id,
    horizon_hours: preimageObj.horizon_hours,
    confidence: preimageObj.confidence,
    rationale: parsed.rationale,
    strategy_tag: parsed.strategy_tag,
    salt: preimageObj.salt,
    t0: preimageObj.t0,
    agent_wallet: args.agentWallet ?? preimageObj.agent_wallet,
    chain_id: args.chainId ?? preimageObj.chain_id,
    commit_preimage_json: parsed.preimage_canonical,
    commit_preimage_hash: recomputed,
    revealed_at: args.nowIso,
    revealed_via: args.revealed_via,
    reveal_hash_valid: 1,
  };
  insertIfAbsent(args.db, row);
  // Re-read in case a concurrent writer beat us to the insert.
  const final = callRevealsRepo.byCallId(args.db, args.call_id);
  if (final) {
    return isValidCommittedReveal(final, args.commit_hash)
      ? rowToSubject(final)
      : null;
  }
  return rowToSubject(row);
}

function isValidCommittedReveal(
  row: CallRevealRow,
  expectedHash: string | null,
): boolean {
  if (!expectedHash || row.reveal_hash_valid !== 1 || !row.commit_preimage_hash) {
    return false;
  }
  if (row.commit_preimage_hash.toLowerCase() !== expectedHash.toLowerCase()) {
    return false;
  }
  if (!row.commit_preimage_json) return false;
  try {
    const preimage = JSON.parse(row.commit_preimage_json) as ReturnType<
      typeof buildCommitPreimage
    >;
    if (computeCommitHash(preimage).toLowerCase() !== expectedHash.toLowerCase()) {
      return false;
    }
    return (
      row.side === preimage.side &&
      row.asset_id === preimage.asset_id &&
      row.horizon_hours === preimage.horizon_hours &&
      row.confidence === preimage.confidence &&
      row.t0 === preimage.t0 &&
      row.agent_wallet === preimage.agent_wallet &&
      row.chain_id === preimage.chain_id
    );
  } catch {
    return false;
  }
}

function insertIfAbsent(db: Database.Database, row: CallRevealRow): void {
  try {
    callRevealsRepo.insert(db, row);
  } catch (err) {
    // call_reveals.call_id is the PRIMARY KEY — a concurrent writer
    // (resolver vs /reveal) racing on the same call hits this. Treat
    // unique-violations as a successful no-op; everything else
    // bubbles for visibility.
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code: string }).code === "SQLITE_CONSTRAINT_PRIMARYKEY"
    ) {
      return;
    }
    throw err;
  }
}

function drandRoundTimeMs(
  ctx: DrandContext,
  round: number,
): number | null {
  // round_time = genesis_time + (round - 1) * period (in seconds)
  if (!ctx.chain.period || !ctx.chain.genesis_time) return null;
  return (ctx.chain.genesis_time + (round - 1) * ctx.chain.period) * 1000;
}

function nowIso(d: Date): string {
  return d.toISOString().replace(/\.\d+Z$/, "Z");
}
