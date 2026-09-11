import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { privateKeyToAccount } from "viem/accounts";

import {
  engageAccountKillSwitch,
  releaseAccountKillSwitch,
} from "./auth/account-kill-switch.js";

import {
  listAccountRuntimeKeysResponse,
  mintAccountRuntimeKeyResponse,
  revokeAccountRuntimeKeyResponse,
  runtimeKeyChallengeResponse,
  sendAccountRuntimeKeyJsonResponse,
} from "./account-runtime-key-surface.js";
import {
  bindControllerWallet,
  getOrCreateAccount,
  linkAgentToAccount,
} from "./auth/accounts.js";
import {
  agentsRepo,
  openDb,
} from "./db.js";
import { VerdictError } from "./schema.js";

class FakeAccountRuntimeKeyJsonResponse {
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

const tmp = mkdtempSync(join(tmpdir(), "murmur-account-runtime-key-surface-"));
const dbPath = join(tmp, "test.db");

try {
  process.stdout.write("murmur account Runtime Key surface smoke\n");
  const db = openDb({ path: dbPath });
  const owner = privateKeyToAccount(`0x${"22".repeat(32)}`);
  const wallet = owner.address.toLowerCase();
  const agentId = randomUUID();
  const now = () => new Date("2026-06-12T10:00:00Z");
  const createdAt = "2026-06-12T09:45:00Z";

  agentsRepo.insert(db, {
    agent_id: agentId,
    display_slug: "runtime-key-agent",
    kind: "agent",
    display_name: "Runtime Key Agent",
    created_at: createdAt,
  });
  const account = getOrCreateAccount(db, {
    privy_user_id: "did:privy:account-runtime-key-surface",
    session_id: "account-runtime-key-surface-session",
    expires_at: "2026-06-12T11:00:00Z",
  }, {
    resolvedAt: new Date(createdAt),
  });
  linkAgentToAccount(db, account.account_id, agentId, {
    linkedAt: new Date(createdAt),
  });
  bindControllerWallet(db, {
    account_id: account.account_id,
    agent_id: agentId,
    wallet_address: wallet,
    chain_id: "eip155:84532",
    wallet_kind: "embedded",
    provider: "privy",
    binding_message: "binding smoke",
    binding_signature: `0x${"11".repeat(65)}`,
    createdAt: new Date(createdAt),
  });

  const empty = listAccountRuntimeKeysResponse({
    db,
    accountId: account.account_id,
    slug: "runtime-key-agent",
    operationInstant: now(),
  });
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.keys, []);
  const emptyRes = new FakeAccountRuntimeKeyJsonResponse();
  sendAccountRuntimeKeyJsonResponse(emptyRes, empty);
  assert.equal(emptyRes.statusCode, 200);
  assert.deepEqual((emptyRes.body as typeof empty.body).keys, []);

  assert.throws(
    () =>
      runtimeKeyChallengeResponse({
        db,
        accountId: account.account_id,
        slug: "runtime-key-agent",
        body: { policy: { max_calls_per_hour: 0 } },
        newAuthorizationNonce: () => {
          throw new Error("invalid Runtime Key challenge should not mint nonce");
        },
        operationInstant: now(),
      }),
    (err) => err instanceof VerdictError && err.httpStatus === 400,
  );

  const challenge = runtimeKeyChallengeResponse({
    db,
    accountId: account.account_id,
    slug: "runtime-key-agent",
    body: {
      policy: { max_calls_per_hour: 7, feed_packets: true },
      expires_at: "2026-06-12T10:30:00Z",
    },
    newAuthorizationNonce: () => "runtime_surface_nonce_1",
    operationInstant: now(),
  });
  assert.equal(challenge.status, 200);
  assert.equal(challenge.body.agent_id, agentId);
  assert.equal(challenge.body.display_slug, "runtime-key-agent");
  assert.equal(challenge.body.controller_wallet_address, wallet);
  assert.equal(challenge.body.controller_chain_id, "eip155:84532");
  assert.equal(challenge.body.authorization_nonce, "runtime_surface_nonce_1");
  assert.equal(challenge.body.authorization_issued_at, "2026-06-12T10:00:00Z");
  assert.equal(challenge.body.expires_at, "2026-06-12T10:30:00Z");
  assert.match(challenge.body.message, /Murmur Runtime Key Authorization/);
  const challengeRes = new FakeAccountRuntimeKeyJsonResponse();
  sendAccountRuntimeKeyJsonResponse(challengeRes, challenge);
  assert.equal(challengeRes.statusCode, 200);
  assert.equal(
    (challengeRes.body as typeof challenge.body).display_slug,
    "runtime-key-agent",
  );

