import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  deleteRevokedAccountApiKeyResponse,
  listAgentApiKeysResponse,
  mintAgentApiKeyResponse,
  rotateAccountApiKeyResponse,
  sendAccountApiKeyJsonResponse,
} from "./account-api-key-surface.js";
import {
  getOrCreateAccount,
  linkAgentToAccount,
} from "./auth/accounts.js";
import {
  agentsRepo,
  openDb,
} from "./db.js";
import { VerdictError } from "./schema.js";

class FakeAccountApiKeyJsonResponse {
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

const tmp = mkdtempSync(join(tmpdir(), "murmur-account-api-key-surface-"));
const dbPath = join(tmp, "test.db");

try {
  process.stdout.write("murmur account API key surface smoke\n");
  const db = openDb({ path: dbPath });
  const agentId = randomUUID();
  const peerAgentId = randomUUID();
  const foreignAgentId = randomUUID();
  const createdAt = "2026-06-12T10:00:00Z";
  const now = () => new Date(createdAt);

  agentsRepo.insert(db, {
    agent_id: agentId,
    display_slug: "account-key-agent",
    kind: "agent",
    display_name: "Account Key Agent",
    created_at: createdAt,
  });
  agentsRepo.insert(db, {
    agent_id: peerAgentId,
    display_slug: "account-key-peer",
    kind: "agent",
    display_name: "Account Key Peer",
    created_at: createdAt,
  });
  agentsRepo.insert(db, {
    agent_id: foreignAgentId,
    display_slug: "foreign-key-agent",
    kind: "agent",
    display_name: "Foreign Key Agent",
    created_at: createdAt,
  });
  const account = getOrCreateAccount(db, {
    privy_user_id: "did:privy:account-api-key-surface",
    session_id: "account-api-key-surface-session",
    expires_at: "2026-06-12T11:00:00Z",
  }, {
    resolvedAt: now(),
  });
  const foreignAccount = getOrCreateAccount(db, {
    privy_user_id: "did:privy:foreign-account-api-key-surface",
    session_id: "foreign-account-api-key-surface-session",
    expires_at: "2026-06-12T11:00:00Z",
  }, {
    resolvedAt: now(),
  });
  linkAgentToAccount(db, account.account_id, agentId, { linkedAt: now() });
  linkAgentToAccount(db, account.account_id, peerAgentId, { linkedAt: now() });
  linkAgentToAccount(db, foreignAccount.account_id, foreignAgentId, {
    linkedAt: now(),
  });

  const empty = listAgentApiKeysResponse({
    db,
    accountId: account.account_id,
    slug: "account-key-agent",
  });
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.keys, []);
  const emptyRes = new FakeAccountApiKeyJsonResponse();
  sendAccountApiKeyJsonResponse(emptyRes, empty);
  assert.equal(emptyRes.statusCode, 200);
  assert.deepEqual((emptyRes.body as typeof empty.body).keys, []);

  assert.throws(
    () =>
      mintAgentApiKeyResponse({
        db,
        accountId: account.account_id,
        slug: "account-key-agent",
        body: { label: "x".repeat(81) },
        newApiKeyId: () => {
          throw new Error("invalid mint should not request an API key id");
        },
        newApiKeySecret: () => {
          throw new Error("invalid mint should not request an API key secret");
        },
        operationInstant: now(),
      }),
    (err) => err instanceof VerdictError && err.httpStatus === 400,
  );

  const mintedIds: string[] = [];
  const mintedSecrets: string[] = [];
  const newApiKeyId = () => {
    const id = `account-api-key-smoke-id-${mintedIds.length + 1}`;
    mintedIds.push(id);
    return id;
  };
  const newApiKeySecret = () => {
    const secret = `account-api-key-smoke-secret-${mintedSecrets.length + 1}`;
    mintedSecrets.push(secret);
    return secret;
  };
  const minted = mintAgentApiKeyResponse({
    db,
    accountId: account.account_id,
    slug: "account-key-agent",
    body: { label: "runtime predecessor" },
    newApiKeyId,
    newApiKeySecret,
    operationInstant: now(),
  });
  assert.equal(minted.status, 201);
  assert.equal(minted.body.api_key_id, "account-api-key-smoke-id-1");
  assert.equal(minted.body.secret, "account-api-key-smoke-secret-1");
  assert.equal(minted.body.created_at, createdAt);
  assert.equal(
    minted.body.warning,
    "store this secret now — it is not retrievable later",
  );
  assert.deepEqual(mintedIds, ["account-api-key-smoke-id-1"]);
  assert.deepEqual(mintedSecrets, ["account-api-key-smoke-secret-1"]);
  const mintedRow = db
    .prepare(
      `SELECT account_id, agent_id, label, created_at, rotated_at
       FROM api_keys
       WHERE api_key_id = ?`,
    )
    .get(minted.body.api_key_id) as {
      account_id: string;
      agent_id: string;
      label: string | null;
      created_at: string;
      rotated_at: string | null;
    };
  assert.equal(mintedRow.account_id, account.account_id);
  assert.equal(mintedRow.agent_id, agentId);
  assert.equal(mintedRow.label, "runtime predecessor");
  assert.equal(mintedRow.created_at, createdAt);
  assert.equal(mintedRow.rotated_at, null);
  const mintedRes = new FakeAccountApiKeyJsonResponse();
  sendAccountApiKeyJsonResponse(mintedRes, minted);
  assert.equal(mintedRes.statusCode, 201);
  assert.equal(
    (mintedRes.body as typeof minted.body).api_key_id,
    minted.body.api_key_id,
  );
  const peerMinted = mintAgentApiKeyResponse({
    db,
    accountId: account.account_id,
    slug: "account-key-peer",
    body: { label: "peer runtime predecessor" },
    operationInstant: now(),
  });
  const foreignMinted = mintAgentApiKeyResponse({
    db,
    accountId: foreignAccount.account_id,
    slug: "foreign-key-agent",
    body: { label: "foreign runtime predecessor" },
    operationInstant: now(),
  });

