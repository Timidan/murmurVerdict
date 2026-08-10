// ─── dispatcher.smoke.ts ───────────────────────────────────────────────────
//
// Characterization smoke for the tier-aware auth dispatcher (dispatcher.ts).
// dispatchAuth is the centralized auth entry point — Privy bearer, then
// Runtime Key, then legacy account API key — and __resolveCasualIdentity
// owns the §7.1 ownership policy. dispatcher.ts:82-92 documents that
// __resolveCasualIdentity was exported (with __ prefix) precisely so a smoke
// could drive every branch without minting real Privy tokens; this is that
// smoke. It locks the CURRENT behavior before the planned shared-resolver
// refactor so any drift in:
//   - the fallthrough ORDER (Privy → Runtime Key → API key),
//   - the throw-don't-fall-through short-circuit on an unowned slug
//     (a held Privy token must not get a second auth chance), and
//   - the §7.1 ownership policy branches
// fails loudly.
//
// Scope boundary: the positive Runtime Key branch (dispatcher.ts:209) and
// the Runtime Key slug-mismatch throw (dispatcher.ts:212) require a bound +
// currently-attested Controller Wallet and are OUTSIDE the planned
// Privy-resolver refactor's blast radius (that refactor only touches the
// Privy path + account resolution, not the Runtime Key block). They are
// deliberately left unpinned here; this smoke locks the Privy policy
// branches, the dispatch ORDER, the Runtime Key OPT-IN gate, and the
// fallthrough — the behavior the refactor actually moves.

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request } from "express";

import { __resolveCasualIdentity, dispatchAuth } from "./dispatcher.js";
import {
  getAccountByPrivyUserId,
  getOrCreateAccount,
  linkAgentToAccount,
  mintApiKey,
} from "./accounts.js";
import { agentsRepo } from "../repos/agents-repo.js";
import { openDb } from "../db.js";
import { VerdictError } from "../schema.js";
import { verifyPrivyBearer, type PrivyAuthVerifier, type PrivyClaims } from "./privy.js";

process.stdout.write("murmur auth dispatcher smoke\n");

const tmp = mkdtempSync(join(tmpdir(), "murmur-dispatcher-"));
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

const at = new Date("2026-06-10T12:00:00Z");

