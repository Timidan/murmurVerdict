import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  sendAccountDestinationJsonResponse,
  setAccountDestinationAddressResponse,
} from "./account-destination-surface.js";
import {
  getOrCreateAccount,
  linkAgentToAccount,
} from "./auth/accounts.js";
import {
  agentsRepo,
  openDb,
} from "./db.js";
import { VerdictError } from "./schema.js";
import { parseUsageEventAttributes } from "./usage-event.js";

class FakeAccountDestinationJsonResponse {
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

const tmp = mkdtempSync(join(tmpdir(), "murmur-account-destination-surface-"));
const dbPath = join(tmp, "test.db");

try {
  process.stdout.write("murmur account Destination Surface smoke\n");
  const db = openDb({ path: dbPath });
  let clock = new Date("2026-06-12T10:00:00Z");
  const now = () => clock;
  const emittedUsageEventIds: string[] = [];
  const newUsageEventId = () => {
    const id = [
      "55555555-5555-4555-8555-555555555555",
      "66666666-6666-4666-8666-666666666666",
    ][emittedUsageEventIds.length];
    assert.ok(id);
    emittedUsageEventIds.push(id);
    return id;
  };
  const agentId = randomUUID();
  const account = getOrCreateAccount(db, {
    privy_user_id: "did:privy:account-destination-surface",
    session_id: "account-destination-surface-session",
    expires_at: "2026-06-12T11:00:00Z",
  }, {
    resolvedAt: now(),
  });
  agentsRepo.insert(db, {
    agent_id: agentId,
    display_slug: "destination-agent",
    kind: "agent",
    display_name: "Destination Agent",
    created_at: "2026-06-12T09:50:00Z",
  });
  linkAgentToAccount(db, account.account_id, agentId, { linkedAt: now() });

  assert.throws(
    () =>
      setAccountDestinationAddressResponse({
        db,
        accountId: account.account_id,
        slug: "destination-agent",
        body: { destination_address: "0xABC" },
        newUsageEventId: () => {
          throw new Error("invalid destination body should not mint usage event id");
        },
        operationInstant: now(),
      }),
    (err) => err instanceof VerdictError && err.httpStatus === 400,
  );

  const first = setAccountDestinationAddressResponse({
    db,
    accountId: account.account_id,
    slug: "destination-agent",
    body: {
      destination_address: "0x1111111111111111111111111111111111111111",
    },
    destinationCooldownMs: 1_000,
    newUsageEventId,
    operationInstant: now(),
  });
  assert.equal(first.status, 200);
  assert.deepEqual(first.body, {
    agent_id: agentId,
    destination_address: "0x1111111111111111111111111111111111111111",
    destination_address_updated_at: "2026-06-12T10:00:00Z",
  });
  const firstRes = new FakeAccountDestinationJsonResponse();
  sendAccountDestinationJsonResponse(firstRes, first);
  assert.equal(firstRes.statusCode, 200);
  assert.equal(
    (firstRes.body as typeof first.body).destination_address,
    "0x1111111111111111111111111111111111111111",
  );
  const firstAgentRow = db
    .prepare(
      `SELECT destination_address, destination_address_updated_at
       FROM agents
       WHERE agent_id = ?`,
    )
    .get(agentId) as {
      destination_address: string | null;
      destination_address_updated_at: string | null;
    };
  assert.equal(
    firstAgentRow.destination_address,
    "0x1111111111111111111111111111111111111111",
  );
  assert.equal(
    firstAgentRow.destination_address_updated_at,
    "2026-06-12T10:00:00Z",
  );

  const usage = db.prepare(
    "SELECT event_id, agent_id, kind, ts, attributes_json FROM usage_events WHERE agent_id = ?",
  ).get(agentId) as
    | {
        event_id: string;
        agent_id: string;
        kind: string;
        ts: string;
        attributes_json: string;
      }
    | undefined;
  assert.ok(usage);
  assert.equal(usage.event_id, "55555555-5555-4555-8555-555555555555");
  assert.equal(usage.kind, "destination_address_updated");
  assert.equal(usage.ts, "2026-06-12T10:00:00Z");
  assert.deepEqual(parseUsageEventAttributes(usage.attributes_json), {
    previous_address: null,
    new_address: "0x1111111111111111111111111111111111111111",
    cooldown_ms: 1_000,
  });

  const cooldown = setAccountDestinationAddressResponse({
    db,
    accountId: account.account_id,
    slug: "destination-agent",
    body: {
      destination_address: "0x2222222222222222222222222222222222222222",
    },
    destinationCooldownMs: 1_000,
    newUsageEventId: () => {
      throw new Error("cooldown should not mint usage event id");
    },
    operationInstant: now(),
  });
  assert.equal(cooldown.status, 429);
  assert.deepEqual(cooldown.body, {
    error: "destination_address cooldown active",
    code: "rate_limited",
    retry_after_seconds: 1,
  });
  const cooldownRes = new FakeAccountDestinationJsonResponse();
  sendAccountDestinationJsonResponse(cooldownRes, cooldown);
  assert.equal(cooldownRes.statusCode, 429);
  assert.equal((cooldownRes.body as typeof cooldown.body).code, "rate_limited");

  clock = new Date("2026-06-12T10:00:02Z");
  const second = setAccountDestinationAddressResponse({
    db,
    accountId: account.account_id,
    slug: "destination-agent",
    body: {
      destination_address: "0x2222222222222222222222222222222222222222",
    },
    destinationCooldownMs: 1_000,
    newUsageEventId,
    operationInstant: now(),
  });
  assert.equal(second.status, 200);
  assert.equal(
    second.body.destination_address_updated_at,
    "2026-06-12T10:00:02Z",
  );
  const secondAgentRow = db
    .prepare(
      `SELECT destination_address, destination_address_updated_at
       FROM agents
       WHERE agent_id = ?`,
    )
    .get(agentId) as {
      destination_address: string | null;
      destination_address_updated_at: string | null;
    };
  assert.equal(
    secondAgentRow.destination_address,
    "0x2222222222222222222222222222222222222222",
  );
  assert.equal(
    secondAgentRow.destination_address_updated_at,
    "2026-06-12T10:00:02Z",
  );
  const usageCount = db.prepare(
    "SELECT COUNT(*) AS n FROM usage_events WHERE agent_id = ?",
  ).get(agentId) as { n: number };
  assert.equal(usageCount.n, 2);
  assert.deepEqual(emittedUsageEventIds, [
    "55555555-5555-4555-8555-555555555555",
    "66666666-6666-4666-8666-666666666666",
  ]);

  db.close();
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

process.stdout.write("account Destination Surface smoke ok\n");