  const listed = listAgentApiKeysResponse({
    db,
    accountId: account.account_id,
    slug: "account-key-agent",
  });
  assert.equal(listed.body.keys.length, 1);
  assert.deepEqual(Object.keys(listed.body.keys[0]).sort(), [
    "api_key_id",
    "created_at",
    "label",
    "rotated_at",
  ]);
  assert.equal(listed.body.keys[0].api_key_id, minted.body.api_key_id);
  assert.equal(listed.body.keys[0].label, "runtime predecessor");
  assert.equal(listed.body.keys[0].rotated_at, null);
  assert.notEqual(listed.body.keys[0].api_key_id, peerMinted.body.api_key_id);

  assert.throws(
    () =>
      rotateAccountApiKeyResponse({
        db,
        accountId: account.account_id,
        keyId: "not-owned",
        operationInstant: now(),
      }),
    (err) => err instanceof VerdictError && err.httpStatus === 403,
  );
  assert.throws(
    () =>
      rotateAccountApiKeyResponse({
        db,
        accountId: account.account_id,
        keyId: foreignMinted.body.api_key_id,
        operationInstant: now(),
      }),
    (err) => err instanceof VerdictError && err.httpStatus === 403,
  );

  assert.throws(() => deleteRevokedAccountApiKeyResponse({ db, accountId: account.account_id,
    keyId: minted.body.api_key_id, body: { confirm: minted.body.api_key_id } }),
    (err) => err instanceof VerdictError && err.httpStatus === 409);
  assert.throws(() => deleteRevokedAccountApiKeyResponse({ db, accountId: foreignAccount.account_id,
    keyId: minted.body.api_key_id, body: { confirm: minted.body.api_key_id } }),
    (err) => err instanceof VerdictError && err.httpStatus === 403);

  const firstRotate = rotateAccountApiKeyResponse({
    db,
    accountId: account.account_id,
    keyId: minted.body.api_key_id,
    operationInstant: now(),
  });
  assert.equal(firstRotate.status, 200);
  assert.equal(firstRotate.body.rotated, true);
  const rotateRes = new FakeAccountApiKeyJsonResponse();
  sendAccountApiKeyJsonResponse(rotateRes, firstRotate);
  assert.equal(rotateRes.statusCode, 200);
  assert.equal((rotateRes.body as typeof firstRotate.body).rotated, true);
  const rotatedRow = db
    .prepare(
      `SELECT created_at, rotated_at
       FROM api_keys
       WHERE api_key_id = ?`,
    )
    .get(minted.body.api_key_id) as {
      created_at: string;
      rotated_at: string | null;
    };
  assert.equal(rotatedRow.created_at, createdAt);
  assert.equal(rotatedRow.rotated_at, createdAt);

  const secondRotate = rotateAccountApiKeyResponse({
    db,
    accountId: account.account_id,
    keyId: minted.body.api_key_id,
    operationInstant: now(),
  });
  assert.equal(secondRotate.body.rotated, false);

  const afterRotate = listAgentApiKeysResponse({
    db,
    accountId: account.account_id,
    slug: "account-key-agent",
  });
  assert.equal(afterRotate.body.keys.length, 1);
  assert.equal(afterRotate.body.keys[0].rotated_at, createdAt);

  assert.equal(deleteRevokedAccountApiKeyResponse({ db, accountId: account.account_id,
    keyId: minted.body.api_key_id, body: { confirm: minted.body.api_key_id } }).body.deleted, true);
  assert.equal(listAgentApiKeysResponse({ db, accountId: account.account_id, slug: "account-key-agent" }).body.keys.length, 0);
  assert.equal(listAgentApiKeysResponse({ db, accountId: account.account_id, slug: "account-key-peer" }).body.keys.length, 1);
  db.close();
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

process.stdout.write("account API key surface smoke ok\n");
