import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { privateKeyToAccount } from "viem/accounts";

import {
  bindControllerWalletResponse,
  controllerWalletChallengeResponse,
  controllerWalletReattestationChallengeResponse,
  reattestControllerWalletResponse,
  sendAccountControllerWalletJsonResponse,
} from "./account-controller-wallet-surface.js";
import {
  getOrCreateAccount,
  linkAgentToAccount,
} from "./auth/accounts.js";
import {
  agentsRepo,
  openDb,
} from "./db.js";
import { VerdictError } from "./schema.js";

class FakeAccountControllerWalletJsonResponse {
  statusCode: number | null = null;
  body: unknown = null;

  status(code: number): { json: (body: unknown) => void } {
    this.statusCode = code;
    return {
      json: (body: unknown) => {
        this.body = body;
      },
    };
  }
}

const tmp = mkdtempSync(join(tmpdir(), "murmur-account-controller-wallet-surface-"));
const dbPath = join(tmp, "test.db");

try {
  process.stdout.write("murmur account Controller Wallet surface smoke\n");
  const db = openDb({ path: dbPath });
  const owner = privateKeyToAccount(`0x${"33".repeat(32)}`);
  const wallet = owner.address.toLowerCase();
  const agentId = randomUUID();
  const now = () => new Date("2026-06-12T10:00:00Z");

  agentsRepo.insert(db, {
    agent_id: agentId,
    display_slug: "wallet-surface-agent",
    kind: "agent",
    display_name: "Wallet Surface Agent",
    created_at: "2026-06-12T09:50:00Z",
  });
  const account = getOrCreateAccount(db, {
    privy_user_id: "did:privy:account-controller-wallet-surface",
    session_id: "account-controller-wallet-surface-session",
    expires_at: "2026-06-12T11:00:00Z",
  }, {
    resolvedAt: new Date("2026-06-12T09:50:00Z"),
  });
  linkAgentToAccount(db, account.account_id, agentId, {
    linkedAt: new Date("2026-06-12T09:50:00Z"),
  });

  assert.throws(
    () =>
      controllerWalletChallengeResponse({
        db,
        accountId: account.account_id,
        slug: "wallet-surface-agent",
        body: { wallet_address: "not-a-wallet", chain_id: "eip155:84532" },
        operationInstant: now(),
      }),
    (err) => err instanceof VerdictError && err.httpStatus === 400,
  );

  const challenge = controllerWalletChallengeResponse({
    db,
    accountId: account.account_id,
    slug: "wallet-surface-agent",
    body: {
      wallet_address: wallet,
      chain_id: "eip155:84532",
      wallet_kind: "embedded",
      provider: "privy",
    },
    operationInstant: now(),
  });
  assert.equal(challenge.status, 200);
  assert.equal(challenge.body.agent_id, agentId);
  assert.equal(challenge.body.display_slug, "wallet-surface-agent");
  assert.equal(challenge.body.wallet_address, wallet);
  assert.equal(challenge.body.chain_id, "eip155:84532");
  assert.equal(challenge.body.wallet_kind, "embedded");
  assert.equal(challenge.body.provider, "privy");
  assert.equal(challenge.body.authorization_issued_at, "2026-06-12T10:00:00Z");
  assert.match(challenge.body.message, /Murmur Controller Wallet Binding/);
  const challengeRes = new FakeAccountControllerWalletJsonResponse();
  sendAccountControllerWalletJsonResponse(challengeRes, challenge);
  assert.equal(challengeRes.statusCode, 200);
  assert.equal(
    (challengeRes.body as typeof challenge.body).display_slug,
    "wallet-surface-agent",
  );

  const bindingSignature = await owner.signMessage({
    message: challenge.body.message,
  });
  const bindBody = {
    wallet_address: wallet,
    chain_id: "eip155:84532",
    wallet_kind: "embedded",
    provider: "privy",
    authorization_issued_at: challenge.body.authorization_issued_at,
    signature: bindingSignature,
  };

  await assert.rejects(
    () =>
      bindControllerWalletResponse({
        db,
        accountId: account.account_id,
        slug: "wallet-surface-agent",
        body: bindBody,
        operationInstant: now(),
        verifySignature: async () => false,
      }),
    (err) => err instanceof VerdictError && err.httpStatus === 403,
  );

  const bound = await bindControllerWalletResponse({
    db,
    accountId: account.account_id,
    slug: "wallet-surface-agent",
    body: bindBody,
    operationInstant: now(),
  });
  assert.equal(bound.status, 200);
  assert.equal(bound.body.agent_id, agentId);
  assert.equal(bound.body.display_slug, "wallet-surface-agent");
  assert.equal(bound.body.wallet_address, wallet);
  assert.equal(bound.body.chain_id, "eip155:84532");
  assert.equal(bound.body.wallet_kind, "embedded");
  assert.equal(bound.body.provider, "privy");
  assert.equal(bound.body.created_at, "2026-06-12T10:00:00Z");
  assert.equal(bound.body.last_attested_at, "2026-06-12T10:00:00Z");
  assert.equal(bound.body.reattestation_due_at, "2026-06-26T10:00:00Z");
  assert.equal(bound.body.reattestation_overdue, false);
  assert.equal(bound.body.idempotent_hit, false);
  const boundRow = db
    .prepare(
      `SELECT created_at, last_attested_at, reattestation_due_at
       FROM agent_controller_wallets
       WHERE agent_id = ?`,
    )
    .get(agentId) as {
      created_at: string;
      last_attested_at: string;
      reattestation_due_at: string;
    };
  assert.equal(boundRow.created_at, "2026-06-12T10:00:00Z");
  assert.equal(boundRow.last_attested_at, "2026-06-12T10:00:00Z");
  assert.equal(boundRow.reattestation_due_at, "2026-06-26T10:00:00Z");
  const boundRes = new FakeAccountControllerWalletJsonResponse();
  sendAccountControllerWalletJsonResponse(boundRes, bound);
  assert.equal(boundRes.statusCode, 200);
  assert.equal((boundRes.body as typeof bound.body).wallet_address, wallet);

  const idempotent = await bindControllerWalletResponse({
    db,
    accountId: account.account_id,
    slug: "wallet-surface-agent",
    body: bindBody,
    operationInstant: now(),
  });
  assert.equal(idempotent.body.idempotent_hit, true);

  assert.throws(
    () =>
      controllerWalletReattestationChallengeResponse({
        db,
        accountId: account.account_id,
        slug: "wallet-surface-agent",
        body: { extra: true },
        newAuthorizationNonce: () => {
          throw new Error("invalid re-attestation challenge should not mint nonce");
        },
        operationInstant: now(),
      }),
    (err) => err instanceof VerdictError && err.httpStatus === 400,
  );

  const reattestChallenge = controllerWalletReattestationChallengeResponse({
    db,
    accountId: account.account_id,
    slug: "wallet-surface-agent",
    body: {},
    newAuthorizationNonce: () => "reattest_surface_nonce_1",
    operationInstant: now(),
  });
  assert.equal(reattestChallenge.status, 200);
  assert.equal(reattestChallenge.body.agent_id, agentId);
  assert.equal(reattestChallenge.body.controller_wallet_address, wallet);
  assert.equal(reattestChallenge.body.controller_chain_id, "eip155:84532");
  assert.equal(reattestChallenge.body.attestation_nonce, "reattest_surface_nonce_1");
  assert.equal(
    reattestChallenge.body.previous_last_attested_at,
    "2026-06-12T10:00:00Z",
  );
  assert.equal(
    reattestChallenge.body.previous_reattestation_due_at,
    "2026-06-26T10:00:00Z",
  );
  assert.equal(reattestChallenge.body.reattestation_interval_seconds, 1_209_600);
  assert.match(reattestChallenge.body.message, /Murmur Controller Wallet Re-Attestation/);

  const reattestationSignature = await owner.signMessage({
    message: reattestChallenge.body.message,
  });
  const reattestBody = {
    attestation_nonce: reattestChallenge.body.attestation_nonce,
    authorization_issued_at: reattestChallenge.body.authorization_issued_at,
    signature: reattestationSignature,
  };
  const reattestationIds: string[] = [];
  const newReattestationId = () => {
    const id = `reattest-surface-id-${reattestationIds.length + 1}`;
    reattestationIds.push(id);
    return id;
  };

  await assert.rejects(
    () =>
      reattestControllerWalletResponse({
        db,
        accountId: account.account_id,
        slug: "wallet-surface-agent",
        body: reattestBody,
        operationInstant: now(),
        newReattestationId: () => {
          throw new Error("failed signature should not mint re-attestation id");
        },
        verifySignature: async () => false,
      }),
    (err) => err instanceof VerdictError && err.httpStatus === 403,
  );

  const reattested = await reattestControllerWalletResponse({
    db,
    accountId: account.account_id,
    slug: "wallet-surface-agent",
    body: reattestBody,
    newReattestationId,
    operationInstant: now(),
  });
  assert.equal(reattested.status, 200);
  assert.equal(reattested.body.attestation_id, "reattest-surface-id-1");
  assert.deepEqual(reattestationIds, ["reattest-surface-id-1"]);
  assert.equal(reattested.body.controller_wallet?.wallet_address, wallet);
  assert.equal(
    reattested.body.controller_wallet?.reattestation_due_at,
    "2026-06-26T10:00:00Z",
  );
  const attestationRow = db
    .prepare(
      `SELECT attested_at, next_due_at
       FROM agent_controller_wallet_reattestations
       WHERE attestation_id = ?`,
    )
    .get(reattested.body.attestation_id) as {
      attested_at: string;
      next_due_at: string;
    };
  assert.equal(attestationRow.attested_at, "2026-06-12T10:00:00Z");
  assert.equal(attestationRow.next_due_at, "2026-06-26T10:00:00Z");
  const reattestedRes = new FakeAccountControllerWalletJsonResponse();
  sendAccountControllerWalletJsonResponse(reattestedRes, reattested);
  assert.equal(reattestedRes.statusCode, 200);
  assert.equal(
    (reattestedRes.body as typeof reattested.body).controller_wallet?.wallet_address,
    wallet,
  );

  await assert.rejects(
    () =>
      reattestControllerWalletResponse({
        db,
        accountId: account.account_id,
        slug: "wallet-surface-agent",
        body: reattestBody,
        newReattestationId: () => {
          throw new Error("replayed nonce should not mint re-attestation id");
        },
        operationInstant: now(),
      }),
    (err) => err instanceof VerdictError && err.httpStatus === 409,
  );
  assert.deepEqual(reattestationIds, ["reattest-surface-id-1"]);

  db.close();
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

process.stdout.write("account Controller Wallet surface smoke ok\n");
