import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AdminClaimError,
  adminClaimAgent,
} from "./admin-claim-surface.js";
import { parseAgentSecurityEventPayload } from "./agent-security-event.js";
import { getAccountForAgent } from "./auth/accounts.js";
import { openDb } from "./db.js";
import { agentsRepo } from "./repos/agents-repo.js";

const tmp = mkdtempSync(join(tmpdir(), "murmur-admin-claim-surface-"));
const dbPath = join(tmp, "test.db");

try {
  process.stdout.write("murmur admin claim surface smoke\n");
  const db = openDb({ path: dbPath });
  const now = () => new Date("2026-06-12T09:30:00Z");
  const accountId = "00000000-0000-4000-8000-000000000101";
  const otherAccountId = "00000000-0000-4000-8000-000000000102";
  const agentIds: string[] = [];
  const securityEventIds: string[] = [];
  const newAgentId = () => {
    const id = "00000000-0000-4000-8000-000000000201";
    agentIds.push(id);
    return id;
  };
  const newAgentSecurityEventId = () => {
    const id = `00000000-0000-4000-8000-${String(301 + securityEventIds.length).padStart(12, "0")}`;
    securityEventIds.push(id);
    return id;
  };
  const unexpectedAgentId = () => {
    throw new Error("agent id adapter should not be called");
  };
  const unexpectedSecurityEventId = () => {
    throw new Error("agent security event id adapter should not be called");
  };

  insertAccount(db, {
    account_id: accountId,
    privy_user_id: "did:privy:claim-owner",
  });
  insertAccount(db, {
    account_id: otherAccountId,
    privy_user_id: "did:privy:other-owner",
  });

  assert.throws(
    () =>
      adminClaimAgent({
        db,
        account: accountId,
        slug: "Bad Slug",
        newAgentId: unexpectedAgentId,
        newAgentSecurityEventId: unexpectedSecurityEventId,
        now,
      }),
    (err) =>
      err instanceof AdminClaimError &&
      err.code === "invalid_input" &&
      err.exitCode === 2,
  );
  assert.deepEqual(agentIds, []);
  assert.deepEqual(securityEventIds, []);

  assert.throws(
    () =>
      adminClaimAgent({
        db,
        account: "00000000-0000-4000-8000-000000000999",
        slug: "claim-agent",
        newAgentId: unexpectedAgentId,
        newAgentSecurityEventId: unexpectedSecurityEventId,
        now,
      }),
    (err) =>
      err instanceof AdminClaimError &&
      err.code === "account_not_found" &&
      err.exitCode === 3,
  );

  const created = adminClaimAgent({
    db,
    account: "privy:did:privy:claim-owner",
    slug: "claim-agent",
    displayName: "Claim Agent",
    bio: "Operator recovery claim.",
    newAgentId,
    newAgentSecurityEventId,
    now,
  });
  assert.deepEqual(created, {
    ok: true,
    event_id: "00000000-0000-4000-8000-000000000301",
    agent_id: "00000000-0000-4000-8000-000000000201",
    account_id: accountId,
    slug: "claim-agent",
    created_agent: true,
  });
  const agent = agentsRepo.bySlug(db, "claim-agent");
  assert.equal(agent?.agent_id, created.agent_id);
  assert.equal(agent?.display_name, "Claim Agent");
  assert.equal(agent?.bio, "Operator recovery claim.");
  assert.equal(agent?.created_at, "2026-06-12T09:30:00Z");
  assert.equal(getAccountForAgent(db, created.agent_id), accountId);

  const repeated = adminClaimAgent({
    db,
    account: accountId,
    slug: "claim-agent",
    newAgentId: unexpectedAgentId,
    newAgentSecurityEventId,
    now,
  });
  assert.deepEqual(repeated, {
    ok: true,
    event_id: "00000000-0000-4000-8000-000000000302",
    agent_id: "00000000-0000-4000-8000-000000000201",
    account_id: accountId,
    slug: "claim-agent",
    created_agent: false,
  });
  assert.deepEqual(agentIds, ["00000000-0000-4000-8000-000000000201"]);
  assert.deepEqual(securityEventIds, [
    "00000000-0000-4000-8000-000000000301",
    "00000000-0000-4000-8000-000000000302",
  ]);

  assert.throws(
    () =>
      adminClaimAgent({
        db,
        account: otherAccountId,
        slug: "claim-agent",
        newAgentId: unexpectedAgentId,
        newAgentSecurityEventId: unexpectedSecurityEventId,
        now,
      }),
    (err) =>
      err instanceof AdminClaimError &&
      err.code === "agent_already_owned_by_another_account" &&
      err.exitCode === 4,
  );

  const auditRows = db.prepare(
    "SELECT event_id, payload_json FROM agent_security_events ORDER BY event_id",
  ).all() as Array<{ event_id: string; payload_json: string }>;
  assert.equal(auditRows.length, 2);
  assert.deepEqual(
    auditRows.map((row) => row.event_id),
    [
      "00000000-0000-4000-8000-000000000301",
      "00000000-0000-4000-8000-000000000302",
    ],
  );
  assert.deepEqual(parseAgentSecurityEventPayload(auditRows[0]?.payload_json ?? "{}"), {
    slug: "claim-agent",
    created_agent: true,
    display_name: "Claim Agent",
  });
  assert.deepEqual(parseAgentSecurityEventPayload(auditRows[1]?.payload_json ?? "{}"), {
    slug: "claim-agent",
    created_agent: false,
    display_name: null,
  });

  db.close();
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

process.stdout.write("admin claim surface smoke ok\n");

function insertAccount(
  db: ReturnType<typeof openDb>,
  input: { account_id: string; privy_user_id: string },
): void {
  db.prepare(
    `INSERT INTO accounts (
       account_id, privy_user_id, email, primary_login_method,
       created_at, last_seen_at
     ) VALUES (?, ?, NULL, ?, ?, ?)`,
  ).run(
    input.account_id,
    input.privy_user_id,
    "fixture",
    "2026-06-12T09:00:00Z",
    "2026-06-12T09:00:00Z",
  );
}
