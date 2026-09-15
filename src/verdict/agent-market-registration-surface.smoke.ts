import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAccountAgentResponse } from "./account-agent-surface.js";
import {
  listAgentMarketRegistrations,
  registerAgentForSeries,
  unregisterAgentFromSeries,
} from "./agent-market-registration-surface.js";
import { getOrCreateAccount } from "./auth/account-ownership.js";
import { openDb } from "./db.js";
import { setProviderTerms } from "./provider-terms-surface.js";
import { agentMarketRegistrationsRepo } from "./repos/agent-market-registrations-repo.js";
import { agentProviderTermsRepo } from "./repos/agent-provider-terms-repo.js";
import { venueMarketSeriesRepo } from "./repos/venue-market-series-repo.js";
import { VerdictError } from "./schema.js";

// Agent ↔ market-series registration: register, unregister, and list series state for an owned agent.
process.stdout.write("murmur agent market registration surface smoke\n");

const tmp = mkdtempSync(join(tmpdir(), "agent-market-registration-"));
try {
  const db = openDb({ path: join(tmp, "verdict.db") });
  const now = () => new Date("2026-08-05T00:00:00Z");

  const owner = getOrCreateAccount(
    db,
    {
      privy_user_id: "did:privy:reg-owner",
      session_id: "reg-owner-session",
      expires_at: "2026-08-05T01:00:00Z",
    },
    { resolvedAt: now() },
  );
  const stranger = getOrCreateAccount(
    db,
    {
      privy_user_id: "did:privy:reg-stranger",
      session_id: "reg-stranger-session",
      expires_at: "2026-08-05T01:00:00Z",
    },
    { resolvedAt: now() },
  );

  const created = createAccountAgentResponse({
    db,
    accountId: owner.account_id,
    newAgentId: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    body: { display_slug: "reg-agent", display_name: "Reg Agent" },
    operationInstant: now(),
  });
  assert.equal(created.status, 201);
  const slug = "reg-agent";
  const agentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

  const s1 = venueMarketSeriesRepo.upsert(db, {
    venue: "polymarket",
    series_slug: "eth-up-or-down-5m",
    series_title: "ETH Up or Down 5m",
    venue_category: "Crypto",
    source_adapter_id: "polymarket-gamma",
    now: "2026-08-05T00:00:00Z",
  });
  const s2 = venueMarketSeriesRepo.upsert(db, {
    venue: "polymarket",
    series_slug: "btc-up-or-down-5m",
    series_title: "BTC Up or Down 5m",
    venue_category: "Crypto",
    source_adapter_id: "polymarket-gamma",
    now: "2026-08-05T00:00:00Z",
  });

  // ── (b) register is idempotent ────────────────────────────────────────────
  const reg1 = registerAgentForSeries({
    db,
    accountId: owner.account_id,
    slug,
    body: { venue_series_id: s1.venue_series_id },
    now,
  });
  assert.equal(reg1.status, 200);
  assert.equal((reg1.body as { registered?: boolean }).registered, true);
  const reg2 = registerAgentForSeries({
    db,
    accountId: owner.account_id,
    slug,
    body: { venue_series_id: s1.venue_series_id },
    now,
  });
  assert.equal(reg2.status, 200, "a repeat register is a no-op, not an error");
  assert.equal(
    agentMarketRegistrationsRepo.listForAgent(db, agentId).length,
    1,
    "idempotent: the repeat did not add a second row",
  );

  // ── (b) ownership is enforced — a stranger cannot register your agent ──────
  assert.throws(
    () =>
      registerAgentForSeries({
        db,
        accountId: stranger.account_id,
        slug,
        body: { venue_series_id: s2.venue_series_id },
        now,
      }),
    (err) => err instanceof VerdictError && err.httpStatus === 403,
    "cross-account register is 403",
  );
  assert.equal(
    agentMarketRegistrationsRepo.isRegistered(db, {
      agentId,
      venueSeriesId: s2.venue_series_id,
    }),
    false,
    "the refused cross-account register wrote nothing",
  );

  // ── (b) unknown series is 404, not a raw FK 500 ───────────────────────────
  const unknown = registerAgentForSeries({
    db,
    accountId: owner.account_id,
    slug,
    body: { venue_series_id: "polymarket:does-not-exist" },
    now,
  });
  assert.equal(unknown.status, 404);
  assert.equal((unknown.body as { code?: string }).code, "series_unknown");

  // ── list: every series with this agent's state ────────────────────────────
  const listed = listAgentMarketRegistrations({
    db,
    accountId: owner.account_id,
    slug,
  });
  assert.equal(listed.status, 200);
  const rows = (listed.body as { series: Array<Record<string, unknown>> }).series;
  assert.equal(rows.length, 2, "both series are surfaced");
  const s1Row = rows.find((r) => r.venue_series_id === s1.venue_series_id)!;
  assert.equal(s1Row.registered, true);
  assert.equal(s1Row.series_title, "ETH Up or Down 5m");
  assert.equal(s1Row.venue_category, "Crypto");
  assert.equal(s1Row.terms, null, "registered but not yet priced");
  const s2Row = rows.find((r) => r.venue_series_id === s2.venue_series_id)!;
  assert.equal(s2Row.registered, false);

  // ── (c) unregister drops that series' terms ONLY ──────────────────────────
  // Register the agent for s2 too, then price both series.
  registerAgentForSeries({
    db,
    accountId: owner.account_id,
    slug,
    body: { venue_series_id: s2.venue_series_id },
    now,
  });
  for (const seriesId of [s1.venue_series_id, s2.venue_series_id]) {
    agentProviderTermsRepo.upsert(db, {
      agent_id: agentId,
      venue_series_id: seriesId,
      price_atoms: "10000",
      currency: "USDC",
      pricing_version: "v1",
      max_subscribers_per_call: null,
      now: "2026-08-05T00:00:00Z",
    });
  }
  assert.ok(agentProviderTermsRepo.get(db, { agentId, venueSeriesId: s1.venue_series_id }));
  assert.ok(agentProviderTermsRepo.get(db, { agentId, venueSeriesId: s2.venue_series_id }));

  const dropped = unregisterAgentFromSeries({
    db,
    accountId: owner.account_id,
    slug,
    venueSeriesId: s1.venue_series_id,
  });
  assert.equal(dropped.status, 200);
  assert.equal(
    agentMarketRegistrationsRepo.isRegistered(db, {
      agentId,
      venueSeriesId: s1.venue_series_id,
    }),
    false,
    "s1 registration is gone",
  );
  assert.equal(
    agentProviderTermsRepo.get(db, { agentId, venueSeriesId: s1.venue_series_id }),
    null,
    "s1 terms cascaded away with the registration",
  );
  assert.ok(
    agentProviderTermsRepo.get(db, { agentId, venueSeriesId: s2.venue_series_id }),
    "s2 terms are untouched — the cascade is scoped to one series",
  );
  assert.equal(
    agentMarketRegistrationsRepo.isRegistered(db, {
      agentId,
      venueSeriesId: s2.venue_series_id,
    }),
    true,
    "s2 registration is untouched",
  );

  // ── (d) setting terms without a registration is a clean 409, not a 500 ─────
  const s3 = venueMarketSeriesRepo.upsert(db, {
    venue: "polymarket",
    series_slug: "sol-up-or-down-5m",
    series_title: "SOL Up or Down 5m",
    venue_category: "Crypto",
    source_adapter_id: "polymarket-gamma",
    now: "2026-08-05T00:00:00Z",
  });
  const priced = setProviderTerms({
    db,
    accountId: owner.account_id,
    slug,
    venueSeriesId: s3.venue_series_id,
    deliverableCap: 25,
    // Explicit so the 503 protocol-fee guard passes and the request reaches the
    // registration check we are testing.
    protocolFeeBps: 100,
    now,
    body: {
      price_atoms: "10000",
      currency: "USDC",
      pricing_version: "v1",
    },
  });
  assert.equal(priced.status, 409, "pricing an unregistered series is 409, not 500");
  assert.equal(
    (priced.body as { code?: string }).code,
    "not_registered_for_series",
  );

  db.close();
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

process.stdout.write("OK agent market registration surface smoke\n");