async function main(): Promise<void> {
  const db = openDb({ path: dbPath });
  try {
    // ── Fixtures ──────────────────────────────────────────────────────
    // Owner A with a single agent; Owner B with two agents; an orphan
    // agent owned by nobody. Each Privy user maps to its own account.
    const ownerAClaims: PrivyClaims = {
      privy_user_id: "did:privy:owner-a",
      session_id: "s-a",
      expires_at: "2026-06-11T12:00:00Z",
      email: "a@example.test",
      primary_login_method: "email",
    };
    const ownerBClaims: PrivyClaims = {
      privy_user_id: "did:privy:owner-b",
      session_id: "s-b",
      expires_at: "2026-06-11T12:00:00Z",
      email: "b@example.test",
      primary_login_method: "email",
    };
    const strangerClaims: PrivyClaims = {
      privy_user_id: "did:privy:stranger",
      session_id: "s-x",
      expires_at: "2026-06-11T12:00:00Z",
      email: "x@example.test",
      primary_login_method: "email",
    };

    let idSeq = 0;
    const newAccountId = () => `acct-${++idSeq}`;
    const accountA = getOrCreateAccount(db, ownerAClaims, { resolvedAt: at, newAccountId }).account_id;
    const accountB = getOrCreateAccount(db, ownerBClaims, { resolvedAt: at, newAccountId }).account_id;
    // Stranger has a Privy account row but owns no agents.
    const accountStranger = getOrCreateAccount(db, strangerClaims, { resolvedAt: at, newAccountId }).account_id;

    agentsRepo.insert(db, {
      agent_id: "agent-a1",
      display_slug: "agent-a1",
      kind: "agent",
      display_name: "Agent A1",
      created_at: "2026-06-10T00:00:00Z",
    });
    agentsRepo.insert(db, {
      agent_id: "agent-b1",
      display_slug: "agent-b1",
      kind: "benchmark",
      display_name: "Agent B1",
      created_at: "2026-06-10T00:00:00Z",
    });
    agentsRepo.insert(db, {
      agent_id: "agent-b2",
      display_slug: "agent-b2",
      kind: "agent",
      display_name: "Agent B2",
      created_at: "2026-06-10T00:00:00Z",
    });
    agentsRepo.insert(db, {
      agent_id: "agent-orphan",
      display_slug: "agent-orphan",
      kind: "agent",
      display_name: "Orphan",
      created_at: "2026-06-10T00:00:00Z",
    });
    linkAgentToAccount(db, accountA, "agent-a1", { linkedAt: at });
    linkAgentToAccount(db, accountB, "agent-b1", { linkedAt: at });
    linkAgentToAccount(db, accountB, "agent-b2", { linkedAt: at });

    // ── A. __resolveCasualIdentity — every §7.1 policy branch ─────────

    await check("slug for unknown agent → throws unknown_agent 404", () => {
      assert.throws(
        () => __resolveCasualIdentity(db, ownerAClaims, "does-not-exist"),
        (err) =>
          err instanceof VerdictError &&
          err.httpStatus === 404 &&
          err.code === "unknown_agent",
      );
    });

    await check("slug + caller has no account → throws agent_not_owned_by_account 403", () => {
      const noAccountClaims: PrivyClaims = {
        ...ownerAClaims,
        privy_user_id: "did:privy:no-account-yet",
      };
      assert.throws(
        () => __resolveCasualIdentity(db, noAccountClaims, "agent-a1"),
        (err) =>
          err instanceof VerdictError &&
          err.httpStatus === 403 &&
          err.code === "agent_not_owned_by_account",
      );
    });

    await check("slug owned by a different account → throws agent_not_owned_by_account 403", () => {
      assert.throws(
        () => __resolveCasualIdentity(db, strangerClaims, "agent-a1"),
        (err) =>
          err instanceof VerdictError &&
          err.httpStatus === 403 &&
          err.code === "agent_not_owned_by_account",
      );
    });

    await check("slug for an existing but UNOWNED agent → throws agent_not_owned_by_account 403", () => {
      // agent-orphan has no ownership row, so getAccountForAgent returns no
      // owner; undefined !== account_id → 403. Distinct from the
      // owned-by-another-account branch above (null owner vs different owner).
      assert.throws(
        () => __resolveCasualIdentity(db, ownerAClaims, "agent-orphan"),
        (err) =>
          err instanceof VerdictError &&
          err.httpStatus === 403 &&
          err.code === "agent_not_owned_by_account",
      );
    });

    await check("slug owned by caller → casual privy identity bound to that agent", () => {
      const id = __resolveCasualIdentity(db, ownerAClaims, "agent-a1");
      assert.equal(id.tier, "casual");
      assert.equal(id.auth_mode, "privy");
      assert.equal(id.agent_id, "agent-a1");
      assert.equal(id.agent_kind, "agent");
      assert.equal(id.account_id, accountA);
      assert.equal(id.privy?.privy_user_id, ownerAClaims.privy_user_id);
    });

    await check("no slug + no account → casual identity with no account/agent binding", () => {
      const noAccountClaims: PrivyClaims = {
        ...ownerAClaims,
        privy_user_id: "did:privy:fresh-bearer",
      };
      const id = __resolveCasualIdentity(db, noAccountClaims, undefined);
      assert.equal(id.tier, "casual");
      assert.equal(id.auth_mode, "privy");
      assert.equal(id.account_id, undefined);
      assert.equal(id.agent_id, undefined);
    });

    await check("no slug + account with zero agents → account bound, no agent", () => {
      const id = __resolveCasualIdentity(db, strangerClaims, undefined);
      assert.equal(id.tier, "casual");
      assert.equal(id.auth_mode, "privy");
      assert.equal(id.privy?.privy_user_id, strangerClaims.privy_user_id);
      assert.equal(id.account_id, accountStranger);
      assert.equal(id.agent_id, undefined);
    });

    await check("no slug + single-agent account → smart default binds the one agent", () => {
      const id = __resolveCasualIdentity(db, ownerAClaims, undefined);
      assert.equal(id.tier, "casual");
      assert.equal(id.auth_mode, "privy");
      assert.equal(id.privy?.privy_user_id, ownerAClaims.privy_user_id);
      assert.equal(id.account_id, accountA);
      assert.equal(id.agent_id, "agent-a1");
      assert.equal(id.agent_kind, "agent");
    });

    await check("no slug + multi-agent account → throws agent_slug_required 400", () => {
      assert.throws(
        () => __resolveCasualIdentity(db, ownerBClaims, undefined),
        (err) =>
          err instanceof VerdictError &&
          err.httpStatus === 400 &&
          err.code === "agent_slug_required",
      );
    });

    // ── B. dispatchAuth — decision tree, ordering, fallthrough ────────

    const verifier = fakeVerifier({
      "tok-a": ownerAClaims,
      "tok-b": ownerBClaims,
    });
    // Legacy account API key for agent-a1, used to prove fallthrough.
    const apiKey = mintApiKey(db, {
      account_id: accountA,
      agent_id: "agent-a1",
      createdAt: at,
    }).secret;
    const now = () => at;

    await check("no headers → null", async () => {
      const id = await dispatchAuth(fakeRequest({}), { db, now, privyAuth: verifier });
      assert.equal(id, null);
    });

    await check("Bearer present but no privyAuth configured → Privy mode skipped → null", async () => {
      const id = await dispatchAuth(
        fakeRequest({ authorization: "Bearer tok-a" }),
        { db, now },
      );
      assert.equal(id, null);
    });

    await check("valid Bearer (single-agent account) → privy identity", async () => {
      const id = await dispatchAuth(
        fakeRequest({ authorization: "Bearer tok-a" }),
        { db, now, privyAuth: verifier },
      );
      assert.equal(id?.auth_mode, "privy");
      assert.equal(id?.agent_id, "agent-a1");
      assert.equal(id?.account_id, accountA);
    });

    await check("READ-ONLY: dispatch auth for a fresh Privy user creates NO account row", async () => {
      // The dispatcher account lookup is "read" mode — gateway/feed/dispatch
      // auth must never create an account as a side effect. A Privy user with
      // no account hits Path B (no agent) and must leave the accounts table
      // untouched. Guards against the refactor accidentally wiring
      // create_or_touch into the dispatch path.
      const freshClaims: PrivyClaims = {
        ...ownerAClaims,
        privy_user_id: "did:privy:dispatch-must-not-create",
      };
      const freshVerifier = fakeVerifier({ "tok-fresh": freshClaims });
      assert.equal(getAccountByPrivyUserId(db, freshClaims.privy_user_id), null);
      const id = await dispatchAuth(
        fakeRequest({ authorization: "Bearer tok-fresh" }),
        { db, now, privyAuth: freshVerifier },
      );
      assert.equal(id?.auth_mode, "privy");
      assert.equal(id?.account_id, undefined);
      assert.equal(
        getAccountByPrivyUserId(db, freshClaims.privy_user_id),
        null,
        "dispatch auth must not have created an account row",
      );
    });

    await check("SECURITY: valid Bearer + unowned slug + valid API key → THROWS, no fall-through to API key", async () => {
      // A held Privy token asking to act as an unowned agent must NOT get a
      // second auth chance via the API-key header. dispatcher.ts:76-80.
      await assert.rejects(
        () =>
          dispatchAuth(
            fakeRequest({
              authorization: "Bearer tok-a",
              "x-murmur-agent-slug": "agent-b1",
              "x-murmur-api-key": apiKey,
            }),
            { db, now, privyAuth: verifier },
          ),
        (err) =>
          err instanceof VerdictError &&
          err.httpStatus === 403 &&
          err.code === "agent_not_owned_by_account",
      );
    });

    await check("invalid Bearer + valid API key → falls through to api_key", async () => {
      const id = await dispatchAuth(
        fakeRequest({ authorization: "Bearer bogus", "x-murmur-api-key": apiKey }),
        { db, now, privyAuth: verifier },
      );
      assert.equal(id?.auth_mode, "api_key");
      assert.equal(id?.agent_id, "agent-a1");
      assert.equal(id?.account_id, accountA);
      assert.equal(id?.agent_kind, "agent");
    });

    await check("Runtime Key opt-in OFF: runtime-key path never consulted, falls through to api_key", async () => {
      // Sentinel: dispatchAuth only calls now() inside the Runtime Key block
      // (verifiedAt = deps.now()). A throwing clock proves the block is NOT
      // entered when allowRuntimeKey is unset — a dispatcher that ignored the
      // opt-in gate would call now() and blow up instead of falling through.
      const throwingNow = () => {
        throw new Error("now() must not be called when allowRuntimeKey is off");
      };
      const id = await dispatchAuth(
        fakeRequest({
          "x-murmur-runtime-key": "mrt_" + "0".repeat(64),
          "x-murmur-api-key": apiKey,
        }),
        { db, now: throwingNow, privyAuth: verifier },
      );
      assert.equal(id?.auth_mode, "api_key");
    });

    await check("Runtime Key opt-in ON but key invalid → falls through to api_key", async () => {
      const id = await dispatchAuth(
        fakeRequest({
          "x-murmur-runtime-key": "mrt_" + "0".repeat(64),
          "x-murmur-api-key": apiKey,
        }),
        { db, now, privyAuth: verifier, allowRuntimeKey: true },
      );
      assert.equal(id?.auth_mode, "api_key");
    });

    await check("ORDER: valid Bearer wins over a present API key (Privy is mode 1)", async () => {
      const id = await dispatchAuth(
        fakeRequest({ authorization: "Bearer tok-a", "x-murmur-api-key": apiKey }),
        { db, now, privyAuth: verifier },
      );
      assert.equal(id?.auth_mode, "privy");
    });

    await check("valid API key alone → api_key identity", async () => {
      const id = await dispatchAuth(
        fakeRequest({ "x-murmur-api-key": apiKey }),
        { db, now, privyAuth: verifier },
      );
      assert.equal(id?.tier, "casual");
      assert.equal(id?.auth_mode, "api_key");
      assert.equal(id?.agent_id, "agent-a1");
      assert.equal(id?.account_id, accountA);
      assert.equal(id?.agent_kind, "agent");
    });

    // ── C. verifyPrivyBearer — the shared extraction's exact contract ──
    // These pin the load-bearing helper contract by test rather than review:
    // a try/catch or empty-token guard would silently change the
    // dispatcher/webhooks fall-through-vs-propagate behavior.

    await check("verifyPrivyBearer: no verifier → null (even with valid Bearer)", async () => {
      assert.equal(
        await verifyPrivyBearer(fakeRequest({ authorization: "Bearer tok-a" }), undefined),
        null,
      );
    });

    await check("verifyPrivyBearer: non-Bearer Authorization header → null WITHOUT calling verify", async () => {
      // A non-Bearer scheme must short-circuit before verify — otherwise the
      // helper would feed a Basic-auth blob to Privy. Sentinel verifier proves
      // verify is never invoked.
      let called = false;
      const sentinel: PrivyAuthVerifier = {
        isEnabled: () => true,
        async verify() {
          called = true;
          return null;
        },
        async hydrateProfile() {
          return {};
        },
      };
      const out = await verifyPrivyBearer(
        fakeRequest({ authorization: "Basic dXNlcjpwYXNz" }),
        sentinel,
      );
      assert.equal(out, null);
      assert.equal(called, false, "non-Bearer header must not reach verify");
    });

    await check("verifyPrivyBearer: NO empty-token guard — empty token is passed straight to verify", async () => {
      let seen: string | undefined;
      const recordingVerifier: PrivyAuthVerifier = {
        isEnabled: () => true,
        async verify(token: string) {
          seen = token;
          return null;
        },
        async hydrateProfile() {
          return {};
        },
      };
      const out = await verifyPrivyBearer(
        fakeRequest({ authorization: "Bearer    " }),
        recordingVerifier,
      );
      assert.equal(out, null);
      assert.equal(seen, "", "the trimmed empty token must reach verify, not be short-circuited");
    });

    await check("verifyPrivyBearer: NO try/catch — a verifier exception propagates", async () => {
      const throwingVerifier: PrivyAuthVerifier = {
        isEnabled: () => true,
        async verify() {
          throw new Error("verifier boom");
        },
        async hydrateProfile() {
          return {};
        },
      };
      await assert.rejects(
        () => verifyPrivyBearer(fakeRequest({ authorization: "Bearer tok-a" }), throwingVerifier),
        (err) => err instanceof Error && err.message === "verifier boom",
      );
    });

    db.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  process.stdout.write(`auth dispatcher smoke ok (${passed} checks)\n`);
}

void main();
