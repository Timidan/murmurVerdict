import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createAccountAgentResponse,
  listAccountAgentsResponse,
  sendAccountAgentJsonResponse,
} from "./account-agent-surface.js";
import {
  bindControllerWallet,
  getOrCreateAccount,
} from "./auth/accounts.js";
import { openDb } from "./db.js";
import { VerdictError } from "./schema.js";

class FakeAccountAgentJsonResponse {
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

const tmp = mkdtempSync(join(tmpdir(), "murmur-account-agent-surface-"));
const dbPath = join(tmp, "test.db");

try {
  process.stdout.write("murmur account Agent surface smoke\n");
  const db = openDb({ path: dbPath });
  const now = () => new Date("2026-06-12T10:00:00Z");
  const servedAt = now();
  const account = getOrCreateAccount(db, {
    privy_user_id: "did:privy:account-agent-surface",
    session_id: "account-agent-surface-session",
    expires_at: "2026-06-12T11:00:00Z",
  }, {
    resolvedAt: now(),
  });

  const empty = listAccountAgentsResponse({
    db,
    accountId: account.account_id,
    servedAt,
  });
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.agents, []);
  const emptyRes = new FakeAccountAgentJsonResponse();
  sendAccountAgentJsonResponse(emptyRes, empty);
  assert.equal(emptyRes.statusCode, 200);
  assert.deepEqual((emptyRes.body as typeof empty.body).agents, []);

  assert.throws(
    () =>
      createAccountAgentResponse({
        db,
        accountId: account.account_id,
        body: {
          display_slug: "xx",
          display_name: "Too Short",
        },
        newAgentId: () => {
          throw new Error("invalid agent create should not mint agent id");
        },
        operationInstant: now(),
      }),
    (err) => err instanceof VerdictError && err.httpStatus === 400,
  );

  const first = createAccountAgentResponse({
    db,
    accountId: account.account_id,
    newAgentId: () => "11111111-1111-4111-8111-111111111111",
    body: {
      display_slug: "agent-surface",
      display_name: "Agent Surface",
      bio: "Owns account-facing profile setup.",
    },
    operationInstant: now(),
  });
  assert.equal(first.status, 201);
  assert.deepEqual(first.body, {
    agent_id: "11111111-1111-4111-8111-111111111111",
    display_slug: "agent-surface",
    display_name: "Agent Surface",
    kind: "agent",
    created_at: "2026-06-12T10:00:00Z",
  });
  const firstRes = new FakeAccountAgentJsonResponse();
  sendAccountAgentJsonResponse(firstRes, first);
  assert.equal(firstRes.statusCode, 201);
  assert.equal((firstRes.body as typeof first.body).display_slug, "agent-surface");

  assert.throws(
    () =>
      createAccountAgentResponse({
        db,
        accountId: account.account_id,
        newAgentId: () => "22222222-2222-4222-8222-222222222222",
        body: {
          display_slug: "agent-surface",
          display_name: "Duplicate Slug",
        },
        operationInstant: now(),
      }),
    (err) => err instanceof VerdictError && err.httpStatus === 409,
  );

  const second = createAccountAgentResponse({
    db,
    accountId: account.account_id,
    newAgentId: () => "33333333-3333-4333-8333-333333333333",
    body: {
      display_slug: "agent-surface-two",
      display_name: "Agent Surface Two",
    },
    operationInstant: now(),
  });
  const wallet = "0x1111111111111111111111111111111111111111";
  bindControllerWallet(db, {
    account_id: account.account_id,
    agent_id: second.body.agent_id,
    wallet_address: wallet,
    chain_id: "eip155:84532",
    wallet_kind: "embedded",
    provider: "privy",
    binding_message: "binding smoke",
    binding_signature: `0x${"11".repeat(65)}`,
    createdAt: new Date("2026-06-12T10:00:00Z"),
  });
  db.prepare(
    `UPDATE agents
     SET destination_address = ?, destination_address_updated_at = ?
     WHERE agent_id = ?`,
  ).run(
    "0x2222222222222222222222222222222222222222",
    "2026-06-12T10:05:00Z",
    second.body.agent_id,
  );

  const listed = listAccountAgentsResponse({
    db,
    accountId: account.account_id,
    servedAt,
  });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.agents.length, 2);
  const firstListed = listed.body.agents.find((agent) => agent.agent_id === first.body.agent_id);
  assert.ok(firstListed);
  assert.equal(firstListed.display_slug, "agent-surface");
  assert.equal(firstListed.linked_at, "2026-06-12T10:00:00Z");
  assert.equal(firstListed.controller_wallet, null);
  assert.equal(firstListed.destination_address, null);

  const secondListed = listed.body.agents.find((agent) => agent.agent_id === second.body.agent_id);
  assert.ok(secondListed);
  assert.equal(secondListed.display_slug, "agent-surface-two");
  assert.equal(secondListed.linked_at, "2026-06-12T10:00:00Z");
  assert.equal(secondListed.wallet_address, wallet);
  assert.equal(secondListed.chain_id, "eip155:84532");
  assert.equal(secondListed.controller_wallet?.wallet_address, wallet);
  assert.equal(secondListed.controller_wallet?.reattestation_due_at, "2026-06-26T10:00:00Z");
  assert.equal(secondListed.destination_address, "0x2222222222222222222222222222222222222222");
  assert.equal(secondListed.destination_address_updated_at, "2026-06-12T10:05:00Z");
  const listedRes = new FakeAccountAgentJsonResponse();
  sendAccountAgentJsonResponse(listedRes, listed);
  assert.equal(listedRes.statusCode, 200);
  assert.equal((listedRes.body as typeof listed.body).agents.length, 2);

  db.close();
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

process.stdout.write("account Agent surface smoke ok\n");
