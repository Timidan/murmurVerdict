import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb } from "./db.js";
import {
  normalizeRevealSource,
  readAccountAgentReveals,
  revealDeadline,
  type AccountRevealRow,
} from "./account-agent-reveals-surface.js";
import { VerdictError } from "./schema.js";

// ─── The reveal duty list ───────────────────────────────────────────────────
//
// Two things here are easy to get quietly wrong, and both mislead the owner in
// the same direction — by making a discharged duty look outstanding, or an
// outstanding one look safe.
//
//   1. THE DEADLINE. It is reveal_open_at plus the CONFIGURED grace, and the
//      grace is an operator setting (FHENIX_REVEAL_WORKER_GRACE_SEC) whose
//      loader default is 300. Hardcoding 300 here would print a deadline the
//      worker does not honour on any deployment that overrode it. Where no
//      fallback worker runs at all, there is no such moment, and the honest
//      answer is null rather than a number.
//
//   2. MISSING ATTRIBUTION IS NOT PENDING. Rows sealed before migration 057
//      carry a NULL reveal_source even though they were revealed. Folding that
//      into "pending" would show the owner a duty that is already done.
//      "unknown" says what is actually true: it happened, and murmur cannot
//      say who did it.
process.stdout.write("murmur account agent reveals smoke\n");

const NOW_ISO = "2026-08-11T09:00:00Z";
const CHAIN_ID = 84532;
const CONTRACT = "0x1b74a4bab1e06ed107780a245c85337ab9decd1a";

type Db = ReturnType<typeof openDb>;

interface Harness {
  db: Db;
  tmp: string;
  agentId: string;
  accountId: string;
  slug: string;
}

function newHarness(): Harness {
  const tmp = mkdtempSync(join(tmpdir(), "account-reveals-"));
  const db = openDb({ path: join(tmp, `${randomUUID()}.db`) });
  const agentId = randomUUID();
  const accountId = randomUUID();
  const slug = `revealer-${agentId.slice(0, 8)}`;
  db.prepare(
    `INSERT INTO agents (agent_id, display_slug, kind, display_name, bio, created_at)
     VALUES (?, ?, 'agent', 'Revealing Agent', NULL, ?)`,
  ).run(agentId, slug, NOW_ISO);
  db.prepare(
    `INSERT INTO accounts (account_id, privy_user_id, created_at, last_seen_at)
     VALUES (?, ?, ?, ?)`,
  ).run(accountId, `privy-${accountId}`, NOW_ISO, NOW_ISO);
  db.prepare(
    "INSERT INTO account_agents (account_id, agent_id, created_at) VALUES (?, ?, ?)",
  ).run(accountId, agentId, NOW_ISO);
  return { db, tmp, agentId, accountId, slug };
}

function close(h: Harness): void {
  h.db.close();
  rmSync(h.tmp, { recursive: true, force: true });
}

function seedCall(
  h: Harness,
  input: {
    onchainCallId: string;
    revealOpenAt: string;
    revealStatus: "pending" | "revealed" | "invalid" | "missed";
    revealSource: string | null;
    revealedAt?: string | null;
    agentId?: string;
  },
): string {
  const callId = randomUUID();
  h.db
    .prepare(
      `INSERT INTO submissions
         (call_id, agent_id, client_order_id, submitted_at, accepted_at,
          schema_version, scoring_version, dedup_key, status, horizon_seconds)
       VALUES (?, ?, ?, ?, ?, 1, 1, ?, 'pending_t1', 3600)`,
    )
    .run(
      callId,
      input.agentId ?? h.agentId,
      `order-${callId}`,
      NOW_ISO,
      NOW_ISO,
      `dedup-${callId}`,
    );
  h.db
    .prepare(
      `INSERT INTO fhenix_sealed_calls
         (call_id, chain_id, contract_address, onchain_call_id, submit_tx_hash,
          submit_log_index, binary_index_ct_hash, confidence_ct_hash,
          reveal_open_at, submission_class, created_at, reveal_status,
          reveal_source, revealed_at)
       VALUES (?, ?, ?, ?, ?, 0, '0x01', '0x02', ?, 1, ?, ?, ?, ?)`,
    )
    .run(
      callId,
      CHAIN_ID,
      CONTRACT,
      input.onchainCallId,
      `0xtx-${callId}`,
      input.revealOpenAt,
      NOW_ISO,
      input.revealStatus,
      input.revealSource,
      input.revealedAt ?? null,
    );
  return callId;
}

// ── 1. The deadline follows the CONFIGURED grace, never a constant ─────────
{
  assert.equal(revealDeadline("2026-08-11T09:00:00Z", 300), "2026-08-11T09:05:00Z");
  assert.equal(revealDeadline("2026-08-11T09:00:00Z", 900), "2026-08-11T09:15:00Z");
  assert.equal(revealDeadline("2026-08-11T09:00:00Z", 0), "2026-08-11T09:00:00Z");
  // No worker configured → no deadline to state.
  assert.equal(revealDeadline("2026-08-11T09:00:00Z", null), null);
  assert.equal(revealDeadline("not-a-date", 300), null);
}

// ── 2. The source enum, in full, with the two absences kept distinct ───────
{
  assert.equal(normalizeRevealSource("revealed", "agent"), "agent");
  assert.equal(normalizeRevealSource("revealed", "daemon_fallback"), "daemon_fallback");
  assert.equal(
    normalizeRevealSource("revealed", "unattributed_external"),
    "unattributed_external",
  );
  // Revealed but unattributed (pre-057) — "unknown", NOT "pending".
  assert.equal(normalizeRevealSource("revealed", null), "unknown");
  assert.equal(normalizeRevealSource("invalid", null), "unknown");
  assert.equal(normalizeRevealSource("missed", null), "unknown");
  // Genuinely not revealed yet — the only thing "pending" ever means here.
  assert.equal(normalizeRevealSource("pending", null), "pending");
}

