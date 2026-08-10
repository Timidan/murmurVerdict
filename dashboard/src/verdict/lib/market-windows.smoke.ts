import { strict as assert } from "node:assert";

import {
  groupMarketsByWindow,
  localDayEpochBounds,
  marketWindowCountdownLabel,
  marketWindowCountdownTargetMs,
  marketWindowPhase,
  startOfLocalDayEpochS,
  windowGroupKey,
  type MarketWindowClock,
} from "./market-windows.js";
import {
  formatCountdown,
  describeCountdown,
} from "./date-time-format.js";

process.stdout.write("murmur markets matrix window logic smoke\n");

// A window on the real shape: submissions open 10 minutes before the venue's
// window starts, close as it starts, and the venue resolves 5 minutes later.
const OPEN = 1_786_340_100_000;
const CLOSE = OPEN + 300_000;
const RESOLVE = CLOSE + 300_000;

const clock: MarketWindowClock = {
  submission_open_at_ms: OPEN,
  submission_close_at_ms: CLOSE,
  resolution_at_ms: RESOLVE,
};

// ─── Phase boundaries ───────────────────────────────────────────────────────
//
// Every boundary is checked on BOTH sides plus exactly on the instant, because
// an off-by-one here shows a window as open for one second after submissions
// have actually closed — which is the difference between an accurate board and
// one that invites a call that will be rejected.

assert.equal(marketWindowPhase(clock, OPEN - 1, false), "upcoming");
assert.equal(marketWindowPhase(clock, OPEN, false), "open", "open is inclusive");
assert.equal(marketWindowPhase(clock, CLOSE - 1, false), "open");
assert.equal(marketWindowPhase(clock, CLOSE, false), "sealed", "close is inclusive");
assert.equal(marketWindowPhase(clock, RESOLVE - 1, false), "sealed");
assert.equal(marketWindowPhase(clock, RESOLVE, false), "resolved");
assert.equal(marketWindowPhase(clock, RESOLVE + 60_000, false), "resolved");

// A venue resolution pulls the phase EARLY — the venue is the authority on its
// own outcome.
assert.equal(marketWindowPhase(clock, OPEN - 1, true), "resolved");
assert.equal(marketWindowPhase(clock, CLOSE + 1, true), "resolved");

// …but its ABSENCE never holds a finished window open. A slow venue leaves the
// group resolved with no winner shown, which is honest; claiming it is still
// running is not.
assert.equal(marketWindowPhase(clock, RESOLVE + 3_600_000, false), "resolved");

// ─── One countdown per phase, pointed at the right instant ──────────────────

assert.equal(marketWindowCountdownTargetMs(clock, "upcoming"), OPEN);
assert.equal(marketWindowCountdownTargetMs(clock, "open"), CLOSE);
assert.equal(marketWindowCountdownTargetMs(clock, "sealed"), RESOLVE);
assert.equal(
  marketWindowCountdownTargetMs(clock, "resolved"),
  null,
  "a settled window counts down to nothing",
);
assert.equal(marketWindowCountdownLabel("resolved"), null);
for (const phase of ["upcoming", "open", "sealed"] as const) {
  assert.equal(typeof marketWindowCountdownLabel(phase), "string");
}

// ─── Grouping ───────────────────────────────────────────────────────────────

interface Row {
  market_id: string;
  clock?: MarketWindowClock;
}

const nextClock: MarketWindowClock = {
  submission_open_at_ms: OPEN + 300_000,
  submission_close_at_ms: CLOSE + 300_000,
  resolution_at_ms: RESOLVE + 300_000,
};

const rows: Row[] = [
  { market_id: "btc-next", clock: nextClock },
  { market_id: "btc", clock },
  { market_id: "eth", clock },
  { market_id: "sol", clock },
  { market_id: "xrp", clock },
  { market_id: "doge", clock },
  { market_id: "eth-next", clock: nextClock },
  { market_id: "unscheduled" },
];

{
  const { groups, unscheduled } = groupMarketsByWindow(rows, (r) => r.clock, "soonest");
  assert.equal(groups.length, 2, "two windows");
  assert.equal(groups[0]!.key, windowGroupKey(clock), "soonest to resolve first");
  assert.equal(groups[1]!.key, windowGroupKey(nextClock));
  assert.equal(groups[0]!.items.length, 5, "the five assets share one window");
  assert.equal(groups[1]!.items.length, 2);
  assert.deepEqual(
    unscheduled.map((r) => r.market_id),
    ["unscheduled"],
    "a market with no clock is surfaced, never silently dropped",
  );
  // Membership order inside a group follows input order, so a stable upstream
  // sort survives grouping.
  assert.deepEqual(
    groups[0]!.items.map((r) => r.market_id),
    ["btc", "eth", "sol", "xrp", "doge"],
  );
  assert.equal(groups[0]!.submissionCloseAtMs, CLOSE);
  assert.equal(groups[0]!.resolutionAtMs, RESOLVE);
}

{
  const { groups } = groupMarketsByWindow(rows, (r) => r.clock, "newest");
  assert.equal(groups[0]!.key, windowGroupKey(nextClock), "newest first reverses");
}

