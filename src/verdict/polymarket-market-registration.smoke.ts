import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { GammaMarketSnapshot } from "../markets/polymarket-gamma/transform.js";
import { parseAgentSecurityEventPayload } from "./agent-security-event.js";
import { openDb } from "./db.js";
import {
  registerPolymarketMarketFromAdminBody,
  sendPolymarketMarketRegistrationJsonResponse,
} from "./polymarket-market-registration.js";
import { agentSecurityEventsRepo } from "./repos/agent-security-events-repo.js";
import { marketClocksRepo, marketSeriesRepo } from "./repos/market-clocks-repo.js";
import { marketsRepo } from "./repos/market-registry-repo.js";

const tmp = mkdtempSync(join(tmpdir(), "murmur-polymarket-market-registration-"));
const dbPath = join(tmp, "test.db");

try {
  process.stdout.write("murmur Polymarket Market Registration smoke\n");
  const db = openDb({ path: dbPath });
  const now = () => new Date("2026-06-12T09:30:00Z");
  const unexpectedAgentSecurityEventId = () => {
    throw new Error("agent security event id adapter should not be called");
  };
  const unexpectedGammaLookup = {
    fetchMarketByConditionId: async () => {
      throw new Error("gamma lookup adapter should not be called before validation passes");
    },
  };

  const invalid = await registerPolymarketMarketFromAdminBody({
    db,
    gammaLookup: unexpectedGammaLookup,
    newAgentSecurityEventId: unexpectedAgentSecurityEventId,
    now,
    body: { conditionId: "not-a-condition-id" },
  });
  assert.equal(invalid.status, 400);
  assert.equal((invalid.body as { code?: string }).code, "schema_invalid");

  const invalidTarget = makeStatusJsonTarget();
  sendPolymarketMarketRegistrationJsonResponse(invalidTarget, invalid);
  assert.equal(invalidTarget.statusCode, 400);
  assert.equal(invalidTarget.body, invalid.body);

  const createdTarget = makeStatusJsonTarget();
  const created = {
    status: 201,
    body: { schema_version: 1, market: { market_id: `0x${"1".repeat(64)}` } },
  };
  sendPolymarketMarketRegistrationJsonResponse(createdTarget, created);
  assert.equal(createdTarget.statusCode, 201);
  assert.equal(createdTarget.body, created.body);

  const futureConditionId = `0x${"12".repeat(32)}`;
  const gammaCalls: string[] = [];
  const securityEventIds: string[] = [];
  const registered = await registerPolymarketMarketFromAdminBody({
    db,
    gammaLookup: {
      fetchMarketByConditionId: async (conditionId) => {
        gammaCalls.push(conditionId);
        return {
          snapshot: gammaSnapshot({
            conditionId,
            endDate: "2026-06-12T10:30:00Z",
            slug: "future-registration",
          }),
          error: null,
        };
      },
    },
    newAgentSecurityEventId: () => {
      const id = "00000000-0000-4000-8000-000000000201";
      securityEventIds.push(id);
      return id;
    },
    now,
    body: {
      conditionId: futureConditionId,
      resolution_class: "event_binary",
      // Without a series schedule only a draft is allowed.
      status: "draft",
    },
  });
  assert.equal(registered.status, 201);
  assert.deepEqual(gammaCalls, [futureConditionId]);
  assert.deepEqual(securityEventIds, ["00000000-0000-4000-8000-000000000201"]);
  const registeredBody = registered.body as {
    market?: { market_id?: string; horizon_seconds?: number; status?: string };
  };
  assert.equal(registeredBody.market?.market_id, futureConditionId);
  assert.equal(registeredBody.market?.horizon_seconds, 3_600);
  assert.equal(registeredBody.market?.status, "draft");

  // Without a series schedule, anything beyond draft is refused.
  const unscheduledListed = await registerPolymarketMarketFromAdminBody({
    db,
    gammaLookup: {
      fetchMarketByConditionId: async (conditionId) => ({
        snapshot: gammaSnapshot({
          conditionId,
          endDate: "2026-06-12T10:30:00Z",
          slug: "future-registration",
        }),
        error: null,
      }),
    },
    now,
    body: {
      conditionId: futureConditionId,
      resolution_class: "event_binary",
      status: "listed",
    },
  });
  assert.equal(unscheduledListed.status, 400, "unscheduled listed registration is refused");
  assert.equal(
    (unscheduledListed.body as { code?: string }).code,
    "schedule_required",
  );

  // Ordering: an unusable end date on a listed, unscheduled request is 422, not 400 schedule_required.
  // `status` is explicit so both guards stay live.
  const unusableEnd = await registerPolymarketMarketFromAdminBody({
    db,
    gammaLookup: {
      fetchMarketByConditionId: async (conditionId) => ({
        snapshot: gammaSnapshot({
          conditionId,
          endDate: "not-a-date",
          slug: "unusable-end",
        }),
        error: null,
      }),
    },
    now,
    body: {
      conditionId: futureConditionId,
      resolution_class: "event_binary",
      status: "listed",
    },
  });
  assert.equal(unusableEnd.status, 422, "unusable end date reports 422, not 400");
  assert.equal(
    (unusableEnd.body as { code?: string }).code,
    "market_end_date_unusable",
    "the specific end-date error must not be masked by schedule_required",
  );
  const audit = agentSecurityEventsRepo.listByKind(db, "admin_polymarket_upsert", 1)[0];
  assert.equal(audit?.event_id, "00000000-0000-4000-8000-000000000201");
  assert.equal(audit?.created_at, "2026-06-12T09:30:00Z");
  assert.deepEqual(parseAgentSecurityEventPayload(audit?.payload_json ?? "{}"), {
    conditionId: futureConditionId,
    status: "draft",
    requested_horizon_seconds: 3_600,
    persisted_horizon_seconds: 3_600,
    slug: "future-registration",
  });

  const past = await registerPolymarketMarketFromAdminBody({
    db,
    gammaLookup: {
      fetchMarketByConditionId: async (conditionId) => ({
        snapshot: gammaSnapshot({
          conditionId,
          endDate: "2026-06-12T08:30:00Z",
          slug: "past-registration",
        }),
        error: null,
      }),
    },
    newAgentSecurityEventId: unexpectedAgentSecurityEventId,
    now,
    body: { conditionId: `0x${"34".repeat(32)}`, status: "listed" },
  });
  assert.equal(past.status, 422);
  assert.equal((past.body as { code?: string }).code, "market_already_resolved");

  // The default status is `draft`, the only one valid without a schedule.
  const defaulted = await registerPolymarketMarketFromAdminBody({
    db,
    gammaLookup: {
      fetchMarketByConditionId: async (conditionId) => ({
        snapshot: gammaSnapshot({
          conditionId,
          endDate: "2026-06-12T10:30:00Z",
          slug: "default-status",
        }),
        error: null,
      }),
    },
    newAgentSecurityEventId: () => "00000000-0000-4000-8000-000000000202",
    now,
    body: { conditionId: `0x${"56".repeat(32)}` },
  });
  assert.equal(defaulted.status, 201, "a bare {conditionId} request must succeed");
  assert.equal(
    (defaulted.body as { market?: { status?: string } }).market?.status,
    "draft",
  );

  // A schedule supplied over HTTP is accepted and persisted atomically.
  const scheduledId = `0x${"78".repeat(32)}`;
  const scheduledEnd = "2026-06-12T10:30:00Z";
  const scheduled = await registerPolymarketMarketFromAdminBody({
    db,
    gammaLookup: {
      fetchMarketByConditionId: async (conditionId) => ({
        snapshot: gammaSnapshot({
          conditionId,
          endDate: scheduledEnd,
          slug: "scheduled-registration",
        }),
        error: null,
      }),
    },
    newAgentSecurityEventId: () => "00000000-0000-4000-8000-000000000203",
    now,
    body: {
      conditionId: scheduledId,
      status: "listed",
      schedule: {
        seriesId: "polymarket:binary-300s:v1",
        displayName: "Polymarket 5m binary",
        windowSeconds: 300,
        clockConfig: {
          submissionOpenLeadSec: 120,
          commitMarginSec: 30,
          deliveryBudgetSec: 60,
          embargoSec: 900,
        },
        maxArmedPerCall: 25,
      },
    },
  });
  assert.equal(scheduled.status, 201, "a scheduled listed registration must succeed");
  assert.equal(
    (scheduled.body as { market?: { status?: string } }).market?.status,
    "listed",
  );
  assert.ok(
    marketSeriesRepo.get(db, "polymarket:binary-300s:v1"),
    "the series row is written in the same transaction",
  );
  const clock = marketClocksRepo.get(db, scheduledId);
  assert.ok(clock, "the immutable clock snapshot is written in the same transaction");
  assert.equal(
    clock?.derived_from_end_date_ms,
    Date.parse(scheduledEnd),
    "the clock derives from the Gamma end date",
  );
  assert.equal(
    clock?.public_reveal_at_ms,
    Date.parse(scheduledEnd) + 900_000,
    "public reveal is embargoed past resolution by embargoSec",
  );

  // Re-registration can't retime, demote or strip the embargo stamp of a bound market.
  const bareRetry = await registerPolymarketMarketFromAdminBody({
    db,
    gammaLookup: {
      fetchMarketByConditionId: async (conditionId) => ({
        snapshot: gammaSnapshot({
          conditionId,
          endDate: scheduledEnd,
          slug: "scheduled-registration",
        }),
        error: null,
      }),
    },
    newAgentSecurityEventId: unexpectedAgentSecurityEventId,
    now,
    body: { conditionId: scheduledId },
  });
  assert.equal(bareRetry.status, 409, "a bare retry on a bound market is refused");
  assert.equal(
    (bareRetry.body as { code?: string }).code,
    "schedule_immutable",
  );
  const afterRetry = marketsRepo.get(db, scheduledId);
  assert.equal(afterRetry?.status, "listed", "the live market was not demoted");
  assert.equal(
    (JSON.parse(afterRetry?.config_json ?? "{}") as { embargoSec?: number }).embargoSec,
    900,
    "the embargo stamp survives — without it every submission is rejected",
  );

  // A restated schedule that derives a DIFFERENT clock is refused too.
  const retimed = await registerPolymarketMarketFromAdminBody({
    db,
    gammaLookup: {
      fetchMarketByConditionId: async (conditionId) => ({
        snapshot: gammaSnapshot({
          conditionId,
          endDate: scheduledEnd,
          slug: "scheduled-registration",
        }),
        error: null,
      }),
    },
    newAgentSecurityEventId: unexpectedAgentSecurityEventId,
    now,
    body: {
      conditionId: scheduledId,
      status: "listed",
      schedule: {
        seriesId: "polymarket:binary-300s:v2",
        displayName: "Polymarket 5m binary",
        windowSeconds: 300,
        clockConfig: {
          submissionOpenLeadSec: 120,
          commitMarginSec: 30,
          deliveryBudgetSec: 60,
          // Moves public reveal 15 minutes later than the frozen clock.
          embargoSec: 1_800,
        },
        maxArmedPerCall: 25,
      },
    },
  });
  assert.equal(retimed.status, 409, "retiming a bound market is refused");
  assert.equal((retimed.body as { code?: string }).code, "schedule_immutable");
  assert.equal(
    marketClocksRepo.get(db, scheduledId)?.public_reveal_at_ms,
    Date.parse(scheduledEnd) + 900_000,
    "the frozen clock is untouched",
  );

  // Restating the SAME schedule is idempotent, not an error.
  const restated = await registerPolymarketMarketFromAdminBody({
    db,
    gammaLookup: {
      fetchMarketByConditionId: async (conditionId) => ({
        snapshot: gammaSnapshot({
          conditionId,
          endDate: scheduledEnd,
          slug: "scheduled-registration",
        }),
        error: null,
      }),
    },
    newAgentSecurityEventId: () => "00000000-0000-4000-8000-000000000204",
    now,
    body: {
      conditionId: scheduledId,
      schedule: {
        seriesId: "polymarket:binary-300s:v1",
        displayName: "Polymarket 5m binary",
        windowSeconds: 300,
        clockConfig: {
          submissionOpenLeadSec: 120,
          commitMarginSec: 30,
          deliveryBudgetSec: 60,
          embargoSec: 900,
        },
        maxArmedPerCall: 25,
      },
    },
  });
  assert.equal(restated.status, 201, "restating the same schedule is idempotent");
  assert.equal(
    marketsRepo.get(db, scheduledId)?.status,
    "listed",
    "an omitted status leaves an existing market's status alone",
  );

  // A bound market's cohort cap is part of the terms consumers armed against.
  const recapped = await registerPolymarketMarketFromAdminBody({
    db,
    gammaLookup: {
      fetchMarketByConditionId: async (conditionId) => ({
        snapshot: gammaSnapshot({
          conditionId,
          endDate: scheduledEnd,
          slug: "scheduled-registration",
        }),
        error: null,
      }),
    },
    newAgentSecurityEventId: unexpectedAgentSecurityEventId,
    now,
    body: {
      conditionId: scheduledId,
      schedule: {
        seriesId: "polymarket:binary-300s:v1",
        displayName: "Polymarket 5m binary",
        windowSeconds: 300,
        clockConfig: {
          submissionOpenLeadSec: 120,
          commitMarginSec: 30,
          deliveryBudgetSec: 60,
          embargoSec: 900,
        },
        // Same clock, ten times the cohort.
        maxArmedPerCall: 250,
      },
    },
  });
  assert.equal(recapped.status, 409, "resizing a bound series' cohort is refused");
  assert.equal((recapped.body as { code?: string }).code, "schedule_immutable");
  assert.equal(
    marketSeriesRepo.get(db, "polymarket:binary-300s:v1")?.max_armed_per_call,
    25,
    "the cap consumers armed against is unchanged",
  );

  // Status-only changes are allowed on a bound market, with no Gamma call or schedule.
  const frozen = await registerPolymarketMarketFromAdminBody({
    db,
    gammaLookup: {
      fetchMarketByConditionId: async () => {
        throw new Error("a status-only change must not call Gamma");
      },
    },
    newAgentSecurityEventId: () => "00000000-0000-4000-8000-000000000205",
    now,
    body: { conditionId: scheduledId, status: "frozen" },
  });
  assert.equal(frozen.status, 200, "a bound market can be frozen without a schedule");
  const frozenRow = marketsRepo.get(db, scheduledId);
  assert.equal(frozenRow?.status, "frozen");
  assert.equal(
    (JSON.parse(frozenRow?.config_json ?? "{}") as { embargoSec?: number }).embargoSec,
    900,
    "a status-only change does not rewrite config",
  );
  assert.equal(
    marketClocksRepo.get(db, scheduledId)?.public_reveal_at_ms,
    Date.parse(scheduledEnd) + 900_000,
    "a status-only change does not touch the clock",
  );

  // Listing still needs the schedule, because listing is what validates it.
  const relist = await registerPolymarketMarketFromAdminBody({
    db,
    gammaLookup: {
      fetchMarketByConditionId: async () => {
        throw new Error("a status-only change must not call Gamma");
      },
    },
    newAgentSecurityEventId: unexpectedAgentSecurityEventId,
    now,
    body: { conditionId: scheduledId, status: "listed" },
  });
  assert.equal(relist.status, 409, "listing without a schedule is refused");
  assert.equal((relist.body as { code?: string }).code, "schedule_required");

  db.close();
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

process.stdout.write("Polymarket Market Registration smoke ok\n");

function makeStatusJsonTarget() {
  return {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return {
        json: (body: unknown) => {
          this.body = body;
        },
      };
    },
  };
}

function gammaSnapshot(input: {
  conditionId: string;
  endDate: string;
  slug: string;
}): GammaMarketSnapshot {
  return {
    conditionId: input.conditionId,
    slug: input.slug,
    outcomes: JSON.stringify(["Yes", "No"]),
    outcomePrices: JSON.stringify(["0.45", "0.55"]),
    umaResolutionStatus: "active",
    umaResolutionStatuses: JSON.stringify(["active"]),
    closed: false,
    active: true,
    archived: false,
    endDate: input.endDate,
  };
}