// ── 3. The rendered list ───────────────────────────────────────────────────
{
  const h = newHarness();
  seedCall(h, {
    onchainCallId: "0xaaa1",
    revealOpenAt: "2026-08-11T12:00:00Z",
    revealStatus: "pending",
    revealSource: null,
  });
  seedCall(h, {
    onchainCallId: "0xaaa2",
    revealOpenAt: "2026-08-11T11:00:00Z",
    revealStatus: "revealed",
    revealSource: "agent",
    revealedAt: "2026-08-11T11:02:00Z",
  });
  seedCall(h, {
    onchainCallId: "0xaaa3",
    revealOpenAt: "2026-08-11T10:00:00Z",
    revealStatus: "revealed",
    revealSource: "daemon_fallback",
    revealedAt: "2026-08-11T10:20:00Z",
  });
  seedCall(h, {
    onchainCallId: "0xaaa4",
    revealOpenAt: "2026-08-11T09:00:00Z",
    revealStatus: "revealed",
    revealSource: "unattributed_external",
    revealedAt: "2026-08-11T09:30:00Z",
  });
  // The pre-attribution row.
  seedCall(h, {
    onchainCallId: "0xaaa5",
    revealOpenAt: "2026-08-11T08:00:00Z",
    revealStatus: "revealed",
    revealSource: null,
    revealedAt: "2026-08-11T08:10:00Z",
  });

  const out = readAccountAgentReveals({
    db: h.db,
    accountId: h.accountId,
    slug: h.slug,
    revealGraceSeconds: 900,
  });
  assert.equal(out.status, 200);
  const body = out.body as {
    agent_slug: string;
    reveals: AccountRevealRow[];
    fallback: { enabled: boolean; grace_seconds: number | null };
  };
  assert.equal(body.agent_slug, h.slug);
  assert.equal(body.reveals.length, 5);
  // Newest window first.
  assert.deepEqual(
    body.reveals.map((r) => r.onchain_call_id),
    ["0xaaa1", "0xaaa2", "0xaaa3", "0xaaa4", "0xaaa5"],
  );
  assert.deepEqual(
    body.reveals.map((r) => r.reveal_source),
    ["pending", "agent", "daemon_fallback", "unattributed_external", "unknown"],
  );
  assert.equal(body.reveals[0]!.deadline, "2026-08-11T12:15:00Z");
  assert.equal(body.fallback.enabled, true);
  assert.equal(body.fallback.grace_seconds, 900);

  // No worker → every deadline is null and the copy says so.
  const noWorker = readAccountAgentReveals({
    db: h.db,
    accountId: h.accountId,
    slug: h.slug,
    revealGraceSeconds: null,
  }).body as {
    reveals: AccountRevealRow[];
    fallback: { enabled: boolean; grace_seconds: number | null; note: string };
  };
  assert.ok(noWorker.reveals.every((r) => r.deadline === null));
  assert.equal(noWorker.fallback.enabled, false);
  assert.equal(noWorker.fallback.grace_seconds, null);
  assert.match(noWorker.fallback.note, /no fallback reveal worker/);

  // Paging.
  const paged = readAccountAgentReveals({
    db: h.db,
    accountId: h.accountId,
    slug: h.slug,
    revealGraceSeconds: 300,
    limit: 2,
    offset: 1,
  }).body as { reveals: AccountRevealRow[]; page: { returned: number } };
  assert.equal(paged.page.returned, 2);
  assert.deepEqual(
    paged.reveals.map((r) => r.onchain_call_id),
    ["0xaaa2", "0xaaa3"],
  );
  close(h);
}

// ── 4. Another agent's calls never appear, and neither does anyone else's ──
{
  const h = newHarness();
  const otherAgent = randomUUID();
  h.db
    .prepare(
      `INSERT INTO agents (agent_id, display_slug, kind, display_name, bio, created_at)
       VALUES (?, ?, 'agent', 'Other', NULL, ?)`,
    )
    .run(otherAgent, `other-${otherAgent.slice(0, 8)}`, NOW_ISO);
  seedCall(h, {
    onchainCallId: "0xmine",
    revealOpenAt: "2026-08-11T12:00:00Z",
    revealStatus: "pending",
    revealSource: null,
  });
  seedCall(h, {
    onchainCallId: "0xtheirs",
    revealOpenAt: "2026-08-11T13:00:00Z",
    revealStatus: "pending",
    revealSource: null,
    agentId: otherAgent,
  });

  const mine = readAccountAgentReveals({
    db: h.db,
    accountId: h.accountId,
    slug: h.slug,
    revealGraceSeconds: 300,
  }).body as { reveals: AccountRevealRow[] };
  assert.deepEqual(mine.reveals.map((r) => r.onchain_call_id), ["0xmine"]);

  let threw = false;
  try {
    readAccountAgentReveals({
      db: h.db,
      accountId: randomUUID(),
      slug: h.slug,
      revealGraceSeconds: 300,
    });
  } catch (err) {
    threw = true;
    assert.ok(err instanceof VerdictError);
    assert.equal(err.code, "agent_not_authorized");
    assert.equal(err.httpStatus, 403);
  }
  assert.ok(threw, "another account must not read this agent's duty list");
  close(h);
}

process.stdout.write("account agent reveals smoke OK\n");
