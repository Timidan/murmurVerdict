// ─── Gateway attempt read-back smoke ────────────────────────────────────────
//
//   · the owning agent's runtime key gets the row, including a PoP-bound key on a bodyless GET
//   · another agent's valid key gets 404, not 403
//   · Privy and account API-key auth are refused
//   · a terminal row reports next_attempt_at null
//   · error text is redacted; raw RPC diagnostics never appear

import { strict as assert } from "node:assert";
import { generateKeyPairSync, randomUUID, sign as edSign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb } from "./db.js";
import {
  bindControllerWallet,
  getOrCreateAccount,
  linkAgentToAccount,
  mintApiKey,
  mintRuntimeKey,
} from "./auth/accounts.js";
import type { AuthRequest } from "./auth/dispatcher.js";
import {
  EMPTY_BODY_SHA256,
  POP_HEADER_NONCE,
  POP_HEADER_SIGNATURE,
  POP_HEADER_TIMESTAMP,
} from "./auth/runtime-key-pop.js";
import { agentsRepo } from "./repos/agents-repo.js";
import { canonicalize, canonicalHash } from "../receipts/canonical.js";
import { gatewayAttemptResponse } from "./gateway-attempt-surface.js";
import { VerdictError } from "./schema.js";
import type { PrivyAuthVerifier } from "./auth/privy.js";

process.stdout.write("murmur gateway attempt surface smoke\n");

const NOW = new Date("2026-08-10T12:00:00.000Z");
const CHAIN = "eip155:84532";
const CONTRACT = "0x1b74a4bab1e06ed107780a245c85337ab9decd1a";
const ONCHAIN_CALL_ID = `0x${"7c".repeat(32)}`;
/** A provider error with a credentialed RPC URL inside it. */
const RAW_ERROR =
  "HTTP request failed. URL: https://rpc.example.com/v2/SUPER_SECRET_KEY?apikey=SECRET2 Details: nonce too low";

const tmp = mkdtempSync(join(tmpdir(), "attempt-surface-"));
const db = openDb({ path: join(tmp, "test.db") });
const iso = NOW.toISOString();
const now = () => NOW;

function makeAgent(input: { slug: string; privyUser: string; nonceTag: string }) {
  const agentId = randomUUID();
  const wallet = `0x${input.nonceTag.repeat(20).slice(0, 40)}`;
  agentsRepo.insert(db, {
    agent_id: agentId,
    display_slug: input.slug,
    kind: "agent",
    display_name: input.slug,
    created_at: iso,
    wallet_address: wallet,
    chain_id: CHAIN,
  });
  const account = getOrCreateAccount(
    db,
    { privy_user_id: input.privyUser, session_id: "smoke", expires_at: "2026-08-10T18:00:00Z" },
    { resolvedAt: NOW },
  );
  linkAgentToAccount(db, account.account_id, agentId, { linkedAt: NOW });
  bindControllerWallet(db, {
    account_id: account.account_id,
    agent_id: agentId,
    wallet_address: wallet,
    chain_id: CHAIN,
    wallet_kind: "embedded",
    provider: "smoke",
    binding_message: `binding ${input.slug}`,
    binding_signature: `0x${"11".repeat(65)}`,
    createdAt: NOW,
  });
  return { agentId, accountId: account.account_id, wallet };
}

function mintKey(input: {
  accountId: string;
  agentId: string;
  wallet: string;
  tag: string;
  policy: Record<string, unknown>;
}) {
  return mintRuntimeKey(db, {
    account_id: input.accountId,
    agent_id: input.agentId,
    label: input.tag,
    policy_json: canonicalize(input.policy),
    policy_hash: canonicalHash(input.policy),
    controller_wallet_address: input.wallet,
    controller_chain_id: CHAIN,
    authorization_nonce: `attempt-smoke-${input.tag}`,
    authorization_message: `attempt smoke authorization ${input.tag}`,
    authorization_signature: `0x${"12".repeat(65)}`,
    createdAt: NOW,
  });
}

