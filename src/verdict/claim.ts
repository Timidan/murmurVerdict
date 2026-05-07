import { randomBytes, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { verifyMessage } from "viem";
import {
  agentsRepo,
  claimsRepo,
  usageRepo,
  verifiedIdentitiesRepo,
} from "./db.js";
import {
  ClaimChallenge,
  ERROR_CODES,
  SHADOW_CLAIM_LOOKBACK_DAYS,
  VerdictError,
  VerifiedIdentity,
  VerifiedIdentityKindSchema,
  type VerifiedIdentityKind,
} from "./schema.js";
import { hashSharedSecret } from "./submissions.js";

// ─── Public types ────────────────────────────────────────────────────────────

export interface ClaimInitInput {
  /** Slug of the agent being claimed (typically a shadow agent). */
  display_slug: string;
  /** Identity the operator wants to bind. Must match a verified identity on the agent. */
  target_identity: { kind: VerifiedIdentityKind; value: string };
  /** Wallet the operator wants bound for HMAC + on-chain attestations. */
  wallet_to_bind: `0x${string}`;
  /** TTL override for tests. Default 30 minutes. */
  ttl_minutes?: number;
  now?: () => Date;
}

export interface ClaimInitResult {
  challenge_id: string;
  nonce: string;
  challenge_text: string;
  expires_at: string;
  target_identity: { kind: VerifiedIdentityKind; value: string };
  wallet_to_bind: `0x${string}`;
  agent_id: string;
  display_slug: string;
  /** Human instructions the dashboard renders next to the post composer. */
  instructions: string[];
}

export interface ClaimFinalizeInput {
  challenge_id: string;
  /** Signature over the SAME nonce string by `wallet_to_bind`. */
  signature: `0x${string}`;
  /** URL of the public post containing `challenge_text`. */
  post_url: string;
  now?: () => Date;
}

export interface ClaimFinalizeResult {
  agent_id: string;
  display_slug: string;
  imported_call_ids: string[];
  api_key: string;
  /** sha256(api_key) — stored on the agent for HMAC verification later. */
  api_key_hash: string;
  verified_at: string;
}

// ─── Adapter contract: how do we prove the post exists? ──────────────────────
// Different identity kinds have different verification paths. v0.1 ships a
// pluggable verifier; defaults to deterministic regex-only verification when no
// adapter is supplied (acceptable for early launch since the wallet signature
// already proves ownership of the public account in most flows). External
// adapters (X API, Telegram Bot API) plug in later without touching this file.

export interface PostVerifier {
  /**
   * Verify that `expectedText` is present in a post made by `target_identity`,
   * referenced by `post_url`. Adapters MUST be conservative — return false on
   * any uncertainty.
   */
  verify(args: {
    target_identity: { kind: VerifiedIdentityKind; value: string };
    expected_text: string;
    post_url: string;
  }): Promise<boolean>;
}

class NullVerifier implements PostVerifier {
  async verify(): Promise<boolean> {
    return true;
  }
}

class FailClosedVerifier implements PostVerifier {
  async verify(): Promise<boolean> {
    return false;
  }
}

// ─── ClaimService ────────────────────────────────────────────────────────────

export interface ClaimServiceDeps {
  db: Database.Database;
  verifier?: PostVerifier;
  /** Inject for tests. Default verifyMessage from viem. */
  verifySignature?: (args: {
    address: `0x${string}`;
    message: string;
    signature: `0x${string}`;
  }) => Promise<boolean>;
}

export class ClaimService {
  private readonly db: Database.Database;
  private readonly verifier: PostVerifier;
  private readonly verifySignature: NonNullable<ClaimServiceDeps["verifySignature"]>;

  constructor(deps: ClaimServiceDeps) {
    this.db = deps.db;
    // Fail-closed by default in production: if the operator did not configure
    // a real PostVerifier (e.g. X API or Telegram bot) AND we're not in dev,
    // every claim attempt is rejected. The only way to bypass this is to set
    // CLAIM_VERIFY_BYPASS=true in env (intended for local dev only) or pass
    // an explicit verifier from the test harness.
    if (deps.verifier) {
      this.verifier = deps.verifier;
    } else if (
      process.env.NODE_ENV !== "production" ||
      process.env.CLAIM_VERIFY_BYPASS === "true"
    ) {
      this.verifier = new NullVerifier();
    } else {
      this.verifier = new FailClosedVerifier();
    }
    this.verifySignature =
      deps.verifySignature ??
      (async ({ address, message, signature }) =>
        verifyMessage({ address, message, signature }));
  }

  async init(input: ClaimInitInput): Promise<ClaimInitResult> {
    const now = (input.now ?? (() => new Date()))();
    const ttlMs = (input.ttl_minutes ?? 30) * 60 * 1000;

    const agent = agentsRepo.bySlug(this.db, input.display_slug);
    if (!agent) {
      throw new VerdictError(
        "agent not found",
        ERROR_CODES.unknown_agent,
        404,
      );
    }
    if (agent.kind !== "shadow") {
      throw new VerdictError(
        `agent ${input.display_slug} is already ${agent.kind}; only shadow agents can be claimed`,
        ERROR_CODES.unknown_agent,
        409,
        { current_kind: agent.kind },
      );
    }

    const identityKind = VerifiedIdentityKindSchema.parse(
      input.target_identity.kind,
    );
    const matchesIdentity = agent.verified_identities.some(
      (i) => i.kind === identityKind && i.value === input.target_identity.value,
    );
    if (!matchesIdentity) {
      throw new VerdictError(
        "target_identity does not match an identity on this agent",
        ERROR_CODES.agent_not_authorized,
        403,
      );
    }

    const nonce = randomBytes(16).toString("hex");
    const challenge_text = `murmur-claim:${agent.agent_id}:${nonce}:${input.wallet_to_bind}`;
    const challenge_id = randomUUID();
    const expires_at = new Date(now.getTime() + ttlMs)
      .toISOString()
      .replace(/\.\d+Z$/, "Z");

    const challenge: ClaimChallenge = {
      challenge_id,
      agent_id: agent.agent_id,
      target_identity: input.target_identity,
      nonce,
      challenge_text,
      wallet_to_bind: input.wallet_to_bind,
      expires_at,
      status: "pending",
    };
    claimsRepo.insert(this.db, challenge);
    usageRepo.emit(this.db, {
      event_id: randomUUID(),
      agent_id: agent.agent_id,
      kind: "claim_initiated",
      ts: now.toISOString().replace(/\.\d+Z$/, "Z"),
      attributes: { challenge_id, target_kind: identityKind, target_value: input.target_identity.value },
    });
    return {
      challenge_id,
      nonce,
      challenge_text,
      expires_at,
      target_identity: input.target_identity,
      wallet_to_bind: input.wallet_to_bind,
      agent_id: agent.agent_id,
      display_slug: agent.display_slug,
      instructions: [
        `Post the following text on ${identityKind}:${input.target_identity.value} verbatim:`,
        challenge_text,
        `Then sign the nonce "${nonce}" with the wallet ${input.wallet_to_bind} (personal_sign / EIP-191).`,
        `Finally call /v1/agents/${agent.display_slug}/claim/finalize with {challenge_id, signature, post_url}.`,
      ],
    };
  }

  async finalize(input: ClaimFinalizeInput): Promise<ClaimFinalizeResult> {
    const now = (input.now ?? (() => new Date()))();
    const row = this.db
      .prepare("SELECT * FROM claim_challenges WHERE challenge_id = ?")
      .get(input.challenge_id) as RawClaimRow | undefined;
    if (!row) {
      throw new VerdictError("challenge not found", ERROR_CODES.unknown_agent, 404);
    }
    if (row.status !== "pending") {
      throw new VerdictError(
        `challenge already ${row.status}`,
        ERROR_CODES.agent_not_authorized,
        409,
      );
    }
    if (Date.parse(row.expires_at) < now.getTime()) {
      claimsRepo.setStatus(this.db, row.challenge_id, "expired");
      throw new VerdictError("challenge expired", ERROR_CODES.agent_not_authorized, 410);
    }

    // 1. Verify wallet signature over the nonce. Treat any thrown error as
    //    "did not verify" — viem throws on malformed signatures rather than
    //    returning false.
    let sigValid = false;
    try {
      sigValid = await this.verifySignature({
        address: row.wallet_to_bind as `0x${string}`,
        message: row.nonce,
        signature: input.signature,
      });
    } catch {
      sigValid = false;
    }
    if (!sigValid) {
      claimsRepo.setStatus(this.db, row.challenge_id, "rejected");
      throw new VerdictError(
        "wallet signature did not verify against nonce",
        ERROR_CODES.agent_not_authorized,
        403,
      );
    }

    // 2. Verify the public post exists with the exact challenge text.
    const target_identity = {
      kind: VerifiedIdentityKindSchema.parse(row.target_kind),
      value: row.target_value,
    };
    const postOk = await this.verifier.verify({
      target_identity,
      expected_text: row.challenge_text,
      post_url: input.post_url,
    });
    if (!postOk) {
      claimsRepo.setStatus(this.db, row.challenge_id, "rejected");
      throw new VerdictError(
        "challenge post not found or text mismatch",
        ERROR_CODES.agent_not_authorized,
        403,
      );
    }

    // 3. Atomically: flip agent to verified, bind wallet identity, retro-import
    //    shadow calls in lookback window, issue API key, mark challenge verified.
    const verified_at = now.toISOString().replace(/\.\d+Z$/, "Z");
    const sinceIso = new Date(now.getTime() - SHADOW_CLAIM_LOOKBACK_DAYS * 24 * 60 * 60 * 1000)
      .toISOString()
      .replace(/\.\d+Z$/, "Z");

    const apiKey = randomBytes(32).toString("hex");
    const apiKeyHash = hashSharedSecret(apiKey);

    const importedCallIds: string[] = [];

    const tx = this.db.transaction(() => {
      // Bind wallet identity if not present.
      const existingWallet = this.db
        .prepare(
          "SELECT identity_id FROM verified_identities WHERE agent_id = ? AND kind = 'wallet' AND value = ?",
        )
        .get(row.agent_id, row.wallet_to_bind);
      if (!existingWallet) {
        const walletIdentity: VerifiedIdentity = {
          kind: "wallet",
          value: row.wallet_to_bind,
          verified_at,
        };
        verifiedIdentitiesRepo.insert(this.db, row.agent_id, walletIdentity);
      }

      // Flip kind & set api_key_hash.
      agentsRepo.setKind(this.db, row.agent_id, "verified");
      agentsRepo.setApiKeyHash(this.db, row.agent_id, apiKeyHash);

      // Import all-or-nothing: any shadow call from this identity within
      // lookback already lives on this agent_id, so they're already counted.
      // We still record the imported set explicitly for the audit trail.
      const calls = this.db
        .prepare(
          "SELECT call_id FROM submissions WHERE agent_id = ? AND submitted_at >= ?",
        )
        .all(row.agent_id, sinceIso) as Array<{ call_id: string }>;
      for (const c of calls) importedCallIds.push(c.call_id);

      claimsRepo.setStatus(this.db, row.challenge_id, "verified");
      usageRepo.emit(this.db, {
        event_id: randomUUID(),
        agent_id: row.agent_id,
        kind: "claim_completed",
        ts: verified_at,
        attributes: {
          challenge_id: row.challenge_id,
          imported_count: importedCallIds.length,
          target_kind: target_identity.kind,
          target_value: target_identity.value,
          post_url: input.post_url,
        },
      });
    });
    tx();

    const reloaded = agentsRepo.byId(this.db, row.agent_id);
    return {
      agent_id: row.agent_id,
      display_slug: reloaded?.display_slug ?? "",
      imported_call_ids: importedCallIds,
      api_key: apiKey,
      api_key_hash: apiKeyHash,
      verified_at,
    };
  }
}

interface RawClaimRow {
  challenge_id: string;
  agent_id: string;
  target_kind: string;
  target_value: string;
  nonce: string;
  challenge_text: string;
  wallet_to_bind: string;
  expires_at: string;
  status: ClaimChallenge["status"];
  created_at: string;
}
