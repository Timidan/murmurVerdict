import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { reserveSealedCallAttempt } from "../integrations/fhenix-gateway-reservations.js";
import { openDb } from "./db.js";
import {
  retireAccountAgent,
  unretireAccountAgent,
  updateAccountAgentProfile,
  deactivateAccountSurface,
  deleteAccountAgent,
} from "./account-agent-lifecycle-surface.js";
import { listAccountAgentsWithSetup } from "./auth/account-ownership.js";
import { mintApiKey, verifyApiKey } from "./auth/api-keys.js";
import { mintRuntimeKey, verifyRuntimeKey } from "./auth/runtime-keys.js";
import { mintAgentApiKeyResponse } from "./account-api-key-surface.js";
import { __resolveCasualIdentity } from "./auth/dispatcher.js";
import { readAccountAgentReveals } from "./account-agent-reveals-surface.js";
import { readProviderEarnings } from "./provider-earnings-surface.js";
import {
  accountDeactivatedAt,
  assertAgentAcceptingCalls,
} from "./auth/account-lifecycle.js";
import {
  agentCredentialsDisabledAt,
  releaseAccountKillSwitch,
} from "./auth/account-kill-switch.js";
import { reparentAccount } from "./auth/account-reparent.js";
import { agentsRepo } from "./repos/agents-repo.js";
import { VerdictError } from "./schema.js";

// ─── Ending things ──────────────────────────────────────────────────────────
//
// Retirement and deactivation both mean "stop", and both fail in the same
// direction if they are sloppy: a stop that does not stop.
//
// The retirement gate's POSITION is the substance of the feature, so it is
// asserted structurally as well as behaviourally. Retirement must refuse a NEW
// reservation from inside the reservation's own transaction, and must not
// touch anything else:
//
//   · not the duplicate exit  — a retry for work already accepted still
//                               resolves to its existing attempt
//   · not runtime-key auth    — attempt READS go through it, and an owner must
//                               keep reading a retired agent's history
//   · not post-chain accept   — a call already broadcast has to be recorded,
//                               or retiring mid-flight orphans a confirmed
//                               on-chain call
//
// Deactivation's failure mode is subtler and worse: it engages the kill
// switch, and the kill switch has a RELEASE route. If closure lived in the
// kill-switch column, release would reopen a closed account. The two columns
// and the two guards are what stop that, and both are asserted below —
// including across an account MERGE, where a permissive backfill would drop
// the marker entirely.
process.stdout.write("murmur account lifecycle smoke\n");

const NOW = new Date("2026-08-11T09:00:00.000Z");
const NOW_ISO = "2026-08-11T09:00:00Z";
const HERE = dirname(fileURLToPath(import.meta.url));

type Db = ReturnType<typeof openDb>;

interface Harness {
  db: Db;
  tmp: string;
  agentId: string;
  accountId: string;
  slug: string;
}

function newHarness(): Harness {
  const tmp = mkdtempSync(join(tmpdir(), "account-lifecycle-"));
  const db = openDb({ path: join(tmp, `${randomUUID()}.db`) });
  const h: Harness = {
    db,
    tmp,
    agentId: "",
    accountId: "",
    slug: "",
  };
  const seeded = seedAccount(h, "primary");
  h.agentId = seeded.agentId;
  h.accountId = seeded.accountId;
  h.slug = seeded.slug;
  return h;
}

