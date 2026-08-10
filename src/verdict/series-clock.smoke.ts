import { strict as assert } from "node:assert";

import {
  assertSeriesClockConfig,
  classifySubmission,
  deriveSeriesClock,
  isRegistrable,
  SeriesClockConfigError,
  type SeriesClockConfig,
} from "./series-clock.js";

process.stdout.write("murmur series clock smoke\n");

const SEC = 1_000;
const ok: SeriesClockConfig = {
  submissionOpenLeadSec: 300,
  commitMarginSec: 60,
  deliveryBudgetSec: 60,
  embargoSec: 600,
};

// ── A real Polymarket instance ─────────────────────────────────────────────
// btc-updown-5m: prediction window 02:40-02:45 UTC, so endDate = 02:45:00 and
// windowSec = 300. Every derived instant must be strictly ordered.
{
  const endDateMs = Date.parse("2026-07-26T02:45:00.000Z");
  const clock = deriveSeriesClock({ endDateMs, windowSec: 300, config: ok });

  assert.equal(new Date(clock.armCloseAtMs).toISOString(), "2026-07-26T02:34:00.000Z");
  assert.equal(new Date(clock.submissionOpenAtMs).toISOString(), "2026-07-26T02:35:00.000Z");
  assert.equal(new Date(clock.earlyAccessCutoffAtMs).toISOString(), "2026-07-26T02:39:00.000Z");
  assert.equal(new Date(clock.submissionCloseAtMs).toISOString(), "2026-07-26T02:40:00.000Z");
  assert.equal(new Date(clock.marketResolutionAtMs).toISOString(), "2026-07-26T02:45:00.000Z");
  assert.equal(new Date(clock.publicRevealAtMs).toISOString(), "2026-07-26T02:55:00.000Z");

  // Strict ordering, end to end.
  const order = [
    clock.armCloseAtMs,
    clock.submissionOpenAtMs,
    clock.earlyAccessCutoffAtMs,
    clock.submissionCloseAtMs,
    clock.marketResolutionAtMs,
    clock.publicRevealAtMs,
  ];
  for (let i = 1; i < order.length; i += 1) {
    assert.ok(order[i] > order[i - 1], `instant ${i} must be strictly after ${i - 1}`);
  }

  // marketResolutionAt is the venue's end, NOT the reveal deadline. Conflating
  // them would assert the market resolves when murmur unseals.
  assert.equal(clock.marketResolutionAtMs, endDateMs);
  assert.ok(clock.publicRevealAtMs > clock.marketResolutionAtMs);
}

// ── Config invariants ──────────────────────────────────────────────────────
// lead == delivery collapses the sellable window to zero length.
assert.throws(
  () => assertSeriesClockConfig({ ...ok, submissionOpenLeadSec: 60, deliveryBudgetSec: 60 }),
  (e) => e instanceof SeriesClockConfigError && /strictly greater/.test(e.message),
  "lead == delivery must be rejected",
);

// lead < delivery inverts it: the cutoff lands before submissions open.
assert.throws(
  () => assertSeriesClockConfig({ ...ok, submissionOpenLeadSec: 30, deliveryBudgetSec: 60 }),
  (e) => e instanceof SeriesClockConfigError,
  "lead < delivery must be rejected",
);

for (const key of [
  "submissionOpenLeadSec",
  "commitMarginSec",
  "deliveryBudgetSec",
  "embargoSec",
] as const) {
  assert.throws(
    () => assertSeriesClockConfig({ ...ok, [key]: 0 }),
    (e) => e instanceof SeriesClockConfigError,
    `${key}=0 must be rejected`,
  );
}

// Sub-second end times cannot round-trip through a whole-second chain clock.
assert.throws(
  () =>
    deriveSeriesClock({
      endDateMs: Date.parse("2026-07-26T02:45:00.500Z"),
      windowSec: 300,
      config: ok,
    }),
  (e) => e instanceof SeriesClockConfigError && /whole second/.test(e.message),
);

