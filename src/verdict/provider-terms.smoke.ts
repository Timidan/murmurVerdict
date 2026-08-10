import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb } from "./db.js";
import { termsFor } from "./entitlement-access-surface.js";
import {
  agentProviderTermsRepo,
  effectiveCohortCap,
} from "./repos/agent-provider-terms-repo.js";

// An agent owner prices their own signal. Two properties carry the design:
//
//   1. Repricing NEVER reaches a call already sold. Terms are snapshotted onto
//      the sealed call, so the live terms row can move freely.
//   2. The owner's ceiling and murmur's deliverability are separate limits,
//      and the smaller one wins — selling past what can be granted inside the
//      delivery budget is a refund obligation, and refunds are manual.
process.stdout.write("murmur provider terms smoke\n");

const tmp = mkdtempSync(join(tmpdir(), "provider-terms-"));
try {
  const db = openDb({ path: join(tmp, `${randomUUID()}.db`) });
  const agentId = randomUUID();
  db.prepare(
    `INSERT INTO agents (agent_id, display_slug, kind, display_name, bio,
       created_at, api_key_hash, wallet_address, chain_id)
     VALUES (?, 'terms-agent', 'agent', 'Terms Agent', NULL,
       '2026-08-05T00:00:00Z', NULL, NULL, NULL)`,
  ).run(agentId);

  // ── the owner sets terms ──────────────────────────────────────────────────
  agentProviderTermsRepo.upsert(db, {
    agent_id: agentId,
    price_atoms: "10000",
    currency: "USDC",
    pricing_version: "v1",
    max_subscribers_per_call: 40,
    now: "2026-08-05T00:00:00Z",
  });
  let terms = agentProviderTermsRepo.get(db, agentId);
  assert.equal(terms?.price_atoms, "10000");
  assert.equal(terms?.max_subscribers_per_call, 40);

  // ── repricing is allowed, and is why the call snapshot exists ─────────────
  agentProviderTermsRepo.upsert(db, {
    agent_id: agentId,
    price_atoms: "50000",
    currency: "USDC",
    pricing_version: "v2",
    max_subscribers_per_call: null, // "as many as murmur can serve"
    now: "2026-08-05T01:00:00Z",
  });
  terms = agentProviderTermsRepo.get(db, agentId);
  assert.equal(terms?.price_atoms, "50000", "an owner may reprice at will");
  assert.equal(terms?.pricing_version, "v2");
  assert.equal(terms?.max_subscribers_per_call, null);

  // ── prices must be real ───────────────────────────────────────────────────
  for (const bad of ["0", "00", "-1", "1.5", ""]) {
    assert.throws(
      () =>
        agentProviderTermsRepo.upsert(db, {
          agent_id: agentId,
          price_atoms: bad,
          currency: "USDC",
          pricing_version: "v3",
          max_subscribers_per_call: null,
          now: "2026-08-05T02:00:00Z",
        }),
      `price_atoms "${bad}" must be refused`,
    );
  }
  assert.throws(
    () =>
      agentProviderTermsRepo.upsert(db, {
        agent_id: agentId,
        price_atoms: "10000",
        currency: "USDC",
        pricing_version: "v3",
        max_subscribers_per_call: 0,
        now: "2026-08-05T02:00:00Z",
      }),
    "a zero subscriber ceiling is not a ceiling, it is a closed shop",
  );

  // ── owner ceiling vs deliverability: the smaller wins ─────────────────────
  assert.deepEqual(
    effectiveCohortCap(null, 25),
    { cap: 25, clampedByDeliverability: false },
    "no owner ceiling → serve as many as murmur can deliver",
  );
  assert.deepEqual(
    effectiveCohortCap(10, 25),
    { cap: 10, clampedByDeliverability: false },
    "owner asks for fewer than we can deliver → their number stands",
  );
  assert.deepEqual(
    effectiveCohortCap(200, 25),
    { cap: 25, clampedByDeliverability: true },
    "owner asks for more than we can deliver → clamped, and SAID so",
  );
  assert.deepEqual(
    effectiveCohortCap(200, undefined),
    { cap: 200, clampedByDeliverability: false },
    "no deliverability limit configured → the owner's number stands",
  );

  // ── THE POINT: a sold call keeps the terms it was sold under ─────────────
  // Snapshot columns on the call, written at acceptance. If the access path
  // read the live terms row instead, this reprice would silently change what
  // an in-flight buyer is charged — and disagree with the 402 they answered.
  const callId = randomUUID();
  // fhenix_sealed_calls.call_id references submissions(call_id).
  db.prepare(
    `INSERT INTO submissions
       (call_id, agent_id, client_order_id, submitted_at, accepted_at,
        schema_version, scoring_version, dedup_key, status, horizon_seconds)
     VALUES (?, ?, 'order-1', '2026-08-05T00:30:00Z', '2026-08-05T00:30:00Z',
        1, 1, ?, 'pending_t1', 3600)`,
  ).run(callId, agentId, `dedup-${callId}`);
  db.prepare(
    `INSERT INTO fhenix_sealed_calls
       (call_id, chain_id, contract_address, onchain_call_id, submit_tx_hash,
        submit_log_index, binary_index_ct_hash, confidence_ct_hash,
        reveal_open_at, submission_class, created_at,
        provider_price_atoms, provider_currency, provider_pricing_version,
        provider_max_subscribers)
     VALUES (?, 84532, '0xcontract', '0xcall', '0xtx', 0, '0xbin', '0xconf',
        '2026-08-05T03:00:00Z', 1, '2026-08-05T00:30:00Z',
        '10000', 'USDC', 'v1', 40)`,
  ).run(callId);

  // A call from before per-provider terms: no snapshot at all.
  const legacyId = randomUUID();
  db.prepare(
    `INSERT INTO submissions
       (call_id, agent_id, client_order_id, submitted_at, accepted_at,
        schema_version, scoring_version, dedup_key, status, horizon_seconds)
     VALUES (?, ?, 'order-legacy', '2026-08-04T00:00:00Z', '2026-08-04T00:00:00Z',
        1, 1, ?, 'pending_t1', 3600)`,
  ).run(legacyId, agentId, `dedup-${legacyId}`);
  db.prepare(
    `INSERT INTO fhenix_sealed_calls
       (call_id, chain_id, contract_address, onchain_call_id, submit_tx_hash,
        submit_log_index, binary_index_ct_hash, confidence_ct_hash,
        reveal_open_at, submission_class, created_at)
     VALUES (?, 84532, '0xcontract', '0xlegacy', '0xtx2', 1, '0xbin', '0xconf',
        '2026-08-04T03:00:00Z', 1, '2026-08-04T00:30:00Z')`,
  ).run(legacyId);

  // A call sealed by TODAY's build for an owner with no terms set. Identical
  // NULL columns to the legacy row above; only the flag tells them apart.
  const notSellingId = randomUUID();
  db.prepare(
    `INSERT INTO submissions
       (call_id, agent_id, client_order_id, submitted_at, accepted_at,
        schema_version, scoring_version, dedup_key, status, horizon_seconds)
     VALUES (?, ?, 'order-notselling', '2026-08-05T00:00:00Z', '2026-08-05T00:00:00Z',
        1, 1, ?, 'pending_t1', 3600)`,
  ).run(notSellingId, agentId, `dedup-${notSellingId}`);
  db.prepare(
    `INSERT INTO fhenix_sealed_calls
       (call_id, chain_id, contract_address, onchain_call_id, submit_tx_hash,
        submit_log_index, binary_index_ct_hash, confidence_ct_hash,
        reveal_open_at, submission_class, created_at, provider_terms_snapshotted)
     VALUES (?, 84532, '0xcontract', '0xnotselling', '0xtx3', 2, '0xbin', '0xconf',
        '2026-08-05T03:00:00Z', 1, '2026-08-05T00:30:00Z', 1)`,
  ).run(notSellingId);

  // Owner reprices AFTER the call was sealed.
  agentProviderTermsRepo.upsert(db, {
    agent_id: agentId,
    price_atoms: "999999",
    currency: "USDC",
    pricing_version: "v9",
    max_subscribers_per_call: 1,
    now: "2026-08-05T04:00:00Z",
  });

  const sold = db
    .prepare(
      `SELECT provider_price_atoms, provider_pricing_version, provider_max_subscribers
         FROM fhenix_sealed_calls WHERE call_id = ?`,
    )
    .get(callId) as {
    provider_price_atoms: string;
    provider_pricing_version: string;
    provider_max_subscribers: number;
  };
  assert.equal(sold.provider_price_atoms, "10000", "the sold price is frozen");
  assert.equal(sold.provider_pricing_version, "v1", "so is the version it was sold under");
  assert.equal(
    sold.provider_max_subscribers,
    40,
    "and the cohort a subscriber joined cannot be shrunk under them",
  );
  assert.equal(
    agentProviderTermsRepo.get(db, agentId)?.price_atoms,
    "999999",
    "...while the owner's CURRENT terms did change, for future calls",
  );

  // ── THE QUOTE USES THE OWNER'S PRICE, not the deployment's ──────────────
  // The whole point of the feature: a buyer is quoted what the provider set
  // for THAT call. Driven through the real termsFor() the 402 handler uses, so
  // a regression shows up here and not only in a live run.
  const quoteDeps = {
    access: {
      db,
      grantChain: { chainId: 84532, contractAddress: "0xcontract" },
    },
    // Deliberately UNLIKE the owner's 10000 — if these matched, the assertion
    // below could pass while reading the wrong source.
    priceAtoms: "99999",
    currency: "USDC",
    pricingVersion: "deployment-v1",
  } as unknown as Parameters<typeof termsFor>[0];

  const quoted = termsFor(quoteDeps, "0xcall");
  assert.ok(quoted, "a priced call is for sale");
  assert.equal(quoted.priceAtoms, "10000", "the OWNER's price, not the deployment's 99999");
  assert.equal(quoted.pricingVersion, "v1", "and the version it was sold under");
  assert.equal(quoted.currency, "USDC");

  // A call with NO snapshot (sealed before providers could price themselves)
  // still quotes the deployment terms — otherwise old calls become unsellable.
  const legacy = termsFor(quoteDeps, "0xlegacy");
  assert.ok(legacy, "a legacy call stays sellable");
  assert.equal(legacy.priceAtoms, "99999", "legacy call quotes the deployment price");
  assert.equal(legacy.pricingVersion, "deployment-v1", "falls back for legacy calls");

  // ── AND THE OPPOSITE CASE: an owner who is not selling ────────────────────
  // Same NULL columns as the legacy row, but written by a build that DOES
  // snapshot terms — so the NULL is a decision, not missing information.
  // Reading it as legacy sold the owner's signal at the operator's price the
  // moment they pressed "stop selling".
  assert.equal(
    termsFor(quoteDeps, "0xnotselling"),
    null,
    "an owner who set no terms is not selling — never the deployment price",
  );

  // ── clearing stops FUTURE sales; it is not a refund ───────────────────────
  agentProviderTermsRepo.clear(db, agentId);
  assert.equal(
    agentProviderTermsRepo.get(db, agentId),
    null,
    "cleared terms mean no new calls are offered",
  );

  db.close();
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

process.stdout.write("OK provider terms smoke\n");