  const signature = await owner.signMessage({ message: challenge.body.message });
  const mintBody = {
    label: "production writer",
    policy: { max_calls_per_hour: 7, feed_packets: true },
    expires_at: challenge.body.expires_at,
    authorization_nonce: challenge.body.authorization_nonce,
    authorization_issued_at: challenge.body.authorization_issued_at,
    signature,
  };
  const mintedIds: string[] = [];
  const mintedSecrets: string[] = [];
  const newRuntimeKeyId = () => {
    const id = `runtime-key-smoke-id-${mintedIds.length + 1}`;
    mintedIds.push(id);
    return id;
  };
  const newRuntimeKeySecret = () => {
    const secret = `mrt_${String(mintedSecrets.length + 1).repeat(64).slice(0, 64)}`;
    mintedSecrets.push(secret);
    return secret;
  };

  await assert.rejects(
    () =>
      mintAccountRuntimeKeyResponse({
        db,
        accountId: account.account_id,
        slug: "runtime-key-agent",
        body: mintBody,
        operationInstant: now(),
        newRuntimeKeyId,
        newRuntimeKeySecret,
        verifySignature: async () => false,
      }),
    (err) => err instanceof VerdictError && err.httpStatus === 403,
  );
  assert.deepEqual(mintedIds, []);
  assert.deepEqual(mintedSecrets, []);