// ── Registrability ─────────────────────────────────────────────────────────
// A window long relative to the venue's listing lead pushes armCloseAt before
// the instance existed. Polymarket lists these ~24h ahead, so a 24h window on
// a 5-minute-style schedule is unregistrable rather than silently unusable.
{
  const endDateMs = Date.parse("2026-07-26T02:45:00.000Z");
  const listedAtMs = Date.parse("2026-07-25T02:49:00.000Z"); // ~23h51m ahead

  const fiveMin = deriveSeriesClock({ endDateMs, windowSec: 300, config: ok });
  assert.ok(isRegistrable(fiveMin, listedAtMs), "5-min instance is registrable when listed");

  const oneDay = deriveSeriesClock({ endDateMs, windowSec: 86_400, config: ok });
  assert.ok(
    !isRegistrable(oneDay, listedAtMs),
    "24h window closes arming before the instance was listed — must be refused",
  );
}

// ── Submission classification, half-open throughout ────────────────────────
{
  const endDateMs = Date.parse("2026-07-26T02:45:00.000Z");
  const c = deriveSeriesClock({ endDateMs, windowSec: 300, config: ok });

  assert.deepEqual(classifySubmission(c, c.submissionOpenAtMs - 1), {
    admitted: false,
    reason: "before_submission_open",
  });

  // Open instant is admitted and sellable.
  assert.deepEqual(classifySubmission(c, c.submissionOpenAtMs), {
    admitted: true,
    class: "early_access",
  });
  assert.deepEqual(classifySubmission(c, c.earlyAccessCutoffAtMs - 1), {
    admitted: true,
    class: "early_access",
  });

  // The cutoff instant itself is already too late to sell.
  assert.deepEqual(classifySubmission(c, c.earlyAccessCutoffAtMs), {
    admitted: true,
    class: "late_unsellable",
  });
  assert.deepEqual(classifySubmission(c, c.submissionCloseAtMs - 1), {
    admitted: true,
    class: "late_unsellable",
  });

  // Half-open at the top: at the exact window-open second the reference price
  // may already be observable, so this is not a prediction.
  assert.deepEqual(classifySubmission(c, c.submissionCloseAtMs), {
    admitted: false,
    reason: "after_submission_close",
  });
  assert.deepEqual(classifySubmission(c, endDateMs), {
    admitted: false,
    reason: "after_submission_close",
  });
}

// ── Commit ordering margin ─────────────────────────────────────────────────
// Arming must close strictly before submissions open, or a provider's submit
// can be mined ahead of the cohort commit that is meant to bind it.
{
  const c = deriveSeriesClock({
    endDateMs: Date.parse("2026-07-26T02:45:00.000Z"),
    windowSec: 300,
    config: ok,
  });
  assert.equal(
    c.submissionOpenAtMs - c.armCloseAtMs,
    ok.commitMarginSec * SEC,
    "the commit margin is exactly the arm-close → submission-open gap",
  );
  assert.ok(c.armCloseAtMs < c.submissionOpenAtMs);
}

// ── Second-precision on-chain derivation ───────────────────────────────────
// The chain stores whole seconds. Converting ms→s must preserve strict
// ordering, or a schedule that is valid off-chain reverts on-chain.
{
  const c = deriveSeriesClock({
    endDateMs: Date.parse("2026-07-26T02:45:00.000Z"),
    windowSec: 300,
    config: ok,
  });
  const secs = [
    c.armCloseAtMs,
    c.submissionOpenAtMs,
    c.earlyAccessCutoffAtMs,
    c.submissionCloseAtMs,
    c.marketResolutionAtMs,
    c.publicRevealAtMs,
  ].map((ms) => Math.floor(ms / 1000));
  for (let i = 1; i < secs.length; i += 1) {
    assert.ok(
      secs[i] > secs[i - 1],
      `second-precision instant ${i} must stay strictly after ${i - 1}`,
    );
  }
  // Whole-second inputs must not lose precision on the way down.
  assert.equal(secs[5] * 1000, c.publicRevealAtMs);
}

process.stdout.write("OK series clock smoke\n");