// Two series that share a resolution instant but take calls at different
// moments are DIFFERENT windows — one countdown cannot serve two deadlines.
{
  const sameEndDifferentClose: MarketWindowClock = {
    submission_open_at_ms: OPEN - 60_000,
    submission_close_at_ms: CLOSE - 60_000,
    resolution_at_ms: RESOLVE,
  };
  const { groups } = groupMarketsByWindow(
    [
      { market_id: "a", clock },
      { market_id: "b", clock: sameEndDifferentClose },
    ] as Row[],
    (r) => r.clock,
  );
  assert.equal(groups.length, 2, "same end instant, different close = two windows");
}

// …and so is a pair that shares BOTH the close and the resolution but opens at
// different moments. `marketWindowPhase` branches on `submission_open_at_ms`
// for the upcoming→open boundary, so a key built from only the last two
// instants merged these into one group whose header stated a single opening
// time that was wrong for half its members.
{
  const earlierOpen: MarketWindowClock = {
    submission_open_at_ms: OPEN - 120_000,
    submission_close_at_ms: CLOSE,
    resolution_at_ms: RESOLVE,
  };
  assert.notEqual(
    windowGroupKey(earlierOpen),
    windowGroupKey(clock),
    "the group key covers every instant the phase machine reads",
  );
  const { groups } = groupMarketsByWindow(
    [
      { market_id: "late-open", clock },
      { market_id: "early-open", clock: earlierOpen },
    ] as Row[],
    (r) => r.clock,
  );
  assert.equal(
    groups.length,
    2,
    "same close AND resolution, different open = two windows",
  );
  // The proof that merging them would have LIED: at this instant the two
  // windows are genuinely in different phases.
  const between = OPEN - 60_000;
  assert.equal(marketWindowPhase(earlierOpen, between, false), "open");
  assert.equal(marketWindowPhase(clock, between, false), "upcoming");
  for (const group of groups) {
    assert.equal(group.items.length, 1, "neither window absorbed the other");
  }
}

// Identical clocks still collapse to one group — the key got wider, not
// per-market.
{
  const twin: MarketWindowClock = { ...clock };
  const { groups } = groupMarketsByWindow(
    [
      { market_id: "a", clock },
      { market_id: "b", clock: twin },
    ] as Row[],
    (r) => r.clock,
  );
  assert.equal(groups.length, 1, "equal instants are still one window");
  assert.equal(groups[0]!.items.length, 2);
}

assert.deepEqual(groupMarketsByWindow([] as Row[], (r) => r.clock), {
  groups: [],
  unscheduled: [],
});

// ─── Local-day bounds ───────────────────────────────────────────────────────
//
// The user picks a day on a calendar in THEIR timezone, so the bounds have to
// be local midnight to local end-of-day. Parsing the string as UTC would shift
// the whole day for most of the world.

{
  const bounds = localDayEpochBounds("2026-08-10");
  assert.notEqual(bounds, null);
  const start = new Date(bounds!.fromEpochS * 1000);
  const end = new Date(bounds!.toEpochS * 1000);
  assert.equal(start.getFullYear(), 2026);
  assert.equal(start.getMonth(), 7);
  assert.equal(start.getDate(), 10);
  assert.equal(start.getHours(), 0);
  assert.equal(start.getMinutes(), 0);
  assert.equal(end.getDate(), 10, "the upper bound stays inside the same local day");
  assert.equal(end.getHours(), 23);
  assert.ok(bounds!.toEpochS > bounds!.fromEpochS);
  // A full local day, allowing for DST transitions (23h or 25h are valid).
  const spanHours = (bounds!.toEpochS - bounds!.fromEpochS) / 3600;
  assert.ok(spanHours > 22 && spanHours < 26, `local day span: ${spanHours}h`);
}

for (const bad of [
  "",
  "2026-8-10",
  "10/08/2026",
  "2026-13-01",
  "2026-02-31",
  "2026-00-10",
  "2026-08-00",
  "not-a-date",
]) {
  assert.equal(localDayEpochBounds(bad), null, `rejected: ${bad}`);
}

{
  const now = new Date(2026, 7, 10, 13, 45, 30, 250).getTime();
  const start = new Date(startOfLocalDayEpochS(now) * 1000);
  assert.equal(start.getDate(), 10);
  assert.equal(start.getHours(), 0);
  assert.equal(start.getMinutes(), 0);
  assert.equal(start.getSeconds(), 0);
}

// ─── Countdown formatting ───────────────────────────────────────────────────
//
// Fixed width matters: this string re-renders every second under tabular-nums,
// and a label that changes width makes the whole row twitch.

assert.equal(formatCountdown(0), "00:00");
assert.equal(formatCountdown(-5_000), "00:00", "a passed deadline never goes negative");
assert.equal(formatCountdown(1_000), "00:01");
assert.equal(formatCountdown(61_000), "01:01");
assert.equal(formatCountdown(300_000), "05:00");
assert.equal(formatCountdown(3_599_000), "59:59");
assert.equal(formatCountdown(3_600_000), "1:00:00");
assert.equal(formatCountdown(3_727_000), "1:02:07");
assert.equal(
  formatCountdown(299_999).length,
  formatCountdown(60_000).length,
  "sub-hour countdowns hold one width",
);

assert.equal(describeCountdown(0), "0 seconds");
assert.equal(describeCountdown(1_000), "1 second");
assert.equal(describeCountdown(125_000), "2 minutes 5 seconds");
assert.equal(describeCountdown(3_600_000), "1 hour");

process.stdout.write("OK markets matrix window logic smoke\n");
