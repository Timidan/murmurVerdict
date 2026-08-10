import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getAccountForAgent,
  getControllerWalletForAgent,
} from "./auth/accounts.js";
import {
  marketsRepo,
  openDb,
} from "./db.js";
import {
  OPERATOR_BLIND_FIXTURE_CHAIN_CAIP,
  OPERATOR_BLIND_FIXTURE_CHAIN_ID,
  OPERATOR_BLIND_FIXTURE_MARKET_ID,
  OPERATOR_BLIND_FIXTURE_MARKET_REF,
  OPERATOR_BLIND_FIXTURE_PRIVY_USER_ID,
  OPERATOR_BLIND_FIXTURE_SLUG,
  seedOperatorBlindFixtureDb,
} from "./operator-blind-fixture-surface.js";
import { requireMintableExternalMarket } from "./external-market-guard.js";
import { agentsRepo } from "./repos/agents-repo.js";

const tmp = mkdtempSync(join(tmpdir(), "murmur-operator-blind-fixture-surface-"));
const dbPath = join(tmp, "test.db");

try {
  process.stdout.write("murmur operator blind fixture surface smoke\n");
  const db = openDb({ path: dbPath });
  const wallet = `0x${"ab".repeat(20)}`;
  const accountIds: string[] = [];
  const agentIds: string[] = [];
  const runtimeKeyIds: string[] = [];
  const runtimeKeySecrets: string[] = [];
  const runtimeAuthorizationNonces: string[] = [];
  const runtimeAuthorizationMessageIds: string[] = [];
  const now = () => new Date("2026-06-12T09:30:00Z");
  const unexpectedId = () => {
    throw new Error("fixture id adapter should not be called before validation passes");
  };

  assert.throws(
    () =>
      seedOperatorBlindFixtureDb({
        db,
        agentWallet: "0xnot-a-wallet",
    // Mirrors what the seeder registers on-chain; the acceptance guard
    // compares the daemon expected reveal instant against it.
    revealSchedule: { endDateMs: 1785931200000, embargoSec: 60 },
        now,
        newAccountId: unexpectedId,
        newAgentId: unexpectedId,
        newRuntimeKeyId: unexpectedId,
        newRuntimeKeySecret: unexpectedId,
        newRuntimeAuthorizationNonce: unexpectedId,
        newRuntimeAuthorizationMessageId: unexpectedId,
      }),
    /lowercase 0x \+ 40 hex chars/,
  );

  const firstAccountId = "00000000-0000-4000-8000-000000000101";
  const firstAgentId = "00000000-0000-4000-8000-000000000201";
  const firstRuntimeKeyId = "00000000-0000-4000-8000-000000000301";
  const firstRuntimeKeySecret = `mrt_${"a".repeat(64)}`;
  const firstAuthorizationNonce = "00000000-0000-4000-8000-000000000401";
  const firstAuthorizationMessageId = "00000000-0000-4000-8000-000000000501";
  const created = seedOperatorBlindFixtureDb({
    db,
    agentWallet: wallet,
    // Mirrors what the seeder registers on-chain; the acceptance guard
    // compares the daemon expected reveal instant against it.
    revealSchedule: { endDateMs: 1785931200000, embargoSec: 60 },
    now,
    newAccountId: () => push(accountIds, firstAccountId),
    newAgentId: () => push(agentIds, firstAgentId),
    newRuntimeKeyId: () => push(runtimeKeyIds, firstRuntimeKeyId),
    newRuntimeKeySecret: () => push(runtimeKeySecrets, firstRuntimeKeySecret),
    newRuntimeAuthorizationNonce: () =>
      push(runtimeAuthorizationNonces, firstAuthorizationNonce),
    newRuntimeAuthorizationMessageId: () =>
      push(runtimeAuthorizationMessageIds, firstAuthorizationMessageId),
  });

  assert.deepEqual(created, {
    slug: OPERATOR_BLIND_FIXTURE_SLUG,
    agent_address: wallet,
    chain_id: OPERATOR_BLIND_FIXTURE_CHAIN_ID,
    market_id: OPERATOR_BLIND_FIXTURE_MARKET_ID,
    market_ref: OPERATOR_BLIND_FIXTURE_MARKET_REF,
    created_account: true,
    created_agent: true,
    linked_agent: true,
    bound_wallet: true,
    account_id: firstAccountId,
    agent_id: firstAgentId,
    runtime_key_id: firstRuntimeKeyId,
    runtime_key_secret: firstRuntimeKeySecret,
    runtime_key_prefix: firstRuntimeKeySecret.slice(0, 12),
  });
  assert.deepEqual(accountIds, [firstAccountId]);
  assert.deepEqual(agentIds, [firstAgentId]);
  assert.deepEqual(runtimeKeyIds, [firstRuntimeKeyId]);
  assert.deepEqual(runtimeKeySecrets, [firstRuntimeKeySecret]);
  assert.deepEqual(runtimeAuthorizationNonces, [firstAuthorizationNonce]);
  assert.deepEqual(runtimeAuthorizationMessageIds, [firstAuthorizationMessageId]);

  const account = db.prepare("SELECT * FROM accounts WHERE account_id = ?").get(
    firstAccountId,
  ) as {
    privy_user_id: string;
    primary_login_method: string | null;
    created_at: string;
    last_seen_at: string;
  };
  assert.equal(account.privy_user_id, OPERATOR_BLIND_FIXTURE_PRIVY_USER_ID);
  assert.equal(account.primary_login_method, "fixture");
  assert.equal(account.created_at, "2026-06-12T09:30:00Z");
  assert.equal(account.last_seen_at, "2026-06-12T09:30:00Z");

  const agent = agentsRepo.bySlug(db, OPERATOR_BLIND_FIXTURE_SLUG);
  assert.equal(agent?.agent_id, firstAgentId);
  assert.equal(agent?.wallet_address, wallet);
  assert.equal(agent?.chain_id, OPERATOR_BLIND_FIXTURE_CHAIN_CAIP);
  assert.equal(agent?.created_at, "2026-06-12T09:30:00Z");
  assert.equal(getAccountForAgent(db, firstAgentId), firstAccountId);

  const controller = getControllerWalletForAgent(db, firstAgentId);
  assert.equal(controller?.wallet_address, wallet);
  assert.equal(controller?.chain_id, OPERATOR_BLIND_FIXTURE_CHAIN_CAIP);
  assert.equal(controller?.wallet_kind, "external");
  assert.equal(controller?.provider, "operator-blind-fixture");
  assert.equal(controller?.created_at, "2026-06-12T09:30:00Z");

  const market = marketsRepo.get(db, OPERATOR_BLIND_FIXTURE_MARKET_ID);
  assert.equal(market?.status, "listed");
  assert.equal(market?.adapter_id, "polymarket-gamma");
  assert.equal(market?.market_family, "prediction-market-binary");
  assert.equal(market?.market_kind, "event_binary");
  assert.equal(market?.scoring_kind, "multinomial_brier");
  assert.equal(market?.asset_id, "polymarket:event");
  assert.equal(market?.primary_oracle_id, "polymarket-gamma-oracle");
  assert.deepEqual(JSON.parse(market?.config_json ?? "{}"), {
    conditionId: OPERATOR_BLIND_FIXTURE_MARKET_ID,
    slug: OPERATOR_BLIND_FIXTURE_SLUG,
    outcomes: ["YES", "NO"],
    // The fixture now carries the SAME schedule the seeder registers on-chain.
    // It was `endDate: null`, which made the daemon fall back to
    // `accepted_at + horizon_seconds` — a reveal instant the six-instant
    // contract never agrees with, so every seeded call was refused by the
    // acceptance guard with "reveal_open_at must equal the market reveal
    // window". endDate + embargoSec must equal the on-chain publicRevealAt.
    endDate: new Date(1785931200000).toISOString(),
    embargoSec: 60,
    gamma_url: `https://polymarket.com/event/${OPERATOR_BLIND_FIXTURE_SLUG}`,
    label: OPERATOR_BLIND_FIXTURE_SLUG,
    fixture: true,
  });
  // The fixture must satisfy the shared external-market guard the gateway
  // preflight and sealed-call acceptance both run — otherwise the release gate
  // would 400 at submit.
  assert.equal(requireMintableExternalMarket(market!).name, "polymarket-gamma");

  const firstRuntimeKey = runtimeKeyRow(db, firstRuntimeKeyId);
  assert.equal(firstRuntimeKey.account_id, firstAccountId);
  assert.equal(firstRuntimeKey.agent_id, firstAgentId);
  assert.equal(firstRuntimeKey.runtime_key_prefix, firstRuntimeKeySecret.slice(0, 12));
  assert.equal(firstRuntimeKey.controller_wallet_address, wallet);
  assert.equal(firstRuntimeKey.controller_chain_id, OPERATOR_BLIND_FIXTURE_CHAIN_CAIP);
  assert.equal(firstRuntimeKey.authorization_nonce, firstAuthorizationNonce);
  assert.equal(
    firstRuntimeKey.authorization_message,
    `operator-blind runtime key ${firstAuthorizationMessageId}`,
  );
  assert.equal(firstRuntimeKey.created_at, "2026-06-12T09:30:00Z");

  const secondRuntimeKeyId = "00000000-0000-4000-8000-000000000302";
  const secondRuntimeKeySecret = `mrt_${"b".repeat(64)}`;
  const secondAuthorizationNonce = "00000000-0000-4000-8000-000000000402";
  const secondAuthorizationMessageId = "00000000-0000-4000-8000-000000000502";
  const repeated = seedOperatorBlindFixtureDb({
    db,
    agentWallet: wallet,
    // Mirrors what the seeder registers on-chain; the acceptance guard
    // compares the daemon expected reveal instant against it.
    revealSchedule: { endDateMs: 1785931200000, embargoSec: 60 },
    now: () => new Date("2026-06-12T09:31:00Z"),
    newAccountId: unexpectedId,
    newAgentId: unexpectedId,
    newRuntimeKeyId: () => push(runtimeKeyIds, secondRuntimeKeyId),
    newRuntimeKeySecret: () => push(runtimeKeySecrets, secondRuntimeKeySecret),
    newRuntimeAuthorizationNonce: () =>
      push(runtimeAuthorizationNonces, secondAuthorizationNonce),
    newRuntimeAuthorizationMessageId: () =>
      push(runtimeAuthorizationMessageIds, secondAuthorizationMessageId),
  });

  assert.equal(repeated.account_id, firstAccountId);
  assert.equal(repeated.agent_id, firstAgentId);
  assert.equal(repeated.created_account, false);
  assert.equal(repeated.created_agent, false);
  assert.equal(repeated.linked_agent, false);
  assert.equal(repeated.bound_wallet, false);
  assert.equal(repeated.runtime_key_id, secondRuntimeKeyId);
  assert.equal(repeated.runtime_key_prefix, secondRuntimeKeySecret.slice(0, 12));

  const secondRuntimeKey = runtimeKeyRow(db, secondRuntimeKeyId);
  assert.equal(
    secondRuntimeKey.authorization_message,
    `operator-blind runtime key ${secondAuthorizationMessageId}`,
  );
  assert.equal(secondRuntimeKey.created_at, "2026-06-12T09:31:00Z");
  const runtimeKeyCount = db
    .prepare("SELECT COUNT(*) AS n FROM agent_runtime_keys")
    .get() as { n: number };
  assert.equal(runtimeKeyCount.n, 2);

  db.close();
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

process.stdout.write("operator blind fixture surface smoke ok\n");

function push<T>(seen: T[], value: T): T {
  seen.push(value);
  return value;
}

function runtimeKeyRow(
  db: ReturnType<typeof openDb>,
  runtimeKeyId: string,
): {
  account_id: string;
  agent_id: string;
  runtime_key_prefix: string;
  controller_wallet_address: string;
  controller_chain_id: string;
  authorization_nonce: string;
  authorization_message: string;
  created_at: string;
} {
  const row = db.prepare(
    `SELECT account_id, agent_id, runtime_key_prefix,
            controller_wallet_address, controller_chain_id,
            authorization_nonce, authorization_message, created_at
     FROM agent_runtime_keys
     WHERE runtime_key_id = ?`,
  ).get(runtimeKeyId) as ReturnType<typeof runtimeKeyRow> | undefined;
  assert.ok(row);
  return row;
}