function seedAccount(
  h: { db: Db },
  label: string,
): { accountId: string; agentId: string; slug: string; privyId: string } {
  const accountId = randomUUID();
  const agentId = randomUUID();
  const slug = `${label}-${agentId.slice(0, 8)}`;
  const privyId = `privy-${accountId}`;
  h.db
    .prepare(
      `INSERT INTO agents (agent_id, display_slug, kind, display_name, bio, created_at)
       VALUES (?, ?, 'agent', 'Lifecycle Agent', 'before', ?)`,
    )
    .run(agentId, slug, NOW_ISO);
  h.db
    .prepare(
      `INSERT INTO accounts (account_id, privy_user_id, email, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(accountId, privyId, `${label}@example.com`, NOW_ISO, NOW_ISO);
  h.db
    .prepare(
      "INSERT INTO account_agents (account_id, agent_id, created_at) VALUES (?, ?, ?)",
    )
    .run(accountId, agentId, NOW_ISO);
  return { accountId, agentId, slug, privyId };
}

function close(h: Harness): void {
  h.db.close();
  rmSync(h.tmp, { recursive: true, force: true });
}

function expectVerdictError(fn: () => unknown, code: string, status: number): VerdictError {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof VerdictError, `expected VerdictError, got ${String(err)}`);
    assert.equal(err.code, code);
    assert.equal(err.httpStatus, status);
    return err;
  }
  throw new Error("expected a VerdictError, but the call succeeded");
}

// ── 1. Retire / unretire, and the marker's timestamp ───────────────────────
{
  const h = newHarness();
  const sibling = seedAccount(h, "sibling");
  h.db.prepare("UPDATE account_agents SET account_id = ? WHERE agent_id = ?").run(h.accountId, sibling.agentId);
  const key = mintApiKey(h.db, { account_id: h.accountId, agent_id: h.agentId, createdAt: NOW });
  const siblingKey = mintApiKey(h.db, { account_id: h.accountId, agent_id: sibling.agentId, createdAt: NOW });
  const runtime = mintRuntimeKey(h.db, {
    account_id: h.accountId, agent_id: h.agentId, createdAt: NOW,
    policy_json: "{}", policy_hash: "test", controller_wallet_address: "0x" + "11".repeat(20),
    controller_chain_id: "eip155:84532", authorization_nonce: "test",
    authorization_message: "delete test", authorization_signature: "test",
  });
  const input = { db: h.db, accountId: h.accountId, slug: h.slug, now: () => NOW };
  expectVerdictError(() => deleteAccountAgent({ ...input, body: { confirm: "wrong" } }), "schema_invalid", 400);
  assert.equal(agentsRepo.deletedAt(h.db, h.agentId), null);
  const result = deleteAccountAgent({ ...input, body: { confirm: h.slug } });
  assert.equal(result.status, 200);
  assert.deepEqual(deleteAccountAgent({ ...input, body: { confirm: h.slug } }), result, "deletion retries are idempotent");
  assert.deepEqual(listAccountAgentsWithSetup(h.db, h.accountId).map((a) => a.agent_id), [sibling.agentId]);
  assert.equal(verifyApiKey(h.db, key.secret), null);
  assert.equal(verifyRuntimeKey(h.db, { secret: runtime.secret, verifiedAt: NOW }), null);
  assert.ok(verifyApiKey(h.db, siblingKey.secret), "sibling credentials still work");
  assert.equal(agentsRepo.bySlug(h.db, h.slug)?.agent_id, h.agentId, "historical identity and handle survive");
  expectVerdictError(() => assertAgentAcceptingCalls(h.db, h.agentId), "agent_retired", 409);
  expectVerdictError(() => unretireAccountAgent(input), "unknown_agent", 404);
  expectVerdictError(() => mintAgentApiKeyResponse({ ...input, operationInstant: NOW, body: {} }), "unknown_agent", 404);
  expectVerdictError(() => __resolveCasualIdentity(h.db, {
    privy_user_id: `privy-${h.accountId}`, session_id: "test", expires_at: NOW_ISO,
  }, h.slug), "unknown_agent", 404);
  close(h);
}

{
  const h = newHarness();
  const out = retireAccountAgent({
    db: h.db,
    accountId: h.accountId,
    slug: h.slug,
    now: () => NOW,
  }).body as { retired: boolean; already_retired: boolean; retired_at: string };
  assert.equal(out.retired, true);
  assert.equal(out.already_retired, false);
  assert.equal(out.retired_at, NOW_ISO);
  assert.equal(agentsRepo.retiredAt(h.db, h.agentId), NOW_ISO);

  // Idempotent, and it keeps the ORIGINAL moment.
  const again = retireAccountAgent({
    db: h.db,
    accountId: h.accountId,
    slug: h.slug,
    now: () => new Date("2026-09-01T00:00:00.000Z"),
  }).body as { already_retired: boolean; retired_at: string };
  assert.equal(again.already_retired, true);
  assert.equal(again.retired_at, NOW_ISO);

  const back = unretireAccountAgent({
    db: h.db,
    accountId: h.accountId,
    slug: h.slug,
    now: () => NOW,
  }).body as { retired: boolean; already_active: boolean };
  assert.equal(back.retired, false);
  assert.equal(back.already_active, false);
  assert.equal(agentsRepo.retiredAt(h.db, h.agentId), null);
  // Unretiring an active agent is a no-op, not an error.
  assert.equal(
    (unretireAccountAgent({
      db: h.db,
      accountId: h.accountId,
      slug: h.slug,
      now: () => NOW,
    }).body as { already_active: boolean }).already_active,
    true,
  );

  // Another account cannot retire this agent.
  expectVerdictError(
    () =>
      retireAccountAgent({
        db: h.db,
        accountId: randomUUID(),
        slug: h.slug,
        now: () => NOW,
      }),
    "agent_not_authorized",
    403,
  );
  close(h);
}

// ── 2. The gate refuses a NEW reservation, from inside the transaction ─────
{
  const h = newHarness();
  retireAccountAgent({ db: h.db, accountId: h.accountId, slug: h.slug, now: () => NOW });

  assert.throws(
    () => assertAgentAcceptingCalls(h.db, h.agentId),
    (err: unknown) =>
      err instanceof VerdictError &&
      err.code === "agent_retired" &&
      err.httpStatus === 409 &&
      /retired/.test(err.message),
  );

  // Through the real reservation path. The gate sits immediately after the
  // in-transaction duplicate exit, so it fires before the market, the runtime
  // policy or the rate limiter are ever consulted — which is exactly why this
  // call can pass placeholders for them.
  expectVerdictError(
    () =>
      reserveSealedCallAttempt({
        db: h.db,
        runtimeIdentity: {
          agent_id: h.agentId,
          account_id: h.accountId,
          runtime_key: {
            runtime_key_id: randomUUID(),
            policy_hash: "0xdeadbeef",
            policy_json: "{}",
            controller_wallet_address: "0x1111111111111111111111111111111111111111",
          },
        } as never,
        body: {
          client_order_id: "order-after-retirement",
          client_nonce: "0xabc",
          marketRef: { protocol: "polymarket", sourceId: "src", configVersion: 1 },
        } as never,
        market: { market_id: "mkt-1", adapter_id: "polymarket" } as never,
        chainId: 84532,
        contractAddress: "0x1b74a4bab1e06ed107780a245c85337ab9decd1a",
        relayerAddress: "0x2222222222222222222222222222222222222222",
        requestFingerprint: "fp-1",
        authProof: null,
        now: () => NOW,
      }),
    "agent_retired",
    409,
  );
  // Refused INSIDE the transaction means nothing was written.
  assert.equal(
    (h.db
      .prepare("SELECT COUNT(*) AS n FROM fhenix_gateway_tx_attempts")
      .get() as { n: number }).n,
    0,
  );

  // READS still work for a retired agent — the owner keeps their history.
  assert.equal(
    readProviderEarnings({ db: h.db, accountId: h.accountId, slug: h.slug }).status,
    200,
  );
  assert.equal(
    readAccountAgentReveals({
      db: h.db,
      accountId: h.accountId,
      slug: h.slug,
      revealGraceSeconds: 300,
    }).status,
    200,
  );
  close(h);
}

// ── 3. Gate PLACEMENT, asserted against the source ─────────────────────────
//
// Behaviour above proves the gate fires. This proves it fires in the one place
// it belongs, and nowhere it must not — a refactor that moved the call into
// runtime auth would still pass every behavioural check above while breaking
// reads for retired agents.
{
  const reservations = readFileSync(
    join(HERE, "../integrations/fhenix-gateway-reservations.ts"),
    "utf8",
  );
  const gate = reservations.indexOf("assertAgentAcceptingCalls(params.db, agentId)");
  const dupExit = reservations.indexOf("if (inTxDuplicate) {");
  const txOpen = reservations.indexOf("const reserveAndInsert = params.db.transaction");
  const insert = reservations.indexOf("fhenixGatewayTxRepo.insert(params.db, attempt)");
  assert.ok(gate > 0, "the retirement gate is missing from the reservation path");
  assert.ok(txOpen > 0 && txOpen < gate, "the gate must sit inside the reservation transaction");
  assert.ok(dupExit > 0 && dupExit < gate, "the gate must sit AFTER duplicate detection");
  assert.ok(insert > gate, "the gate must sit BEFORE the attempt insert");

  for (const [file, label] of [
    ["../verdict/auth/runtime-authorization.ts", "generic runtime auth"],
    ["../integrations/fhenix-gateway-acceptance.ts", "post-chain acceptance"],
  ] as const) {
    const source = readFileSync(join(HERE, file), "utf8");
    assert.ok(
      !source.includes("assertAgentAcceptingCalls"),
      `the retirement gate must NOT be wired into ${label}`,
    );
  }
}

// ── 4. Profile edits, and the immutable slug ───────────────────────────────
{
  const h = newHarness();
  const updated = updateAccountAgentProfile({
    db: h.db,
    accountId: h.accountId,
    slug: h.slug,
    body: { display_name: "  Renamed Agent  ", bio: "  after  " },
  }).body as { agent: Record<string, unknown>; slug_immutable: boolean };
  assert.equal(updated.agent.display_name, "Renamed Agent");
  assert.equal(updated.agent.bio, "after");
  assert.equal(updated.agent.display_slug, h.slug);
  assert.equal(updated.slug_immutable, true);

  // bio: null clears it; an omitted field is left alone.
  const cleared = updateAccountAgentProfile({
    db: h.db,
    accountId: h.accountId,
    slug: h.slug,
    body: { bio: null },
  }).body as { agent: Record<string, unknown> };
  assert.equal(cleared.agent.bio, null);
  assert.equal(cleared.agent.display_name, "Renamed Agent");

  // An empty body changes nothing and says so.
  expectVerdictError(
    () =>
      updateAccountAgentProfile({
        db: h.db,
        accountId: h.accountId,
        slug: h.slug,
        body: {},
      }),
    "schema_invalid",
    400,
  );
  // The slug is not editable, and the strict schema refuses to pretend it is.
  expectVerdictError(
    () =>
      updateAccountAgentProfile({
        db: h.db,
        accountId: h.accountId,
        slug: h.slug,
        body: { display_slug: "new-handle" },
      }),
    "schema_invalid",
    400,
  );
  assert.equal(agentsRepo.bySlug(h.db, h.slug)?.display_slug, h.slug);
  // Blank and over-long names are refused.
  expectVerdictError(
    () =>
      updateAccountAgentProfile({
        db: h.db,
        accountId: h.accountId,
        slug: h.slug,
        body: { display_name: "   " },
      }),
    "schema_invalid",
    400,
  );
  expectVerdictError(
    () =>
      updateAccountAgentProfile({
        db: h.db,
        accountId: h.accountId,
        slug: h.slug,
        body: { bio: "x".repeat(501) },
      }),
    "schema_invalid",
    400,
  );
  // Nobody else may edit it.
  expectVerdictError(
    () =>
      updateAccountAgentProfile({
        db: h.db,
        accountId: randomUUID(),
        slug: h.slug,
        body: { display_name: "hijack" },
      }),
    "agent_not_authorized",
    403,
  );
  close(h);
}

// ── 5. Deactivation, and the kill switch that cannot undo it ───────────────
{
  const h = newHarness();
  h.db
    .prepare(
      `INSERT INTO api_keys (api_key_id, account_id, agent_id, api_key_hash, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(randomUUID(), h.accountId, h.agentId, `hash-${randomUUID()}`, NOW_ISO);

  expectVerdictError(
    () =>
      deactivateAccountSurface({
        db: h.db,
        accountId: h.accountId,
        body: { confirm: "yes" },
        now: () => NOW,
      }),
    "schema_invalid",
    400,
  );

  const closed = deactivateAccountSurface({
    db: h.db,
    accountId: h.accountId,
    body: { confirm: "close-my-account" },
    now: () => NOW,
  }).body as Record<string, unknown>;
  assert.equal(closed.deactivated, true);
  assert.equal(closed.already_deactivated, false);
  assert.equal(closed.deactivated_at, NOW_ISO);
  assert.equal(closed.api_keys_rotated, 1);
  assert.equal(closed.agents_retired, 1);

  // All three consequences landed.
  assert.equal(accountDeactivatedAt(h.db, h.accountId), NOW_ISO);
  assert.ok(agentCredentialsDisabledAt(h.db, h.accountId));
  assert.equal(agentsRepo.retiredAt(h.db, h.agentId), NOW_ISO);

  // THE point: releasing the kill switch cannot reopen a closed account.
  expectVerdictError(
    () =>
      releaseAccountKillSwitch(h.db, {
        account_id: h.accountId,
        actor: "smoke",
        now: () => NOW,
      }),
    "account_deactivated",
    403,
  );
  assert.ok(
    agentCredentialsDisabledAt(h.db, h.accountId),
    "a refused release must leave the switch engaged",
  );
  assert.equal(accountDeactivatedAt(h.db, h.accountId), NOW_ISO);

  // Idempotent close.
  const again = deactivateAccountSurface({
    db: h.db,
    accountId: h.accountId,
    body: { confirm: "close-my-account" },
    now: () => new Date("2026-09-01T00:00:00.000Z"),
  }).body as Record<string, unknown>;
  assert.equal(again.already_deactivated, true);
  assert.equal(again.deactivated_at, NOW_ISO);
  close(h);
}

// ── 6. A merge is fail-closed on both markers ──────────────────────────────
{
  // Source closed, destination open → the survivor is closed.
  const h = newHarness();
  const source = seedAccount(h, "src");
  const dest = seedAccount(h, "dst");
  deactivateAccountSurface({
    db: h.db,
    accountId: source.accountId,
    body: { confirm: "close-my-account" },
    now: () => NOW,
  });
  const merged = reparentAccount(h.db, {
    fromPrivyUserId: source.privyId,
    toPrivyUserId: dest.privyId,
  });
  assert.equal(merged.status, "merged");
  assert.equal(
    accountDeactivatedAt(h.db, dest.accountId),
    NOW_ISO,
    "a merge must not drop the source's closure",
  );
  assert.ok(
    agentCredentialsDisabledAt(h.db, dest.accountId),
    "a merge must not drop the source's kill switch",
  );
  // Every agent the survivor now owns is retired — the moved one and its own.
  assert.equal(agentsRepo.retiredAt(h.db, source.agentId), NOW_ISO);
  assert.equal(agentsRepo.retiredAt(h.db, dest.agentId), NOW_ISO);
  close(h);
}

{
  // Destination closed, source open → still closed. The direction of the
  // transfer must not decide whether a closure survives.
  const h = newHarness();
  const source = seedAccount(h, "src2");
  const dest = seedAccount(h, "dst2");
  deactivateAccountSurface({
    db: h.db,
    accountId: dest.accountId,
    body: { confirm: "close-my-account" },
    now: () => NOW,
  });
  reparentAccount(h.db, {
    fromPrivyUserId: source.privyId,
    toPrivyUserId: dest.privyId,
  });
  assert.equal(accountDeactivatedAt(h.db, dest.accountId), NOW_ISO);
  assert.equal(agentsRepo.retiredAt(h.db, source.agentId), NOW_ISO);
  close(h);
}

{
  // Neither side closed → the merge stays permissive, and the profile
  // backfill still works. Fail-closed must not mean fail-always.
  const h = newHarness();
  const source = seedAccount(h, "src3");
  const dest = seedAccount(h, "dst3");
  h.db
    .prepare("UPDATE accounts SET email = NULL WHERE account_id = ?")
    .run(dest.accountId);
  reparentAccount(h.db, {
    fromPrivyUserId: source.privyId,
    toPrivyUserId: dest.privyId,
  });
  assert.equal(accountDeactivatedAt(h.db, dest.accountId), null);
  assert.equal(agentCredentialsDisabledAt(h.db, dest.accountId), null);
  assert.equal(agentsRepo.retiredAt(h.db, source.agentId), null);
  assert.equal(
    (h.db
      .prepare("SELECT email FROM accounts WHERE account_id = ?")
      .get(dest.accountId) as { email: string }).email,
    "src3@example.com",
  );
  close(h);
}

process.stdout.write("account lifecycle smoke OK\n");