function insertAttempt(input: {
  attemptId: string;
  agentId: string;
  accountId: string;
  wallet: string;
  status: string;
  onchainCallId?: string | null;
  callId?: string | null;
  revealOpenAt?: string | null;
  nextAttemptAt: string;
  lastError?: string | null;
  lastRpcError?: string | null;
  runtimeKeyId?: string | null;
}) {
  db.prepare(
    `INSERT INTO fhenix_gateway_tx_attempts (
       attempt_id, status, runtime_key_id, runtime_key_policy_hash,
       runtime_key_policy_json, account_id, agent_id, chain_id, contract_address,
       relayer_address, agent_wallet_address, market_id, market_id_hash,
       market_ref_protocol, market_config_version, client_order_id, client_nonce,
       submitted_at, binary_index_input_json, confidence_input_json,
       tx_hash, onchain_call_id, call_id, reveal_open_at, last_error,
       last_rpc_error, next_attempt_at, created_at, updated_at)
     VALUES (
       @attempt_id, @status, @runtime_key_id, 'policy-hash', '{}', @account_id,
       @agent_id, 84532, @contract, '0xrelayer', @wallet, 'market-1',
       'market-hash', 'polymarket', 1, @attempt_id, @attempt_id, @now, '{}', '{}',
       @tx_hash, @onchain_call_id, @call_id, @reveal_open_at, @last_error,
       @last_rpc_error, @next_attempt_at, @now, @now)`,
  ).run({
    attempt_id: input.attemptId,
    status: input.status,
    runtime_key_id: input.runtimeKeyId ?? null,
    account_id: input.accountId,
    agent_id: input.agentId,
    contract: CONTRACT,
    wallet: input.wallet,
    tx_hash: `0x${"ab".repeat(32)}`,
    onchain_call_id: input.onchainCallId ?? null,
    call_id: input.callId ?? null,
    reveal_open_at: input.revealOpenAt ?? null,
    last_error: input.lastError ?? null,
    last_rpc_error: input.lastRpcError ?? null,
    next_attempt_at: input.nextAttemptAt,
    now: iso,
  });
}

function request(
  headers: Record<string, string>,
  extra?: { method?: string; originalUrl?: string },
): AuthRequest {
  const lc: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lc[k.toLowerCase()] = v;
  return {
    header: (name: string) => lc[name.toLowerCase()],
    method: extra?.method ?? "GET",
    originalUrl: extra?.originalUrl,
    // Deliberately no murmurRawBodySha256: a GET has no body, and the
    // dispatcher must substitute the empty-body hash for PoP verification.
  };
}

interface AttemptBody {
  attempt_id: string;
  status: string;
  onchain_call_id: string | null;
  call_id: string | null;
  chain_id: number;
  contract_address: string;
  reveal_open_at: string | null;
  next_attempt_at: string | null;
  error_code: string | null;
  error: string | null;
  tx_hash: string | null;
}

