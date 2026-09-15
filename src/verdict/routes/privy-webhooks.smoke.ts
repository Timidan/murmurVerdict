// ─── privy-webhooks.smoke.ts ────────────────────────────────────────────────
// Locks the POST /v1/privy/webhooks status matrix and reparent args, with a fake verifier and reparent.
//
// Matrix covered:
//   valid transfer            → reparent called with {from,to} → 200
//   verifier disabled         → 503 (no verify / no reparent)
//   bad signature (throws)    → 400
//   missing svix header       → 400 (verify not called)
//   unknown event ("other")   → 204 (no reparent)
//   reparent throws           → 500 (logged)

import { strict as assert } from "node:assert";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import type Database from "better-sqlite3";

import { privyWebhookRouter, type ReparentFn } from "./privy-webhooks.js";
import type {
  PrivyWebhookEvent,
  PrivyWebhookVerifier,
} from "../auth/privy-webhook-verify.js";

process.stdout.write("murmur privy webhook route smoke\n");

let passed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    process.stdout.write(`  ok ${name}\n`);
  } catch (err) {
    process.exitCode = 1;
    process.stdout.write(`  FAIL ${name}\n    ${(err as Error).message}\n`);
    throw err;
  }
}

// The route only passes `db` straight through to the (fake) reparent, so a
// stub is sufficient and keeps the smoke free of DB bootstrap.
const db = {} as unknown as Database.Database;

interface VerifierCall {
  raw: string;
  headers: { svixId: string; svixTimestamp: string; svixSignature: string };
}

function makeVerifier(opts: {
  enabled: boolean;
  behavior?: "transfer" | "other" | "throw";
  from?: string;
  to?: string;
}): { verifier: PrivyWebhookVerifier; calls: VerifierCall[] } {
  const calls: VerifierCall[] = [];
  const verifier: PrivyWebhookVerifier = {
    enabled: () => opts.enabled,
    async verify(raw, headers): Promise<PrivyWebhookEvent> {
      calls.push({ raw, headers });
      if (opts.behavior === "throw") {
        throw new Error("fake bad signature");
      }
      if (opts.behavior === "other") {
        return { type: "other" };
      }
      return {
        type: "user.transferred_account",
        fromPrivyUserId: opts.from ?? "did:privy:from",
        toPrivyUserId: opts.to ?? "did:privy:to",
      };
    },
  };
  return { verifier, calls };
}

interface ReparentCall {
  fromPrivyUserId: string;
  toPrivyUserId: string;
}

function makeReparent(opts: {
  throws?: boolean;
  result?: ReturnType<ReparentFn>;
}): { reparent: ReparentFn; calls: ReparentCall[] } {
  const calls: ReparentCall[] = [];
  const reparent: ReparentFn = (_db, args) => {
    calls.push({ ...args });
    if (opts.throws) throw new Error("fake reparent failure");
    return (
      opts.result ?? {
        status: "merged",
        from_account_id: "acct-from",
        to_account_id: "acct-to",
        moved: { account_agents: 2, api_keys: 1 },
      }
    );
  };
  return { reparent, calls };
}

async function withServer(
  deps: Parameters<typeof privyWebhookRouter>[0],
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(privyWebhookRouter(deps));
  const server: Server = await new Promise((resolvePromise) => {
    const s = app.listen(0, "127.0.0.1", () => resolvePromise(s));
  });
  try {
    const { port } = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((res) => server.close(() => res()));
  }
}

const VALID_HEADERS = {
  "content-type": "application/json",
  "svix-id": "msg_1",
  "svix-timestamp": "1700000000",
  "svix-signature": "v1,fakesig",
};

