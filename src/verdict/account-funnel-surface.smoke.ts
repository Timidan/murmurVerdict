import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  emitAccountFunnelEventResponse,
  sendAccountFunnelEmptyResponse,
} from "./account-funnel-surface.js";
import { parseUsageEventAttributes } from "./usage-event.js";
import {
  getOrCreateAccount,
} from "./auth/accounts.js";
import { openDb } from "./db.js";
import { VerdictError } from "./schema.js";

class FakeAccountFunnelEmptyResponse {
  ended = false;
  statusCode: number | null = null;

  status(code: number): { end: () => void } {
    this.statusCode = code;
    return {
      end: () => {
        this.ended = true;
      },
    };
  }
}

const tmp = mkdtempSync(join(tmpdir(), "murmur-account-funnel-surface-"));
const dbPath = join(tmp, "test.db");

try {
  process.stdout.write("murmur account Funnel Surface smoke\n");
  const db = openDb({ path: dbPath });
  const account = getOrCreateAccount(db, {
    privy_user_id: "did:privy:account-funnel-surface",
    session_id: "account-funnel-surface-session",
    expires_at: "2026-06-12T11:00:00Z",
  }, {
    resolvedAt: new Date("2026-06-12T10:00:00Z"),
  });
  const now = () => new Date("2026-06-12T10:00:00Z");
  const emittedUsageEventIds: string[] = [];
  const newUsageEventId = () => {
    const id = [
      "33333333-3333-4333-8333-333333333333",
      "44444444-4444-4444-8444-444444444444",
    ][emittedUsageEventIds.length];
    assert.ok(id);
    emittedUsageEventIds.push(id);
    return id;
  };

  assert.throws(
    () =>
      emitAccountFunnelEventResponse({
        db,
        accountId: account.account_id,
        body: { kind: "submission_accepted" },
        newUsageEventId: () => {
          throw new Error("invalid funnel event should not mint usage event id");
        },
        operationInstant: now(),
      }),
    (err) => err instanceof VerdictError && err.httpStatus === 400,
  );

  const result = emitAccountFunnelEventResponse({
    db,
    accountId: account.account_id,
    body: {
      kind: "privy.signed_in",
      attributes: {
        account_id: "caller-controlled",
        source: "dashboard",
      },
    },
    newUsageEventId,
    operationInstant: now(),
  });
  assert.equal(result.status, 204);
  const resultRes = new FakeAccountFunnelEmptyResponse();
  sendAccountFunnelEmptyResponse(resultRes, result);
  assert.equal(resultRes.statusCode, 204);
  assert.equal(resultRes.ended, true);

  const row = db.prepare(
    "SELECT event_id, agent_id, kind, ts, attributes_json FROM usage_events LIMIT 1",
  ).get() as {
    event_id: string;
    agent_id: string | null;
    kind: string;
    ts: string;
    attributes_json: string;
  };
  assert.equal(row.event_id, "33333333-3333-4333-8333-333333333333");
  assert.equal(row.agent_id, null);
  assert.equal(row.kind, "privy.signed_in");
  assert.equal(row.ts, "2026-06-12T10:00:00Z");
  assert.deepEqual(parseUsageEventAttributes(row.attributes_json), {
    account_id: account.account_id,
    source: "dashboard",
  });

  emitAccountFunnelEventResponse({
    db,
    accountId: account.account_id,
    body: { kind: "call.tenth_submitted" },
    newUsageEventId,
    operationInstant: now(),
  });
  const count = db.prepare("SELECT COUNT(*) AS n FROM usage_events").get() as {
    n: number;
  };
  assert.equal(count.n, 2);
  assert.deepEqual(emittedUsageEventIds, [
    "33333333-3333-4333-8333-333333333333",
    "44444444-4444-4444-8444-444444444444",
  ]);

  db.close();
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

process.stdout.write("account Funnel Surface smoke ok\n");
