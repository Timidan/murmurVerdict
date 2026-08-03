// ─── Agent-auth hardening smoke ──────────────────────────────────────────────
//
// Pins the two security mechanisms added after the PayBox competitive review
// (codex-reviewed 2026-08-02):
//
//   A. Proof-of-possession runtime keys (murmur-rk-v2): a key whose
//      controller-signed policy carries signing_pubkey REQUIRES a valid
//      Ed25519 request signature and fails CLOSED — never falling through to
//      API-key auth — on any defect (missing headers, bad signature, stale
//      timestamp, replayed nonce, missing request context). Bearer-only keys
//      keep the old contract untouched.
//
//   B. Account kill switch: agent_credentials_disabled_at blocks runtime-key
//      AND api-key dispatch even for still-valid credentials (the race
//      window), while engageAccountKillSwitch also bulk-revokes/rotates and
//      writes an append-only security event. Release does not resurrect
//      credentials.

import { strict as assert } from "node:assert";
import { generateKeyPairSync, randomUUID, sign as edSign, createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  agentCredentialsDisabledAt,
  bindControllerWallet,
  engageAccountKillSwitch,
  getOrCreateAccount,
  linkAgentToAccount,
  mintApiKey,
  mintRuntimeKey,
  releaseAccountKillSwitch,
  verifyRuntimeKey,
} from "./accounts.js";
import { dispatchAuth, type AuthRequest } from "./dispatcher.js";
import { POP_HEADER_NONCE, POP_HEADER_SIGNATURE, POP_HEADER_TIMESTAMP } from "./runtime-key-pop.js";
import { agentsRepo } from "../repos/agents-repo.js";
import { agentSecurityEventsRepo } from "../repos/agent-security-events-repo.js";
import { openDb } from "../db.js";
import { VerdictError } from "../schema.js";
import { canonicalize, canonicalHash } from "../../receipts/canonical.js";

process.stdout.write("murmur agent-auth hardening smoke\n");

const tmp = mkdtempSync(join(tmpdir(), "murmur-auth-hardening-"));
const dbPath = join(tmp, "test.db");
let passed = 0;
let failed = 0;

function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve(fn()).then(
    () => {
      passed++;
      process.stdout.write(`  ok ${name}\n`);
    },
    (err) => {
      failed++;
      process.stdout.write(`  FAIL ${name}\n    ${(err as Error)?.stack ?? err}\n`);
    },
  );
}

function fakeRequest(
  headers: Record<string, string>,
  extra?: { method?: string; originalUrl?: string; rawBodySha256?: string },
): AuthRequest {
  const lc: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lc[k.toLowerCase()] = v;
  return {
    header: (name: string) => lc[name.toLowerCase()],
    method: extra?.method,
    originalUrl: extra?.originalUrl,
    murmurRawBodySha256: extra?.rawBodySha256,
  };
}