async function main(): Promise<void> {
  await check("valid transfer → reparent called with right args → 200", async () => {
    const { verifier, calls } = makeVerifier({
      enabled: true,
      behavior: "transfer",
      from: "did:privy:src",
      to: "did:privy:dst",
    });
    const { reparent, calls: reparentCalls } = makeReparent({});
    await withServer({ db, verifier, reparent }, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/v1/privy/webhooks`, {
        method: "POST",
        headers: VALID_HEADERS,
        body: JSON.stringify({ type: "user.transferred_account" }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { ok: boolean; status: string; moved: Record<string, number> };
      assert.equal(body.ok, true);
      assert.equal(body.status, "merged");
      assert.deepEqual(body.moved, { account_agents: 2, api_keys: 1 });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].headers.svixId, "msg_1");
      assert.equal(reparentCalls.length, 1);
      assert.deepEqual(reparentCalls[0], {
        fromPrivyUserId: "did:privy:src",
        toPrivyUserId: "did:privy:dst",
      });
    });
  });

  await check("verifier disabled → 503, no verify / no reparent", async () => {
    const { verifier, calls } = makeVerifier({ enabled: false });
    const { reparent, calls: reparentCalls } = makeReparent({});
    await withServer({ db, verifier, reparent }, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/v1/privy/webhooks`, {
        method: "POST",
        headers: VALID_HEADERS,
        body: JSON.stringify({ type: "user.transferred_account" }),
      });
      assert.equal(res.status, 503);
      const body = (await res.json()) as { code: string };
      assert.equal(body.code, "privy_webhook_disabled");
      assert.equal(calls.length, 0);
      assert.equal(reparentCalls.length, 0);
    });
  });

  await check("bad signature (verify throws) → 400", async () => {
    const { verifier } = makeVerifier({ enabled: true, behavior: "throw" });
    const { reparent, calls: reparentCalls } = makeReparent({});
    await withServer({ db, verifier, reparent }, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/v1/privy/webhooks`, {
        method: "POST",
        headers: VALID_HEADERS,
        body: JSON.stringify({ type: "user.transferred_account" }),
      });
      assert.equal(res.status, 400);
      const body = (await res.json()) as { code: string };
      assert.equal(body.code, "invalid_signature");
      assert.equal(reparentCalls.length, 0);
    });
  });

  await check("missing svix header → 400, verify not called", async () => {
    const { verifier, calls } = makeVerifier({ enabled: true, behavior: "transfer" });
    const { reparent } = makeReparent({});
    await withServer({ db, verifier, reparent }, async (baseUrl) => {
      const { ["svix-signature"]: _omit, ...headersNoSig } = VALID_HEADERS;
      const res = await fetch(`${baseUrl}/v1/privy/webhooks`, {
        method: "POST",
        headers: headersNoSig,
        body: JSON.stringify({ type: "user.transferred_account" }),
      });
      assert.equal(res.status, 400);
      const body = (await res.json()) as { code: string };
      assert.equal(body.code, "missing_svix_headers");
      assert.equal(calls.length, 0, "verify must not run without svix headers");
    });
  });

  await check("unknown event (other) → 204, no reparent", async () => {
    const { verifier } = makeVerifier({ enabled: true, behavior: "other" });
    const { reparent, calls: reparentCalls } = makeReparent({});
    await withServer({ db, verifier, reparent }, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/v1/privy/webhooks`, {
        method: "POST",
        headers: VALID_HEADERS,
        body: JSON.stringify({ type: "user.created" }),
      });
      assert.equal(res.status, 204);
      assert.equal(reparentCalls.length, 0);
    });
  });

  await check("reparent throws → 500 (logged)", async () => {
    const { verifier } = makeVerifier({ enabled: true, behavior: "transfer" });
    const { reparent, calls: reparentCalls } = makeReparent({ throws: true });
    const logged: unknown[][] = [];
    const logger = { error: (...a: unknown[]) => logged.push(a) };
    await withServer({ db, verifier, reparent, logger }, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/v1/privy/webhooks`, {
        method: "POST",
        headers: VALID_HEADERS,
        body: JSON.stringify({ type: "user.transferred_account" }),
      });
      assert.equal(res.status, 500);
      const body = (await res.json()) as { code: string };
      assert.equal(body.code, "reparent_failed");
      assert.equal(reparentCalls.length, 1);
      assert.ok(logged.length >= 1, "reparent failure must be logged");
    });
  });

  process.stdout.write(`privy webhook route smoke ok (${passed} checks)\n`);
}

void main();
