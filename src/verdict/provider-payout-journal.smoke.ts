import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb } from "./db.js";
import {
  readProviderPayouts,
  recordProviderPayout,
} from "./provider-payout-journal.js";
import { readProviderEarnings } from "./provider-earnings-surface.js";
import { providerEarningsRepo } from "./repos/provider-earnings-repo.js";
import { providerPayoutsRepo } from "./repos/provider-payouts-repo.js";
import { VerdictError } from "./schema.js";

// ─── The payout journal ─────────────────────────────────────────────────────
//
// Retry-safe replay, 409 on a reused reference with new details, DB-enforced append-only,
// and a signed balance over the union of currencies.
process.stdout.write("murmur provider payout journal smoke\n");

const NOW = new Date("2026-08-11T09:00:00.000Z");
const NOW_ISO = "2026-08-11T09:00:00Z";
const CUTOFF = "2026-08-01T00:00:00Z";

type Db = ReturnType<typeof openDb>;

interface Harness {
  db: Db;
  tmp: string;
  agentId: string;
  accountId: string;
  slug: string;
}

function newHarness(): Harness {
  const tmp = mkdtempSync(join(tmpdir(), "provider-payouts-"));
  const db = openDb({ path: join(tmp, `${randomUUID()}.db`) });
  const agentId = randomUUID();
  const accountId = randomUUID();
  const slug = `payee-${agentId.slice(0, 8)}`;
  db.prepare(
    `INSERT INTO agents (agent_id, display_slug, kind, display_name, bio, created_at)
     VALUES (?, ?, 'agent', 'Paid Agent', NULL, ?)`,
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

function post(h: Harness, over: Record<string, unknown> = {}) {
  return recordProviderPayout({
    db: h.db,
    now: () => NOW,
    body: {
      agent_slug: h.slug,
      entry_type: "payout",
      currency: "USDC",
      amount_atoms: "1000000",
      tx_ref: "0xtransfer-1",
      payout_method: "usdc_base",
      destination_ref: "0x1111111111111111111111111111111111111111",
      earnings_cutoff_at: CUTOFF,
      ...over,
    },
  });
}

/** Accrue directly through the repo — the accrual PATH has its own smoke. */
function accrue(
  h: Harness,
  input: { net: string; gross?: string; fee?: string; currency?: string; id: number },
): void {
  // provider_earnings.entitlement_id is a FK onto the sale it came from.
  h.db
    .prepare(
      `INSERT INTO entitlements
         (id, chain_id, contract_address, onchain_call_id, subscriber_address,
          producer_agent_id, status, created_at, updated_at)
       VALUES (?, 84532, '0x1b74a4bab1e06ed107780a245c85337ab9decd1a', ?,
               '0xcafebabecafebabecafebabecafebabecafebabe', ?, 'granted', ?, ?)`,
    )
    .run(
      input.id,
      `0x${input.id.toString(16).padStart(4, "0")}`,
      h.agentId,
      NOW_ISO,
      NOW_ISO,
    );
  providerEarningsRepo.insert(h.db, {
    entitlement_id: input.id,
    producer_agent_id: h.agentId,
    chain_id: 84532,
    contract_address: "0x1b74a4bab1e06ed107780a245c85337ab9decd1a",
    onchain_call_id: `0x${input.id.toString(16).padStart(4, "0")}`,
    gross_atoms: input.gross ?? input.net,
    fee_bps: 0,
    fee_atoms: input.fee ?? "0",
    net_atoms: input.net,
    currency: input.currency ?? "USDC",
    accrual_source: "sale_snapshot",
    accrued_at: NOW_ISO,
  });
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

// ── 1. A payout lands, and lands once ──────────────────────────────────────
{
  const h = newHarness();
  const created = post(h);
  assert.equal(created.status, 201);
  const body = created.body as { recorded: boolean; payout: Record<string, unknown> };
  assert.equal(body.recorded, true);
  assert.equal(body.payout.currency, "USDC");
  assert.equal(body.payout.amount_atoms, "1000000");
  assert.equal(body.payout.agent_slug, h.slug);

  // Byte-identical replay → 200 with the SAME row, and still exactly one row.
  const replay = post(h);
  assert.equal(replay.status, 200);
  const replayBody = replay.body as { recorded: boolean; payout: { id: number } };
  assert.equal(replayBody.recorded, false);
  assert.equal(replayBody.payout.id, (body.payout as { id: number }).id);
  assert.equal(
    (h.db.prepare("SELECT COUNT(*) AS n FROM provider_payouts").get() as { n: number }).n,
    1,
  );

  // Same key, different content → 409. The journal never rewrites a row.
  expectVerdictError(() => post(h, { amount_atoms: "2000000" }), "duplicate", 409);
  expectVerdictError(() => post(h, { destination_ref: "0xbeef" }), "duplicate", 409);
  expectVerdictError(() => post(h, { note: "late note" }), "duplicate", 409);
  assert.equal(
    (h.db.prepare("SELECT COUNT(*) AS n FROM provider_payouts").get() as { n: number }).n,
    1,
  );

  // A different currency under the same tx_ref is a different entry.
  assert.equal(post(h, { currency: "EURC" }).status, 201);
  close(h);
}

// ── 2. Input validation refuses what the column would refuse ───────────────
{
  const h = newHarness();
  for (const bad of ["1abc", "0", "0100", "-5", "1.5", "", " "]) {
    expectVerdictError(
      () => post(h, { amount_atoms: bad, tx_ref: `t-${bad}` }),
      "schema_invalid",
      400,
    );
  }
  expectVerdictError(() => post(h, { entry_type: "adjustment" }), "schema_invalid", 400);
  expectVerdictError(() => post(h, { currency: "$" }), "schema_invalid", 400);
  expectVerdictError(() => post(h, { destination_ref: "" }), "schema_invalid", 400);
  // The cutoff is audit context, but it cannot be in the future of the row.
  expectVerdictError(
    () => post(h, { earnings_cutoff_at: "2027-01-01T00:00:00Z" }),
    "schema_invalid",
    400,
  );
  expectVerdictError(() => post(h, { agent_slug: "nobody" }), "unknown_agent", 404);
  assert.equal(
    (h.db.prepare("SELECT COUNT(*) AS n FROM provider_payouts").get() as { n: number }).n,
    0,
  );
  close(h);
}

// ── 3. Append-only is enforced by the DATABASE, not by convention ──────────
{
  const h = newHarness();
  post(h);
  const id = (h.db.prepare("SELECT id FROM provider_payouts").get() as { id: number }).id;
  assert.throws(
    () => h.db.prepare("UPDATE provider_payouts SET note = 'x' WHERE id = ?").run(id),
    /append-only/,
  );
  assert.throws(
    () => h.db.prepare("DELETE FROM provider_payouts WHERE id = ?").run(id),
    /append-only/,
  );
  close(h);
}

// ── 4. Reversal math, and the SIGNED balance ───────────────────────────────
{
  const h = newHarness();
  accrue(h, { id: 1, net: "5000000" });
  accrue(h, { id: 2, net: "3000000" });

  post(h, { amount_atoms: "6000000", tx_ref: "0xpaid-a" });

  // A reversal larger than net paid is refused with the maximum named.
  expectVerdictError(
    () => post(h, { entry_type: "reversal", amount_atoms: "6000001", tx_ref: "0xtypo" }),
    "schema_invalid",
    422,
  );
  post(h, { entry_type: "reversal", amount_atoms: "1000000", tx_ref: "0xclawback-a" });
  // After a legitimate reversal, the bound tightens to what remains.
  expectVerdictError(
    () => post(h, { entry_type: "reversal", amount_atoms: "5000001", tx_ref: "0xtypo-2" }),
    "schema_invalid",
    422,
  );

  const totals = providerPayoutsRepo.totalsForAgent(h.db, h.agentId);
  assert.equal(totals.length, 1);
  assert.equal(totals[0]!.paid_atoms, "6000000");
  assert.equal(totals[0]!.reversed_atoms, "1000000");
  assert.equal(totals[0]!.net_paid_atoms, "5000000");

  const earnings = readProviderEarnings({
    db: h.db,
    accountId: h.accountId,
    slug: h.slug,
  }).body as { totals: Array<Record<string, string | number>> };
  const usdc = earnings.totals.find((t) => t.currency === "USDC")!;
  assert.equal(usdc.lifetime_accrued_net, "8000000");
  assert.equal(usdc.lifetime_paid_net, "5000000");
  assert.equal(usdc.balance_atoms, "3000000");
  assert.equal(usdc.owed_atoms, "3000000");
  assert.equal(usdc.overpaid_atoms, "0");
  close(h);
}

// ── 5. Overpayment is reported, never floored ──────────────────────────────
{
  const h = newHarness();
  accrue(h, { id: 1, net: "1000000" });
  post(h, { amount_atoms: "4000000", tx_ref: "0xfat-finger" });

  const earnings = readProviderEarnings({
    db: h.db,
    accountId: h.accountId,
    slug: h.slug,
  }).body as { totals: Array<Record<string, string>> };
  const usdc = earnings.totals.find((t) => t.currency === "USDC")!;
  assert.equal(usdc.balance_atoms, "-3000000");
  assert.equal(usdc.owed_atoms, "0");
  // An operator error stays visible; a Math.max(0, …) would report "settled".
  assert.equal(usdc.overpaid_atoms, "3000000");
  close(h);
}

// ── 6. Currency UNION — neither side may be dropped ────────────────────────
{
  const h = newHarness();
  // Accrued in USDC only.
  accrue(h, { id: 1, net: "2000000", currency: "USDC" });
  // Paid in EURC only — a currency with no accruals at all.
  post(h, { currency: "EURC", amount_atoms: "500000", tx_ref: "0xeur-1" });

  const earnings = readProviderEarnings({
    db: h.db,
    accountId: h.accountId,
    slug: h.slug,
  }).body as { totals: Array<Record<string, string | number>> };
  assert.equal(earnings.totals.length, 2, "both currencies must appear");
  const usdc = earnings.totals.find((t) => t.currency === "USDC")!;
  const eurc = earnings.totals.find((t) => t.currency === "EURC")!;
  assert.equal(usdc.lifetime_paid_net, "0");
  assert.equal(usdc.owed_atoms, "2000000");
  assert.equal(eurc.lifetime_accrued_net, "0");
  assert.equal(eurc.balance_atoms, "-500000");
  assert.equal(eurc.overpaid_atoms, "500000");
  close(h);
}

// ── 7. Currency case cannot split a bucket ─────────────────────────────────
{
  const h = newHarness();
  post(h, { currency: "usdc", amount_atoms: "1000000", tx_ref: "0xlower" });
  post(h, { currency: "USDC", amount_atoms: "1000000", tx_ref: "0xupper" });
  const totals = providerPayoutsRepo.totalsForAgent(h.db, h.agentId);
  assert.equal(totals.length, 1);
  assert.equal(totals[0]!.currency, "USDC");
  assert.equal(totals[0]!.net_paid_atoms, "2000000");
  // …and the idempotency key is case-folded too, so "usdc" replays "USDC".
  const replay = post(h, { currency: "usdc", amount_atoms: "1000000", tx_ref: "0xupper" });
  assert.equal(replay.status, 200);
  close(h);
}

// ── 8. Amounts beyond 2^53 survive intact ──────────────────────────────────
{
  const h = newHarness();
  const huge = "90071992547409910000";
  accrue(h, { id: 1, net: huge });
  post(h, { amount_atoms: "10000000000000000000", tx_ref: "0xbig" });
  const earnings = readProviderEarnings({
    db: h.db,
    accountId: h.accountId,
    slug: h.slug,
  }).body as { totals: Array<Record<string, string>> };
  const usdc = earnings.totals.find((t) => t.currency === "USDC")!;
  assert.equal(usdc.balance_atoms, (BigInt(huge) - 10000000000000000000n).toString());
  close(h);
}

// ── 9. The owner's read is scoped to the owner ─────────────────────────────
{
  const h = newHarness();
  post(h);
  const mine = readProviderPayouts({
    db: h.db,
    accountId: h.accountId,
    slug: h.slug,
  }).body as { payouts: unknown[]; totals: unknown[] };
  assert.equal(mine.payouts.length, 1);
  assert.equal(mine.totals.length, 1);

  expectVerdictError(
    () =>
      readProviderPayouts({
        db: h.db,
        accountId: randomUUID(),
        slug: h.slug,
      }),
    "agent_not_authorized",
    403,
  );
  close(h);
}

process.stdout.write("provider payout journal smoke OK\n");
