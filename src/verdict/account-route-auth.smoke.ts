import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request } from "express";

import {
  accountAuthRequiredError,
  requireAccount,
  resolveAccount,
} from "./account-route-auth.js";
import { getAccountByPrivyUserId } from "./auth/accounts.js";
import { openDb } from "./db.js";
import { VerdictError } from "./schema.js";
import type { PrivyAuthVerifier, PrivyClaims } from "./auth/privy.js";

process.stdout.write("murmur Account Route Auth smoke\n");

const tmp = mkdtempSync(join(tmpdir(), "murmur-account-route-auth-"));
const dbPath = join(tmp, "test.db");

try {
  const db = openDb({ path: dbPath });
  // Production-accurate: the Privy ACCESS token carries no email/login_method.
  // verify() returns bare claims; email + primary_login_method are derived
  // separately via hydrateProfile on account CREATION only.
  const claims: PrivyClaims = {
    privy_user_id: "did:privy:account-route-auth",
    session_id: "session-1",
    expires_at: "2026-06-12T12:00:00Z",
  };
  let hydrateProfileCalls = 0;
  let disallowHydrate = false;
  const verifier = fakeVerifier(
    { "valid-token": claims },
    {
      profile: { email: "maya@example.test", primary_login_method: "email" },
      onHydrate: () => {
        if (disallowHydrate) {
          throw new Error("touch (non-created) call must not hydrate profile");
        }
        hydrateProfileCalls += 1;
      },
    },
  );
  let clock = new Date("2026-06-12T10:00:00Z");
  const now = () => clock;
  const accountIds: string[] = [];
  const newAccountId = () => {
    const id = `account-route-auth-id-${accountIds.length + 1}`;
    accountIds.push(id);
    return id;
  };

  assert.equal(
    await resolveAccount(fakeRequest({}), db, verifier, {
      newAccountId: () => {
        throw new Error("missing bearer should not mint account id");
      },
      now,
    }),
    null,
  );
  await assert.rejects(
    () =>
      requireAccount(fakeRequest({}), db, verifier, {
        newAccountId: () => {
          throw new Error("missing bearer should not mint account id");
        },
        now,
      }),
    (err) =>
      err instanceof VerdictError &&
      err.httpStatus === 401 &&
      err.code === "agent_not_authorized" &&
      err.message === "auth required",
  );
  await assert.rejects(
    () =>
      requireAccount(fakeRequest({ authorization: "Bearer bad-token" }), db, verifier, {
        message: "invalid or missing Privy bearer token",
        newAccountId: () => {
          throw new Error("invalid token should not mint account id");
        },
        now,
      }),
    (err) =>
      err instanceof VerdictError &&
      err.httpStatus === 401 &&
      err.code === "agent_not_authorized" &&
      err.message === "invalid or missing Privy bearer token",
  );

  const created = await requireAccount(
    fakeRequest({ authorization: "Bearer valid-token" }),
    db,
    verifier,
    { newAccountId, now },
  );
  assert.equal(created.created, true);
  assert.equal(created.claims.privy_user_id, claims.privy_user_id);
  assert.equal(created.account_id, "account-route-auth-id-1");
  assert.deepEqual(accountIds, ["account-route-auth-id-1"]);
  const createdRow = getAccountByPrivyUserId(db, claims.privy_user_id);
  assert.ok(createdRow);
  assert.equal(createdRow.created_at, "2026-06-12T10:00:00Z");
  assert.equal(createdRow.last_seen_at, "2026-06-12T10:00:00Z");
  // hydrateProfile fired exactly once (on creation) and backfilled the row.
  assert.equal(hydrateProfileCalls, 1);
  assert.equal(createdRow.email, "maya@example.test");
  assert.equal(createdRow.primary_login_method, "email");
  // The merged claims returned to the caller also carry the hydrated fields.
  assert.equal(created.claims.email, "maya@example.test");
  assert.equal(created.claims.primary_login_method, "email");

  // Repeat (touch) call for the SAME user must NOT re-hydrate — the throw in
  // onHydrate below would fail the test loudly if the create-only gate leaked.
  disallowHydrate = true;
  clock = new Date("2026-06-12T10:05:00Z");
  const repeated = await requireAccount(
    fakeRequest({ Authorization: "bearer valid-token" }),
    db,
    verifier,
    {
      newAccountId: () => {
        throw new Error("existing account should not mint account id");
      },
      now,
    },
  );
  assert.equal(repeated.account_id, created.account_id);
  assert.equal(repeated.created, false);
  const repeatedRow = getAccountByPrivyUserId(db, claims.privy_user_id);
  assert.ok(repeatedRow);
  assert.equal(repeatedRow.created_at, "2026-06-12T10:00:00Z");
  assert.equal(repeatedRow.last_seen_at, "2026-06-12T10:05:00Z");
  assert.deepEqual(accountIds, ["account-route-auth-id-1"]);
  // Still exactly one hydrate across create + touch: the gate held.
  assert.equal(hydrateProfileCalls, 1);
  disallowHydrate = false;

  const err = accountAuthRequiredError("custom owner auth required");
  assert.equal(err.httpStatus, 401);
  assert.equal(err.code, "agent_not_authorized");
  assert.equal(err.message, "custom owner auth required");

  db.close();
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

process.stdout.write("Account Route Auth smoke ok\n");

function fakeVerifier(
  tokens: Record<string, PrivyClaims>,
  hydrate?: {
    profile: { email?: string; primary_login_method?: string };
    onHydrate?: () => void;
  },
): PrivyAuthVerifier {
  return {
    isEnabled: () => true,
    async verify(authToken: string): Promise<PrivyClaims | null> {
      return tokens[authToken] ?? null;
    },
    async hydrateProfile(): Promise<{ email?: string; primary_login_method?: string }> {
      hydrate?.onHydrate?.();
      return hydrate?.profile ?? {};
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