async function main() {
  const db = openDb({ path: dbPath });
  const at = new Date("2026-08-01T12:00:00Z");
  const now = () => at;
  try {
    // ── Fixtures ──────────────────────────────────────────────────────
    const agentId = randomUUID();
    const wallet = "0x" + "ab".repeat(20);
    agentsRepo.insert(db, {
      agent_id: agentId,
      display_slug: "auth-hardening-smoke",
      kind: "agent",
      display_name: "Auth Hardening Smoke",
      created_at: at.toISOString(),
      wallet_address: wallet,
      chain_id: "eip155:8008135",
    });
    const account = getOrCreateAccount(db, {
      privy_user_id: "did:privy:auth-hardening",
      session_id: "smoke-session",
      expires_at: "2026-08-01T18:00:00Z",
    }, { resolvedAt: at });
    linkAgentToAccount(db, account.account_id, agentId, { linkedAt: at });
    bindControllerWallet(db, {
      account_id: account.account_id,
      agent_id: agentId,
      wallet_address: wallet,
      chain_id: "eip155:8008135",
      wallet_kind: "embedded",
      provider: "smoke",
      binding_message: "smoke controller wallet binding",
      binding_signature: "0x" + "11".repeat(65),
      createdAt: at,
    });

    // Real Ed25519 keypair — public half goes into the PoP key's policy.
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
    const signingPubkeyHex = spki.subarray(spki.length - 32).toString("hex");

    const popPolicy = { feed_packets: true, signing_pubkey: signingPubkeyHex };
    const popKey = mintRuntimeKey(db, {
      account_id: account.account_id,
      agent_id: agentId,
      label: "pop key",
      policy_json: canonicalize(popPolicy),
      policy_hash: canonicalHash(popPolicy),
      controller_wallet_address: wallet,
      controller_chain_id: "eip155:8008135",
      authorization_nonce: "auth-hardening-pop-001",
      authorization_message: "auth hardening pop authorization",
      authorization_signature: "0x" + "12".repeat(65),
      createdAt: at,
    });
    const bearerPolicy = { feed_packets: true };
    const bearerKey = mintRuntimeKey(db, {
      account_id: account.account_id,
      agent_id: agentId,
      label: "bearer key",
      policy_json: canonicalize(bearerPolicy),
      policy_hash: canonicalHash(bearerPolicy),
      controller_wallet_address: wallet,
      controller_chain_id: "eip155:8008135",
      authorization_nonce: "auth-hardening-bearer-001",
      authorization_message: "auth hardening bearer authorization",
      authorization_signature: "0x" + "13".repeat(65),
      createdAt: at,
    });
    const apiKey = mintApiKey(db, {
      account_id: account.account_id,
      agent_id: agentId,
      label: "fallback key",
      createdAt: at,
    });

    const METHOD = "POST";
    const URL_PATH = "/v2/gateway/calls";
    const bodyBytes = Buffer.from(JSON.stringify({ hello: "world" }), "utf8");
    const bodySha = createHash("sha256").update(bodyBytes).digest("hex");
    const popHeaders = (opts?: {
      ts?: number;
      nonce?: string;
      bodySha256?: string;
      method?: string;
      url?: string;
    }) => {
      const ts = opts?.ts ?? Math.floor(at.getTime() / 1000);
      const nonce = opts?.nonce ?? randomUUID().replace(/-/g, "");
      const payload = [
        "murmur-rk-v2",
        "murmur-gateway",
        popKey.runtime_key_id,
        String(ts),
        nonce,
        opts?.method ?? METHOD,
        opts?.url ?? URL_PATH,
        opts?.bodySha256 ?? bodySha,
      ].join("\n");
      const signature = edSign(null, Buffer.from(payload, "utf8"), privateKey).toString("hex");
      return {
        [POP_HEADER_TIMESTAMP]: String(ts),
        [POP_HEADER_NONCE]: nonce,
        [POP_HEADER_SIGNATURE]: signature,
      };
    };
    const popContext = { method: METHOD, originalUrl: URL_PATH, rawBodySha256: bodySha };
    const deps = { db, now, allowRuntimeKey: true };

    const expectSignatureInvalid = (err: unknown) =>
      err instanceof VerdictError &&
      err.httpStatus === 401 &&
      err.code === "runtime_key_signature_invalid";

    // ── A. proof of possession ────────────────────────────────────────
    await check("bearer-only key authenticates with no signature headers", async () => {
      const id = await dispatchAuth(
        fakeRequest({ "x-murmur-runtime-key": bearerKey.secret }, popContext),
        deps,
      );
      assert.equal(id?.auth_mode, "runtime_key");
      assert.equal(id?.runtime_key?.signature_verified, false);
    });

    await check("PoP key with valid signature authenticates, marks signature_verified", async () => {
      const id = await dispatchAuth(
        fakeRequest(
          { "x-murmur-runtime-key": popKey.secret, ...popHeaders() },
          popContext,
        ),
        deps,
      );
      assert.equal(id?.auth_mode, "runtime_key");
      assert.equal(id?.runtime_key?.signature_verified, true);
    });

    await check("PoP key with NO signature headers fails closed — even with a valid api key present", async () => {
      await assert.rejects(
        dispatchAuth(
          fakeRequest(
            { "x-murmur-runtime-key": popKey.secret, "x-murmur-api-key": apiKey.secret },
            popContext,
          ),
          deps,
        ),
        expectSignatureInvalid,
      );
    });

    await check("PoP signature over a DIFFERENT body is rejected", async () => {
      const otherSha = createHash("sha256").update("tampered", "utf8").digest("hex");
      await assert.rejects(
        dispatchAuth(
          fakeRequest(
            { "x-murmur-runtime-key": popKey.secret, ...popHeaders({ bodySha256: otherSha }) },
            popContext,
          ),
          deps,
        ),
        expectSignatureInvalid,
      );
    });

    await check("stale PoP timestamp is rejected", async () => {
      await assert.rejects(
        dispatchAuth(
          fakeRequest(
            {
              "x-murmur-runtime-key": popKey.secret,
              ...popHeaders({ ts: Math.floor(at.getTime() / 1000) - 3600 }),
            },
            popContext,
          ),
          deps,
        ),
        expectSignatureInvalid,
      );
    });

    await check("replayed PoP nonce is rejected on the second use", async () => {
      const fixed = popHeaders({ nonce: "aa".repeat(16) });
      const first = await dispatchAuth(
        fakeRequest({ "x-murmur-runtime-key": popKey.secret, ...fixed }, popContext),
        deps,
      );
      assert.equal(first?.auth_mode, "runtime_key");
      await assert.rejects(
        dispatchAuth(
          fakeRequest({ "x-murmur-runtime-key": popKey.secret, ...fixed }, popContext),
          deps,
        ),
        expectSignatureInvalid,
      );
    });

    await check("PoP key on a route without request context fails closed", async () => {
      await assert.rejects(
        dispatchAuth(
          fakeRequest({ "x-murmur-runtime-key": popKey.secret, ...popHeaders() }),
          deps,
        ),
        expectSignatureInvalid,
      );
    });

    await check("captured signature with a SUBSTITUTED nonce is rejected (v2 signs the nonce)", async () => {
      // v1 regression: the nonce was only a header, so one captured signature
      // could be replayed with any fresh nonce inside the freshness window.
      const captured = popHeaders({ nonce: "cc".repeat(16) });
      const first = await dispatchAuth(
        fakeRequest({ "x-murmur-runtime-key": popKey.secret, ...captured }, popContext),
        deps,
      );
      assert.equal(first?.auth_mode, "runtime_key");
      const substituted = {
        ...captured,
        [POP_HEADER_NONCE]: "dd".repeat(16), // fresh nonce, same signature
      };
      await assert.rejects(
        dispatchAuth(
          fakeRequest({ "x-murmur-runtime-key": popKey.secret, ...substituted }, popContext),
          deps,
        ),
        expectSignatureInvalid,
      );
      // and the substituted nonce must NOT have been burned by the failure
      const clean = popHeaders({ nonce: "dd".repeat(16) });
      const legit = await dispatchAuth(
        fakeRequest({ "x-murmur-runtime-key": popKey.secret, ...clean }, popContext),
        deps,
      );
      assert.equal(legit?.auth_mode, "runtime_key");
    });

    // ── B. kill switch ────────────────────────────────────────────────
    const expectDisabled = (err: unknown) =>
      err instanceof VerdictError &&
      err.httpStatus === 403 &&
      err.code === "agent_credentials_disabled";

    await check("disabled flag alone blocks STILL-VALID runtime and api keys (race window)", async () => {
      db.prepare(
        `UPDATE accounts SET agent_credentials_disabled_at = ? WHERE account_id = ?`,
      ).run(at.toISOString(), account.account_id);
      await assert.rejects(
        dispatchAuth(
          fakeRequest({ "x-murmur-runtime-key": bearerKey.secret }, popContext),
          deps,
        ),
        expectDisabled,
      );
      await assert.rejects(
        dispatchAuth(fakeRequest({ "x-murmur-api-key": apiKey.secret }), deps),
        expectDisabled,
      );
      db.prepare(
        `UPDATE accounts SET agent_credentials_disabled_at = NULL WHERE account_id = ?`,
      ).run(account.account_id);
    });

    await check("engage revokes all runtime keys, rotates api keys, writes ONE security event", async () => {
      const result = engageAccountKillSwitch(db, {
        account_id: account.account_id,
        actor: `privy:${account.account_id}`,
        now,
      });
      assert.equal(result.already_engaged, false);
      assert.equal(result.runtime_keys_revoked, 2);
      assert.equal(result.api_keys_rotated, 1);
      assert.equal(
        verifyRuntimeKey(db, { secret: bearerKey.secret, verifiedAt: at }),
        null,
      );
      const events = agentSecurityEventsRepo.listByKind(db, "account_kill_switch_engaged");
      assert.equal(events.length, 1);
      assert.equal(events[0]?.account_id, account.account_id);
    });

    await check("second engage is idempotent — no double revoke, no second event", async () => {
      const result = engageAccountKillSwitch(db, {
        account_id: account.account_id,
        actor: `privy:${account.account_id}`,
        now,
      });
      assert.equal(result.already_engaged, true);
      assert.equal(result.runtime_keys_revoked, 0);
      assert.equal(
        agentSecurityEventsRepo.listByKind(db, "account_kill_switch_engaged").length,
        1,
      );
    });

    await check("release clears the flag and logs, but dead credentials stay dead", async () => {
      const result = releaseAccountKillSwitch(db, {
        account_id: account.account_id,
        actor: `privy:${account.account_id}`,
        now,
      });
      assert.equal(result.was_engaged, true);
      assert.equal(agentCredentialsDisabledAt(db, account.account_id), null);
      assert.equal(
        agentSecurityEventsRepo.listByKind(db, "account_kill_switch_released").length,
        1,
      );
      assert.equal(
        verifyRuntimeKey(db, { secret: popKey.secret, verifiedAt: at }),
        null,
      );
    });
  } finally {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  }

  process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

await main();