  // Kill switch engaged WHILE the mint awaits signature verification: the
  // engagement bulk-revokes existing keys, so a mint that resumes afterwards
  // would insert a fresh unrevoked key that survives the later release. The
  // post-verification recheck inside the insert transaction must reject it.
  await assert.rejects(
    () =>
      mintAccountRuntimeKeyResponse({
        db,
        accountId: account.account_id,
        slug: "runtime-key-agent",
        body: mintBody,
        operationInstant: now(),
        newRuntimeKeyId,
        newRuntimeKeySecret,
        verifySignature: async () => {
          engageAccountKillSwitch(db, {
            account_id: account.account_id,
            actor: "runtime-key-smoke",
            now,
          });
          return true; // signature itself is fine — the switch is the problem
        },
      }),
    (err) =>
      err instanceof VerdictError &&
      err.httpStatus === 403 &&
      err.code === "agent_credentials_disabled",
  );
  assert.deepEqual(mintedIds, [], "no key id may be consumed by a halted mint");
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM agent_runtime_keys WHERE account_id = ? AND revoked_at IS NULL").get(account.account_id) as { n: number } | undefined
      ? (db.prepare("SELECT COUNT(*) n FROM agent_runtime_keys WHERE account_id = ? AND revoked_at IS NULL").get(account.account_id) as { n: number }).n
      : 0,
    0,
    "no unrevoked key may exist after a mint raced the kill switch",
  );
  releaseAccountKillSwitch(db, {
    account_id: account.account_id,
    actor: "runtime-key-smoke",
    now,
  });

  const minted = await mintAccountRuntimeKeyResponse({
    db,
    accountId: account.account_id,
    slug: "runtime-key-agent",
    body: mintBody,
    operationInstant: now(),
    newRuntimeKeyId,
    newRuntimeKeySecret,
  });
  assert.equal(minted.status, 201);
  assert.equal(minted.body.runtime_key_id, "runtime-key-smoke-id-1");
  assert.equal(minted.body.secret, `mrt_${"1".repeat(64)}`);
  assert.equal(minted.body.runtime_key_prefix, minted.body.secret.slice(0, 12));
  assert.equal(minted.body.label, "production writer");
  assert.equal(minted.body.policy_hash, challenge.body.policy_hash);
  assert.equal(minted.body.created_at, "2026-06-12T10:00:00Z");
  assert.equal(minted.body.expires_at, "2026-06-12T10:30:00Z");
  const mintedRow = db
    .prepare(
      `SELECT created_at
       FROM agent_runtime_keys
       WHERE runtime_key_id = ?`,
    )
    .get(minted.body.runtime_key_id) as { created_at: string };
  assert.equal(mintedRow.created_at, "2026-06-12T10:00:00Z");
  assert.equal(
    minted.body.warning,
    "store this runtime key now — it is not retrievable later",
  );
  assert.deepEqual(mintedIds, ["runtime-key-smoke-id-1"]);
  assert.deepEqual(mintedSecrets, [`mrt_${"1".repeat(64)}`]);
  const mintedRes = new FakeAccountRuntimeKeyJsonResponse();
  sendAccountRuntimeKeyJsonResponse(mintedRes, minted);
  assert.equal(mintedRes.statusCode, 201);
  assert.equal(
    (mintedRes.body as typeof minted.body).runtime_key_prefix,
    minted.body.runtime_key_prefix,
  );

  await assert.rejects(
    () =>
      mintAccountRuntimeKeyResponse({
        db,
        accountId: account.account_id,
        slug: "runtime-key-agent",
        body: mintBody,
        operationInstant: now(),
        newRuntimeKeyId,
        newRuntimeKeySecret,
      }),
    (err) => err instanceof VerdictError && err.httpStatus === 409,
  );
  assert.deepEqual(mintedIds, ["runtime-key-smoke-id-1"]);
  assert.deepEqual(mintedSecrets, [`mrt_${"1".repeat(64)}`]);

  const listed = listAccountRuntimeKeysResponse({
    db,
    accountId: account.account_id,
    slug: "runtime-key-agent",
    operationInstant: now(),
  });
  assert.equal(listed.body.keys.length, 1);
  assert.equal(listed.body.keys[0].runtime_key_id, minted.body.runtime_key_id);
  assert.equal(listed.body.keys[0].runtime_key_prefix, minted.body.runtime_key_prefix);
  assert.equal(listed.body.keys[0].label, "production writer");
  assert.equal(listed.body.keys[0].policy.max_calls_per_hour, 7);
  assert.equal(listed.body.keys[0].policy.feed_packets, true);
  assert.equal(listed.body.keys[0].revoked_at, null);

  assert.throws(
    () =>
      revokeAccountRuntimeKeyResponse({
        db,
        accountId: account.account_id,
        keyId: minted.body.runtime_key_id,
        body: { reason: "x".repeat(161) },
        operationInstant: now(),
      }),
    (err) => err instanceof VerdictError && err.httpStatus === 400,
  );

  const revoked = revokeAccountRuntimeKeyResponse({
    db,
    accountId: account.account_id,
    keyId: minted.body.runtime_key_id,
    body: { reason: "owner rotation" },
    operationInstant: now(),
  });
  assert.equal(revoked.status, 200);
  assert.equal(revoked.body.revoked, true);
  const revokedRes = new FakeAccountRuntimeKeyJsonResponse();
  sendAccountRuntimeKeyJsonResponse(revokedRes, revoked);
  assert.equal(revokedRes.statusCode, 200);
  assert.equal((revokedRes.body as typeof revoked.body).revoked, true);

  const secondRevoke = revokeAccountRuntimeKeyResponse({
    db,
    accountId: account.account_id,
    keyId: minted.body.runtime_key_id,
    body: {},
    operationInstant: now(),
  });
  assert.equal(secondRevoke.body.revoked, false);

  const afterRevoke = listAccountRuntimeKeysResponse({
    db,
    accountId: account.account_id,
    slug: "runtime-key-agent",
    operationInstant: now(),
  });
  assert.equal(afterRevoke.body.keys[0].revoke_reason, "owner rotation");
  assert.equal(afterRevoke.body.keys[0].revoked_at, "2026-06-12T10:00:00Z");
  const revokedRow = db
    .prepare(
      `SELECT revoked_at, revoke_reason
       FROM agent_runtime_keys
       WHERE runtime_key_id = ?`,
    )
    .get(minted.body.runtime_key_id) as {
      revoked_at: string;
      revoke_reason: string;
    };
  assert.equal(revokedRow.revoked_at, "2026-06-12T10:00:00Z");
  assert.equal(revokedRow.revoke_reason, "owner rotation");

  db.close();
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

process.stdout.write("account Runtime Key surface smoke ok\n");