async function main() {
  const owner = makeAgent({ slug: "attempt-owner", privyUser: "did:privy:owner", nonceTag: "a" });
  const stranger = makeAgent({
    slug: "attempt-stranger",
    privyUser: "did:privy:stranger",
    nonceTag: "c",
  });

  const bearerKey = mintKey({
    accountId: owner.accountId,
    agentId: owner.agentId,
    wallet: owner.wallet,
    tag: "bearer",
    policy: { feed_packets: false },
  });
  const strangerKey = mintKey({
    accountId: stranger.accountId,
    agentId: stranger.agentId,
    wallet: stranger.wallet,
    tag: "stranger",
    policy: { feed_packets: false },
  });
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const signingPubkeyHex = spki.subarray(spki.length - 32).toString("hex");
  const popKey = mintKey({
    accountId: owner.accountId,
    agentId: owner.agentId,
    wallet: owner.wallet,
    tag: "pop",
    policy: { feed_packets: false, signing_pubkey: signingPubkeyHex },
  });
  const apiKey = mintApiKey(db, {
    account_id: owner.accountId,
    agent_id: owner.agentId,
    label: "dashboard key",
    createdAt: NOW,
  });

  db.prepare(
    `INSERT INTO submissions (call_id, agent_id, client_order_id, horizon_seconds,
       submitted_at, accepted_at, status, schema_version, scoring_version, dedup_key)
     VALUES ('call-accepted', @agent_id, 'order-accepted', 300, @now, @now,
       'accepted', 1, 1, 'dedup-accepted')`,
  ).run({ agent_id: owner.agentId, now: iso });

  insertAttempt({
    attemptId: "attempt-accepted",
    agentId: owner.agentId,
    accountId: owner.accountId,
    wallet: owner.wallet,
    status: "accepted",
    onchainCallId: ONCHAIN_CALL_ID,
    callId: "call-accepted",
    revealOpenAt: "2026-08-11T00:00:00.000Z",
    // Stale: markAccepted does not clear the retry watermark.
    nextAttemptAt: "2026-08-10T12:05:00.000Z",
    // The key that made this attempt has since been rotated away.
    runtimeKeyId: null,
  });
  insertAttempt({
    attemptId: "attempt-retrying",
    agentId: owner.agentId,
    accountId: owner.accountId,
    wallet: owner.wallet,
    status: "failed_retryable",
    nextAttemptAt: "2026-08-10T12:01:00.000Z",
    lastError: RAW_ERROR,
    lastRpcError: "raw rpc transport detail https://rpc.example.com/v2/ANOTHER_SECRET",
  });
  insertAttempt({
    attemptId: "attempt-dead",
    agentId: owner.agentId,
    accountId: owner.accountId,
    wallet: owner.wallet,
    status: "failed_terminal",
    nextAttemptAt: "2026-08-10T12:02:00.000Z",
    lastError: RAW_ERROR,
  });
  insertAttempt({
    attemptId: "attempt-stranger",
    agentId: stranger.agentId,
    accountId: stranger.accountId,
    wallet: stranger.wallet,
    status: "accepted",
    onchainCallId: `0x${"99".repeat(32)}`,
    nextAttemptAt: "2026-08-10T12:03:00.000Z",
  });

  const deps = { db, now };
  const ask = (headers: Record<string, string>, attemptId: string, url?: string) =>
    gatewayAttemptResponse({
      req: request(headers, { originalUrl: url ?? `/v2/gateway/attempts/${attemptId}` }),
      deps,
      attemptId,
    });

  // ── The owning agent's key reads its own attempt ──────────────────────────
  {
    const res = await ask({ "x-murmur-runtime-key": bearerKey.secret }, "attempt-accepted");
    assert.equal(res.status, 200);
    const body = res.body as AttemptBody;
    assert.equal(body.attempt_id, "attempt-accepted");
    assert.equal(body.status, "accepted");
    assert.equal(
      body.onchain_call_id,
      ONCHAIN_CALL_ID,
      "the id an agent could not otherwise learn",
    );
    assert.equal(body.call_id, "call-accepted");
    assert.equal(body.chain_id, 84532);
    assert.equal(body.contract_address, CONTRACT);
    assert.equal(body.reveal_open_at, "2026-08-11T00:00:00.000Z");
    assert.equal(
      body.next_attempt_at,
      null,
      "a terminal row must not advertise a retry that will never run",
    );
    assert.equal(body.error_code, null);
    assert.equal(body.error, null);
  }

  // ── A PoP-bound key works on a bodyless GET (empty-body hash) ─────────────
  {
    const path = "/v2/gateway/attempts/attempt-accepted";
    const ts = Math.floor(NOW.getTime() / 1000);
    const nonce = randomUUID().replace(/-/g, "");
    const signingString = [
      "murmur-rk-v2",
      "murmur-gateway",
      popKey.runtime_key_id,
      String(ts),
      nonce,
      "GET",
      path,
      EMPTY_BODY_SHA256,
    ].join("\n");
    const signature = edSign(null, Buffer.from(signingString, "utf8"), privateKey).toString("hex");
    const res = await ask(
      {
        "x-murmur-runtime-key": popKey.secret,
        [POP_HEADER_TIMESTAMP]: String(ts),
        [POP_HEADER_NONCE]: nonce,
        [POP_HEADER_SIGNATURE]: signature,
      },
      "attempt-accepted",
      path,
    );
    assert.equal(res.status, 200);
    assert.equal((res.body as AttemptBody).onchain_call_id, ONCHAIN_CALL_ID);
  }

  // ── Another agent's valid key: 404, never 403 ─────────────────────────────
  {
    const res = await ask({ "x-murmur-runtime-key": strangerKey.secret }, "attempt-accepted");
    assert.equal(res.status, 404);
    assert.equal((res.body as { error: string }).error, "AttemptNotFound");
    // Sanity: that key CAN read its own attempt, so 404 above is scoping.
    const own = await ask({ "x-murmur-runtime-key": strangerKey.secret }, "attempt-stranger");
    assert.equal(own.status, 200);
  }

  // ── Account API-key auth is refused ───────────────────────────────────────
  {
    await assert.rejects(
      () => ask({ "x-murmur-api-key": apiKey.secret }, "attempt-accepted"),
      (err: unknown) => err instanceof VerdictError && err.httpStatus === 401,
      "an account API key is a dashboard credential, not agent runtime identity",
    );
  }

  // ── Privy session auth is refused ─────────────────────────────────────────
  {
    const privyAuth: PrivyAuthVerifier = {
      isEnabled: () => true,
      verify: async () => ({
        privy_user_id: "did:privy:owner",
        session_id: "smoke",
        expires_at: "2026-08-10T18:00:00Z",
      }),
      hydrateProfile: async () => ({}),
    };
    await assert.rejects(
      () =>
        gatewayAttemptResponse({
          req: request(
            { authorization: "Bearer privy-token" },
            { originalUrl: "/v2/gateway/attempts/attempt-accepted" },
          ),
          deps: { db, now, privyAuth },
          attemptId: "attempt-accepted",
        }),
      (err: unknown) => err instanceof VerdictError && err.httpStatus === 401,
    );
  }

  // ── No credentials at all ─────────────────────────────────────────────────
  {
    await assert.rejects(
      () => ask({}, "attempt-accepted"),
      (err: unknown) => err instanceof VerdictError && err.httpStatus === 401,
    );
  }

  // ── Failure rows: stable code, redacted text, live retry watermark ───────
  {
    const res = await ask({ "x-murmur-runtime-key": bearerKey.secret }, "attempt-retrying");
    assert.equal(res.status, 200);
    const body = res.body as AttemptBody;
    assert.equal(body.error_code, "submit_retrying");
    assert.equal(
      body.next_attempt_at,
      "2026-08-10T12:01:00.000Z",
      "a non-terminal row keeps its real next attempt",
    );
    assert.ok(body.error, "a failed attempt explains itself");
    assert.ok(!body.error!.includes("SUPER_SECRET_KEY"), "credentials in the RPC path are stripped");
    assert.ok(!body.error!.includes("SECRET2"), "credentials in the query are stripped");
    assert.match(body.error!, /nonce too low/, "the useful part survives redaction");
    const serialized = JSON.stringify(body);
    assert.ok(!serialized.includes("ANOTHER_SECRET"), "last_rpc_error is never served");

    const dead = await ask({ "x-murmur-runtime-key": bearerKey.secret }, "attempt-dead");
    const deadBody = dead.body as AttemptBody;
    assert.equal(deadBody.error_code, "submit_failed");
    assert.equal(deadBody.next_attempt_at, null, "a dead attempt schedules nothing");
  }

  // ── An unknown attempt id is the same 404 ─────────────────────────────────
  {
    const res = await ask({ "x-murmur-runtime-key": bearerKey.secret }, "attempt-does-not-exist");
    assert.equal(res.status, 404);
  }
}

try {
  await main();
  process.stdout.write("OK gateway attempt surface smoke\n");
} finally {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
}
