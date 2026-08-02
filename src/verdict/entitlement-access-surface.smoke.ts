import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  GrantChainAdapter,
  GrantDecryptAccessView,
} from "../integrations/fhenix-grant-env.js";
import { openDb } from "./db.js";
import type { EntitlementAccessDeps, SettleOutcome } from "./entitlement-access.js";
import {
  entitlementAccessResponse,
  entitlementStatusResponse,
  type EntitlementPaymentBroker,
  type EntitlementAccessSurfaceDeps,
} from "./entitlement-access-surface.js";

process.stdout.write("murmur entitlement access surface smoke\n");

const CHAIN_ID = 84532;
const CONTRACT = "0x1B74A4bAb1E06Ed107780a245c85337AB9dEcD1A";
const PAYER = "0xCAFEbabeCAFEbabeCAFEbabeCAFEbabeCAFEbabe";
const CALL = "0x" + "ab".repeat(32);
const NOW = new Date("2026-07-20T00:00:00.000Z");
const NOW_SEC = Math.floor(NOW.getTime() / 1000);

const openView: GrantDecryptAccessView = {
  state: 1,
  revealOpenAt: NOW_SEC + 3600,
  binaryIndexCtHash: "0x0000000000000000000000000000000000000000000000000000000000000abc",
  confidenceCtHash: "0x0000000000000000000000000000000000000000000000000000000000000def",
  alreadyGranted: false,
};

function chain(view: GrantDecryptAccessView | null): GrantChainAdapter {
  return {
    chainId: CHAIN_ID,
    contractAddress: CONTRACT,
    grantorAddress: "0xabc",
    async sendGrant() {
      return "0xGRANTTX";
    },
    async getReceipt() {
      return { blockNumber: 5, success: true, confirmations: 3 };
    },
    async readDecryptAccess() {
      return view;
    },
    async getBalanceWei() {
      return 1n;
    },
  };
}

function fakeBroker(opts: { authorizeCalls: { n: number } }): EntitlementPaymentBroker {
  return {
    async challenge() {
      return {
        scheme: "exact",
        network: "eip155:84532",
        asset: "0xUSDC",
        amount: "1000",
        payTo: "0xSELLER",
        maxTimeoutSeconds: 60,
      };
    },
    async authorize() {
      opts.authorizeCalls.n += 1;
      const settled: SettleOutcome = {
        kind: "settled",
        transaction: "circle-tx-1",
        payer: PAYER,
        amount: "1000",
        currency: "USDC",
      };
      return { ok: true, payment: { verifiedPayer: PAYER, settle: async () => settled } };
    },
  };
}

function deps(
  db: ReturnType<typeof openDb>,
  view: GrantDecryptAccessView | null,
  authorizeCalls: { n: number },
): EntitlementAccessSurfaceDeps {
  const access: EntitlementAccessDeps = {
    db,
    grantChain: chain(view),
    salesSafetySeconds: 180,
    now: () => NOW,
  };
  return {
    access,
    broker: fakeBroker({ authorizeCalls }),
    priceAtoms: "1000",
    currency: "USDC",
    pricingVersion: "v1",
  };
}

function newDb() {
  const tmp = mkdtempSync(join(tmpdir(), "ent-surface-"));
  return { db: openDb({ path: join(tmp, `${randomUUID()}.db`) }), tmp };
}

// Bad callId → 400.
{
  const { db, tmp } = newDb();
  const r = await entitlementAccessResponse({
    deps: deps(db, openView, { n: 0 }),
    onchainCallId: "0xnope",
    paymentHeader: undefined,
  });
  assert.equal(r.status, 400);
  db.close();
  rmSync(tmp, { recursive: true, force: true });
}

// Sale window closed → 409 before any 402 or broker authorize.
{
  const { db, tmp } = newDb();
  const calls = { n: 0 };
  const r = await entitlementAccessResponse({
    deps: deps(db, { ...openView, revealOpenAt: NOW_SEC + 60 }, calls),
    onchainCallId: CALL,
    paymentHeader: "anything",
  });
  assert.equal(r.status, 409);
  assert.equal(calls.n, 0, "broker not invoked when window closed");
  db.close();
  rmSync(tmp, { recursive: true, force: true });
}

// Eligible, no payment → 402 with challenge accepts.
{
  const { db, tmp } = newDb();
  const r = await entitlementAccessResponse({
    deps: deps(db, openView, { n: 0 }),
    onchainCallId: CALL,
    paymentHeader: undefined,
  });
  assert.equal(r.status, 402);
  assert.ok(Array.isArray((r.body as { accepts: unknown[] }).accepts));
  db.close();
  rmSync(tmp, { recursive: true, force: true });
}

// Eligible + payment → granted 200.
{
  const { db, tmp } = newDb();
  const d = deps(db, openView, { n: 0 });
  const r = await entitlementAccessResponse({
    deps: d,
    onchainCallId: CALL,
    paymentHeader: "base64payment",
  });
  assert.equal(r.status, 200);
  assert.equal((r.body as { granted: boolean }).granted, true);

  // Status endpoint returns ct handles + FheTypes hints + revealOpenAt.
  const status = await entitlementStatusResponse({
    deps: d,
    onchainCallId: CALL,
    subscriberAddress: PAYER,
  });
  assert.equal(status.status, 200);
  const body = status.body as {
    status: string;
    ciphertexts: {
      binaryIndex: { handle: string; fheType: string };
      confidenceBps: { handle: string; fheType: string };
    };
    revealOpenAt: number;
    grant: { onchainGranted: boolean };
  };
  assert.equal(body.status, "granted");
  assert.equal(body.ciphertexts.binaryIndex.fheType, "Uint8");
  assert.equal(body.ciphertexts.confidenceBps.fheType, "Uint16");
  assert.equal(body.ciphertexts.binaryIndex.handle, openView.binaryIndexCtHash);
  assert.equal(body.revealOpenAt, openView.revealOpenAt);
  db.close();
  rmSync(tmp, { recursive: true, force: true });
}

process.stdout.write("OK entitlement access surface smoke\n");
