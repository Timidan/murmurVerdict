// ─── webhooks-auth.smoke.ts ─────────────────────────────────────────────────
//
// Characterization smoke for the POST /v1/webhooks account-only auth helper
// (authenticateWebhookAccount in routes/webhooks.ts). Before this wave the
// webhook ROUTE auth path had no coverage — webhooks.smoke.ts exercises
// OUTBOUND webhook dispatch, not inbound auth. This locks the behavior the
// shared-Privy-resolver refactor touches:
//   - a verified Privy bearer with an existing account → privy identity,
//   - a verified bearer with NO Murmur account FALLS THROUGH to the api-key
//     tier (must not 401 — a client sending both creds still succeeds),
//   - read-only: that fall-through must NOT create an account row,
//   - api key alone → api_key identity,
//   - no usable credential → null (the route turns this into 401).

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request } from "express";

import { authenticateWebhookAccount } from "../auth/webhook-account-auth.js";
import {
  getAccountByPrivyUserId,
  getOrCreateAccount,
  mintApiKey,
} from "../auth/accounts.js";
import { agentsRepo } from "../repos/agents-repo.js";
import { openDb } from "../db.js";
import type { PrivyAuthVerifier, PrivyClaims } from "../auth/privy.js";

process.stdout.write("murmur webhook route auth smoke\n");

const tmp = mkdtempSync(join(tmpdir(), "murmur-webhook-auth-"));
const dbPath = join(tmp, "test.db");

let passed = 0;
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve(fn()).then(
    () => {
      passed++;
      process.stdout.write(`  ok ${name}\n`);
    },
    (err) => {
      process.exitCode = 1;
      process.stdout.write(`  FAIL ${name}\n    ${(err as Error).message}\n`);
      throw err;
    },
  );
}

function fakeVerifier(tokens: Record<string, PrivyClaims>): PrivyAuthVerifier {
  return {
    isEnabled: () => true,
    async verify(authToken: string): Promise<PrivyClaims | null> {
      return tokens[authToken] ?? null;
    },
    async hydrateProfile() {
      return {};
    },
  };
}

function fakeRequest(headers: Record<string, string>): Request {
  const normalized = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  return {
    header(name: string): string | undefined {
      return normalized[name.toLowerCase()];
    },
  } as unknown as Request;
}

const at = new Date("2026-06-16T12:00:00Z");

async function main(): Promise<void> {
  const db = openDb({ path: dbPath });
  try {
    const ownerClaims: PrivyClaims = {
      privy_user_id: "did:privy:webhook-owner",
      session_id: "s-1",
      expires_at: "2026-06-17T12:00:00Z",
      email: "o@example.test",
      primary_login_method: "email",
    };
    // A Privy user who has verified a bearer but never completed
    // /v1/account/session — has NO Murmur account row.
    const noAccountClaims: PrivyClaims = {
      privy_user_id: "did:privy:webhook-no-account",
      session_id: "s-2",
      expires_at: "2026-06-17T12:00:00Z",
      email: "n@example.test",
      primary_login_method: "email",
    };

    let idSeq = 0;
    const accountId = getOrCreateAccount(db, ownerClaims, {
      resolvedAt: at,
      newAccountId: () => `acct-${++idSeq}`,
    }).account_id;
    agentsRepo.insert(db, {
      agent_id: "wh-agent",
      display_slug: "wh-agent",
      kind: "agent",
      display_name: "Webhook Agent",
      created_at: "2026-06-16T00:00:00Z",
    });
    const apiKey = mintApiKey(db, {
      account_id: accountId,
      agent_id: "wh-agent",
      createdAt: at,
    }).secret;

    const verifier = fakeVerifier({
      "tok-owner": ownerClaims,
      "tok-no-account": noAccountClaims,
    });

    await check("verified bearer + existing account → privy identity", async () => {
      const id = await authenticateWebhookAccount(
        fakeRequest({ authorization: "Bearer tok-owner" }),
        { db, privyAuth: verifier },
      );
      assert.equal(id?.auth_mode, "privy");
      assert.equal(id?.account_id, accountId);
    });

    await check("verified bearer + NO account + valid API key → FALLS THROUGH to api_key", async () => {
      const id = await authenticateWebhookAccount(
        fakeRequest({
          authorization: "Bearer tok-no-account",
          "x-murmur-api-key": apiKey,
        }),
        { db, privyAuth: verifier },
      );
      assert.equal(id?.auth_mode, "api_key");
      assert.equal(id?.account_id, accountId);
    });

    await check("READ-ONLY: verified bearer + no account creates NO account row", async () => {
      assert.equal(getAccountByPrivyUserId(db, noAccountClaims.privy_user_id), null);
      await authenticateWebhookAccount(
        fakeRequest({ authorization: "Bearer tok-no-account" }),
        { db, privyAuth: verifier },
      );
      assert.equal(
        getAccountByPrivyUserId(db, noAccountClaims.privy_user_id),
        null,
        "webhook auth must not create an account row",
      );
    });

    await check("verified bearer + no account + no API key → null", async () => {
      const id = await authenticateWebhookAccount(
        fakeRequest({ authorization: "Bearer tok-no-account" }),
        { db, privyAuth: verifier },
      );
      assert.equal(id, null);
    });

    await check("valid API key alone → api_key identity", async () => {
      const id = await authenticateWebhookAccount(
        fakeRequest({ "x-murmur-api-key": apiKey }),
        { db, privyAuth: verifier },
      );
      assert.equal(id?.auth_mode, "api_key");
      assert.equal(id?.account_id, accountId);
    });

    await check("no privyAuth configured + valid Bearer → bearer ignored, api_key still honored", async () => {
      const id = await authenticateWebhookAccount(
        fakeRequest({ authorization: "Bearer tok-owner", "x-murmur-api-key": apiKey }),
        { db },
      );
      assert.equal(id?.auth_mode, "api_key");
    });

    await check("no credentials → null", async () => {
      const id = await authenticateWebhookAccount(fakeRequest({}), {
        db,
        privyAuth: verifier,
      });
      assert.equal(id, null);
    });

    db.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  process.stdout.write(`webhook route auth smoke ok (${passed} checks)\n`);
}

void main();
