import { randomBytes, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { getAddress, verifyMessage } from "viem";
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
import { buildClaimMessage } from "./claim-message.js";

// ─── Public types ────────────────────────────────────────────────────────────

export interface ClaimInitInput {
  /** Slug of the agent being claimed (typically a shadow agent). */
  display_slug: string;
  /** Identity the operator wants to bind. Must match a verified identity on the agent. */
  target_identity: { kind: VerifiedIdentityKind; value: string };
  /** Wallet the operator wants bound for HMAC + on-chain attestations. */
  wallet_to_bind: `0x${string}`;
  /**
   * Origin the daemon is serving on (e.g. https://murmur-verdict.onrender.com).
   * Folded into the claim message so signatures bind to a specific deploy
   * and can't be replayed across environments.
   */
  origin: string;
  /** TTL override for tests. Default 30 minutes. */
  ttl_minutes?: number;
  now?: () => Date;
}

export interface ClaimInitResult {
  challenge_id: string;
  nonce: string;
  challenge_text: string;
  /**
   * Domain-bound message the wallet signs. Replaces the older "sign the
   * nonce" path — binds origin/slug/agent_id/challenge_id/wallet/nonce/
   * expires_at so a signature can't be replayed across slugs, agents,
   * deploys, or claims.
   */
  sign_message: string;
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
  /**
   * Signature over the domain-bound claim message (NOT just the nonce —
   * see buildClaimMessage in claim-message.ts). Daemon reconstructs the
   * message from the stored challenge_id; the agent must rebuild it
   * identically and sign that, not the raw nonce.
   */
  signature: `0x${string}`;
  /** URL of the public post containing `challenge_text`. */
  post_url: string;
  /** Origin used to rebuild the canonical claim message at verification time. */
  origin: string;
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

    const created_at = now.toISOString().replace(/\.\d+Z$/, "Z");
    // Lowercase-normalize the wallet so the signed message and the stored
    // verified_identity share canonical form. viem.getAddress validates +
    // checksums; we then lowercase for storage so the unique constraint on
    // verified_identities(kind,value) doesn't fork on case differences.
    const walletLower = getAddress(input.wallet_to_bind).toLowerCase();
    const challenge: ClaimChallenge = {
      challenge_id,
      agent_id: agent.agent_id,
      target_identity: input.target_identity,
      nonce,
      challenge_text,
      wallet_to_bind: walletLower,
      expires_at,
      status: "pending",
      created_at,
    };
    claimsRepo.insert(this.db, challenge);
    const sign_message = buildClaimMessage({
      origin: input.origin.replace(/\/$/, ""),
      display_slug: agent.display_slug,
      agent_id: agent.agent_id,
      challenge_id,
      wallet: walletLower,
      nonce,
      expires_at,
    });
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
      sign_message,
      expires_at,
      target_identity: input.target_identity,
      wallet_to_bind: walletLower as `0x${string}`,
      agent_id: agent.agent_id,
      display_slug: agent.display_slug,
      instructions: [
        `Post the following text on ${identityKind}:${input.target_identity.value} verbatim:`,
        challenge_text,
        `Sign this message with wallet ${walletLower} (personal_sign / EIP-191):`,
        sign_message,
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

    // Look up the agent's slug for the canonical message reconstruction.
    const agent = agentsRepo.byId(this.db, row.agent_id);
    if (!agent) {
      throw new VerdictError("agent not found", ERROR_CODES.unknown_agent, 404);
    }

    // 1. Verify wallet signature over the DOMAIN-BOUND claim message
    //    (origin/slug/agent_id/challenge_id/wallet/nonce/expires_at), not
    //    just the raw nonce. Same data on both sides — daemon rebuilds it
    //    here from the stored row + caller-supplied origin, the agent
    //    must have constructed the same string when signing. Closes the
    //    cross-environment / cross-claim replay vectors.
    const expectedMessage = buildClaimMessage({
      origin: input.origin.replace(/\/$/, ""),
      display_slug: agent.display_slug,
      agent_id: agent.agent_id,
      challenge_id: row.challenge_id,
      wallet: row.wallet_to_bind,
      nonce: row.nonce,
      expires_at: row.expires_at,
    });
    let sigValid = false;
    try {
      sigValid = await this.verifySignature({
        address: row.wallet_to_bind as `0x${string}`,
        message: expectedMessage,
        signature: input.signature,
      });
    } catch {
      sigValid = false;
    }
    if (!sigValid) {
      claimsRepo.setStatus(this.db, row.challenge_id, "rejected");
      throw new VerdictError(
        "wallet signature did not verify against canonical claim message",
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

    // 3. Single-use guard. Race-safe: only one parallel finalize can flip
    //    pending → verified. Losers see the row already verified and
    //    abort BEFORE any side-effects (api_key issuance, kind flip).
    if (!claimsRepo.claimIfPending(this.db, row.challenge_id, "verified")) {
      throw new VerdictError(
        "challenge already finalized by a parallel request",
        ERROR_CODES.agent_not_authorized,
        409,
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

      // Flip kind, set api_key_hash, denormalize wallet onto agents row
      // so receipts can canonicalize wallet binding without joining
      // verified_identities on every build (Codex's note from the
      // P1.5 review: "Otherwise every receipt build needs a join").
      agentsRepo.setKind(this.db, row.agent_id, "verified");
      agentsRepo.setApiKeyHash(this.db, row.agent_id, apiKeyHash);
      agentsRepo.setWallet(
        this.db,
        row.agent_id,
        row.wallet_to_bind,
        // Default chain_id; v0.3 fhEVM port will let agents pick.
        "eip155:8453",
      );

      // Import all-or-nothing: any shadow call from this identity within
      // lookback already lives on this agent_id, so they're already counted.
      // We still record the imported set explicitly for the audit trail.
      const calls = this.db
        .prepare(
          "SELECT call_id FROM submissions WHERE agent_id = ? AND submitted_at >= ?",
        )
        .all(row.agent_id, sinceIso) as Array<{ call_id: string }>;
      for (const c of calls) importedCallIds.push(c.call_id);

      // Status flip already happened atomically in claimIfPending() above —
      // do NOT setStatus again here; it would un-do the race-safety guard
      // by writing through after-the-fact and could collide with a parallel
      // finalize that also raced to verified.
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

  /**
   * Wallet-only claim init — the agent self-onboarding path.
   *
   * Differs from the X/Telegram-bound init() above:
   *   - No public identity required (no X/Telegram post step at finalize)
   *   - Slug self-mint allowed: if `display_slug` doesn't exist, an agent
   *     row is created inline with kind="wallet_only" and api_key_hash=NULL
   *   - Reserved slugs (admin, vitalik, etc.) are blocked here, NOT at the
   *     schema layer, so legitimate operators can still mint reserved slugs
   *     via admin tools
   *   - Wallet address is lowercase-normalized via viem.getAddress
   *   - Returns the same canonical sign_message shape as init() so the
   *     finalize path is the same domain-bound verification
   */
  async walletOnlyInit(input: WalletOnlyClaimInitInput): Promise<ClaimInitResult> {
    const now = (input.now ?? (() => new Date()))();
    const ttlMs = (input.ttl_minutes ?? 30) * 60 * 1000;

    // Lazy-import to avoid a top-level dependency on a file the X/Telegram
    // path doesn't need.
    const { isReservedSlug, RESERVED_SLUG_REASON } = await import(
      "./reserved-slugs.js"
    );

    if (isReservedSlug(input.display_slug)) {
      throw new VerdictError(
        RESERVED_SLUG_REASON,
        ERROR_CODES.agent_not_authorized,
        403,
      );
    }

    const walletLower = getAddress(input.wallet_to_bind).toLowerCase();
    const chainId = input.chain_id ?? "eip155:8453";

    // Find or self-mint the agent. The whole branch — mint + insert
    // challenge + emit usage — is wrapped in a single transaction so a
    // crash mid-flow can't leave a half-created agent behind.
    let agentId: string;
    let displaySlug: string;
    const txBuild = this.db.transaction(() => {
      const existing = agentsRepo.bySlug(this.db, input.display_slug);
      if (existing) {
        // Slug already exists. Allow re-claim only if it's an unclaimed
        // shadow OR an unclaimed wallet_only row — anything else means
        // someone owns it.
        const claimable =
          (existing.kind === "shadow" || existing.kind === "wallet_only") &&
          existing.api_key_hash === null;
        if (!claimable) {
          throw new VerdictError(
            `agent ${input.display_slug} is already ${existing.kind} and claimed`,
            ERROR_CODES.agent_not_authorized,
            409,
            { current_kind: existing.kind },
          );
        }
        agentId = existing.agent_id;
        displaySlug = existing.display_slug;
      } else {
        // Self-mint: create a fresh wallet_only agent.
        agentId = randomUUID();
        const created_at = now.toISOString().replace(/\.\d+Z$/, "Z");
        const display_name = input.display_name ?? input.display_slug;
        agentsRepo.insert(
          this.db,
          {
            agent_id: agentId,
            display_slug: input.display_slug,
            kind: "wallet_only",
            display_name,
            verified_identities: [],
            created_at,
          },
          null,
        );
        displaySlug = input.display_slug;
      }

      // Rate-limit: one pending challenge per (wallet, agent_id). Spamming
      // /init for the same pair just keeps the existing pending row valid.
      const nowIso = now.toISOString().replace(/\.\d+Z$/, "Z");
      const pending = claimsRepo.countPendingForWalletAndAgent(
        this.db,
        walletLower,
        agentId,
        nowIso,
      );
      if (pending > 0) {
        throw new VerdictError(
          "a pending wallet-only claim already exists for this (slug, wallet); finalize or wait for it to expire",
          ERROR_CODES.agent_not_authorized,
          429,
        );
      }
    });
    txBuild();

    // Build challenge + sign_message OUTSIDE the transaction so we don't
    // hold the write lock through anything that could throw on bad input.
    const nonce = randomBytes(16).toString("hex");
    const challenge_id = randomUUID();
    const expires_at = new Date(now.getTime() + ttlMs)
      .toISOString()
      .replace(/\.\d+Z$/, "Z");
    const created_at = now.toISOString().replace(/\.\d+Z$/, "Z");

    // The challenge_text on a wallet-only claim has no public-post role —
    // it's stored for audit symmetry with the X/Telegram path.
    const challenge_text = `murmur-wallet-claim:${agentId!}:${nonce}:${walletLower}`;

    const challenge: ClaimChallenge = {
      challenge_id,
      agent_id: agentId!,
      // Use the wallet itself as the target_identity so the row has the
      // same shape as the X/Telegram path. target_kind="wallet" lets the
      // GC index find these rows by (target_kind, target_value, status).
      target_identity: { kind: "wallet", value: walletLower },
      nonce,
      challenge_text,
      wallet_to_bind: walletLower,
      expires_at,
      status: "pending",
      created_at,
    };
    claimsRepo.insert(this.db, challenge);

    const sign_message = buildClaimMessage({
      origin: input.origin.replace(/\/$/, ""),
      display_slug: displaySlug!,
      agent_id: agentId!,
      challenge_id,
      wallet: walletLower,
      nonce,
      expires_at,
    });

    usageRepo.emit(this.db, {
      event_id: randomUUID(),
      agent_id: agentId!,
      kind: "claim_initiated",
      ts: created_at,
      attributes: {
        challenge_id,
        target_kind: "wallet",
        target_value: walletLower,
        flow: "wallet_only",
        chain_id: chainId,
      },
    });

    return {
      challenge_id,
      nonce,
      challenge_text,
      sign_message,
      expires_at,
      target_identity: { kind: "wallet", value: walletLower },
      wallet_to_bind: walletLower as `0x${string}`,
      agent_id: agentId!,
      display_slug: displaySlug!,
      instructions: [
        `Sign the canonical claim message with wallet ${walletLower} (personal_sign / EIP-191):`,
        sign_message,
        `Then call POST /v1/agents/${displaySlug!}/claim/wallet-only/finalize with {challenge_id, signature}.`,
        `On success the response includes your api_key once — store it; the daemon only keeps the hash.`,
      ],
    };
  }

  /**
   * Wallet-only claim finalize — verify wallet signature against the
   * canonical claim message, atomically flip the challenge status, then
   * issue the API key. No public-post check; the wallet IS the identity.
   * Agent stays kind="wallet_only" (NOT "verified") because there's no
   * X/Telegram identity attached.
   */
  async walletOnlyFinalize(
    input: WalletOnlyClaimFinalizeInput,
  ): Promise<ClaimFinalizeResult> {
    const now = (input.now ?? (() => new Date()))();
    const row = this.db
      .prepare("SELECT * FROM claim_challenges WHERE challenge_id = ?")
      .get(input.challenge_id) as RawClaimRow | undefined;
    if (!row) {
      throw new VerdictError("challenge not found", ERROR_CODES.unknown_agent, 404);
    }
    if (row.target_kind !== "wallet") {
      // This challenge was created via the X/Telegram path; agent must
      // call the regular /claim/finalize endpoint instead.
      throw new VerdictError(
        "challenge was created via the X/Telegram claim flow; use /claim/finalize",
        ERROR_CODES.agent_not_authorized,
        409,
      );
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
      throw new VerdictError(
        "challenge expired",
        ERROR_CODES.agent_not_authorized,
        410,
      );
    }

    const agent = agentsRepo.byId(this.db, row.agent_id);
    if (!agent) {
      throw new VerdictError("agent not found", ERROR_CODES.unknown_agent, 404);
    }

    // Domain-bound verification — same canonical message builder as the
    // X/Telegram finalize, so a wallet-only signature can't be replayed
    // to claim an X-bound slug or vice versa.
    const expectedMessage = buildClaimMessage({
      origin: input.origin.replace(/\/$/, ""),
      display_slug: agent.display_slug,
      agent_id: agent.agent_id,
      challenge_id: row.challenge_id,
      wallet: row.wallet_to_bind,
      nonce: row.nonce,
      expires_at: row.expires_at,
    });
    let sigValid = false;
    try {
      sigValid = await this.verifySignature({
        address: row.wallet_to_bind as `0x${string}`,
        message: expectedMessage,
        signature: input.signature,
      });
    } catch {
      sigValid = false;
    }
    if (!sigValid) {
      claimsRepo.setStatus(this.db, row.challenge_id, "rejected");
      throw new VerdictError(
        "wallet signature did not verify against canonical claim message",
        ERROR_CODES.agent_not_authorized,
        403,
      );
    }

    // Atomic single-use guard.
    if (!claimsRepo.claimIfPending(this.db, row.challenge_id, "verified")) {
      throw new VerdictError(
        "challenge already finalized by a parallel request",
        ERROR_CODES.agent_not_authorized,
        409,
      );
    }

    const verified_at = now.toISOString().replace(/\.\d+Z$/, "Z");
    const apiKey = randomBytes(32).toString("hex");
    const apiKeyHash = hashSharedSecret(apiKey);
    const chainId = input.chain_id ?? "eip155:8453";

    const tx = this.db.transaction(() => {
      // Bind wallet identity (verified_identities row) — same shape the
      // X/Telegram path creates so dashboards / receipts / leaderboard
      // queries don't need to special-case wallet-only agents.
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

      // Set kind to "wallet_only" (NOT "verified" — no public identity
      // proof). Set api_key_hash + denormalized wallet so receipts can
      // canonicalize wallet binding without joining verified_identities.
      agentsRepo.setKind(this.db, row.agent_id, "wallet_only");
      agentsRepo.setApiKeyHash(this.db, row.agent_id, apiKeyHash);
      agentsRepo.setWallet(this.db, row.agent_id, row.wallet_to_bind, chainId);

      usageRepo.emit(this.db, {
        event_id: randomUUID(),
        agent_id: row.agent_id,
        kind: "claim_completed",
        ts: verified_at,
        attributes: {
          challenge_id: row.challenge_id,
          flow: "wallet_only",
          target_kind: "wallet",
          target_value: row.wallet_to_bind,
          chain_id: chainId,
        },
      });
    });
    tx();

    return {
      agent_id: row.agent_id,
      display_slug: agent.display_slug,
      imported_call_ids: [], // wallet-only doesn't import shadow calls
      api_key: apiKey,
      api_key_hash: apiKeyHash,
      verified_at,
    };
  }
}

export interface WalletOnlyClaimInitInput {
  display_slug: string;
  wallet_to_bind: `0x${string}`;
  /** Optional human-readable name; defaults to the slug. */
  display_name?: string;
  /** Optional CAIP-2 chain_id. Defaults to eip155:8453 (Base mainnet). */
  chain_id?: string;
  origin: string;
  ttl_minutes?: number;
  now?: () => Date;
}

export interface WalletOnlyClaimFinalizeInput {
  challenge_id: string;
  signature: `0x${string}`;
  origin: string;
  /** CAIP-2 chain_id, optional — defaults must match init's default. */
  chain_id?: string;
  now?: () => Date;
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
