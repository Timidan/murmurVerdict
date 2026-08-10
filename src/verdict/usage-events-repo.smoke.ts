import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb } from "./db.js";
import { agentsRepo } from "./repos/agents-repo.js";
import { usageRepo } from "./repos/usage-events-repo.js";
import { makeUsageEvent } from "./usage-event.js";

const tmp = mkdtempSync(join(tmpdir(), "murmur-usage-events-repo-"));
const dbPath = join(tmp, "test.db");

try {
  const db = openDb({ path: dbPath });
  const agentId = randomUUID();
  agentsRepo.insert(db, {
    agent_id: agentId,
    display_slug: "usage-repo",
    kind: "agent",
    display_name: "Usage Repo",
    created_at: "2026-06-12T09:00:00Z",
  });
  usageRepo.emit(db, makeUsageEvent({
    agent_id: agentId,
    kind: "submission_accepted",
    occurredAt: new Date("2026-06-12T09:00:00Z"),
  }));
  usageRepo.emit(db, makeUsageEvent({
    agent_id: agentId,
    kind: "submission_accepted",
    occurredAt: new Date("2026-06-10T09:00:00Z"),
  }));

  assert.equal(
    usageRepo.count24h(
      db,
      "submission_accepted",
      new Date("2026-06-12T09:30:00Z"),
    ),
    1,
  );

  db.close();
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

process.stdout.write("usage events repo smoke ok\n");
