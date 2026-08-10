import { strict as assert } from "node:assert";

import {
  parseQuestionWindowDurationSec,
  selectDiscoveryCandidates,
  type DiscoveryCandidateFilter,
} from "./discovery.js";
import type { GammaMarketSnapshot } from "./transform.js";

process.stdout.write("murmur Polymarket discovery candidate-selection smoke\n");

// ── parseQuestionWindowDurationSec: the window length lives in the question
//    text ("7:15PM-7:20PM"), NOT in startDate/endDate (Gamma's startDate is the
//    market creation time ~24h before close). Verified against live data.
assert.equal(parseQuestionWindowDurationSec("Bitcoin Up or Down - July 19, 7:15PM-7:20PM ET"), 300);
assert.equal(parseQuestionWindowDurationSec("Bitcoin Up or Down - July 19, 7:30PM-7:45PM ET"), 900);
assert.equal(parseQuestionWindowDurationSec("Ethereum Up or Down - July 19, 11:55PM-12:00AM ET"), 300, "midnight rollover");
assert.equal(parseQuestionWindowDurationSec("Solana Up or Down - July 19, 7:55PM-8:00PM ET"), 300, "hour rollover");
assert.equal(parseQuestionWindowDurationSec("no clock range here"), null);
assert.equal(parseQuestionWindowDurationSec("Bitcoin Up or Down - 7:20PM-7:20PM ET"), null, "zero-length rejected");

// ── selectDiscoveryCandidates: from a live-shaped mix (startDate = creation
//    time, not window start), only the 5-minute Up/Down rows with enough lead
//    and a matching asset survive.
const nowMs = Date.UTC(2026, 6, 19, 23, 0, 0, 0);
const creation = "2026-07-18T23:00:00Z"; // ~24h before close, as Gamma reports
const upDown = JSON.stringify(["Up", "Down"]);

function snap(over: Partial<GammaMarketSnapshot> & { conditionId: string }): GammaMarketSnapshot {
  return {
    outcomes: upDown,
    question: "Bitcoin Up or Down - July 19, 7:05PM-7:10PM ET",
    startDate: creation,
    endDate: "2026-07-19T23:15:00Z", // now + 900s: clears the 660s arm-close lead
    active: true,
    closed: false,
    archived: false,
    ...over,
  } as GammaMarketSnapshot;
}

// window 300 + openLead 300 + commitMargin 60 = 660s of lead required before
// arming closes. minLeadSec alone (120s) is NOT sufficient to register.
const filter: DiscoveryCandidateFilter = {
  nowMs,
  minLeadSec: 120,
  seriesClock: {
    submissionOpenLeadSec: 300,
    commitMarginSec: 60,
    deliveryBudgetSec: 60,
    embargoSec: 600,
  },
  questionFilter: "Up or Down",
  assets: ["Bitcoin", "Ethereum", "Solana", "Dogecoin"],
  windowDurationSec: 300,
};

const btc = snap({ conditionId: `0x${"1".repeat(64)}` }); // 5-min, lead 600s, Up/Down, Bitcoin → keep
const eth15 = snap({
  conditionId: `0x${"2".repeat(64)}`,
  question: "Ethereum Up or Down - July 19, 7:00PM-7:15PM ET", // 15-min → drop
});
const solSoon = snap({
  conditionId: `0x${"3".repeat(64)}`,
  question: "Solana Up or Down - July 19, 7:05PM-7:10PM ET",
  endDate: "2026-07-19T23:00:30Z", // lead 30s < 120 → drop
});
const dogeYesNo = snap({
  conditionId: `0x${"4".repeat(64)}`,
  question: "Dogecoin Up or Down - July 19, 7:05PM-7:10PM ET",
  outcomes: JSON.stringify(["Yes", "No"]), // not Up/Down → drop
});
const cardano = snap({
  conditionId: `0x${"5".repeat(64)}`,
  question: "Cardano Up or Down - July 19, 7:05PM-7:10PM ET", // asset not configured → drop
});
const subSecond = snap({
  conditionId: `0x${"6".repeat(64)}`,
  question: "Ethereum Up or Down - July 19, 7:05PM-7:10PM ET",
  endDate: "2026-07-19T23:10:00.500Z", // sub-second endDate → drop
});

const picked = selectDiscoveryCandidates([btc, eth15, solSoon, dogeYesNo, cardano, subSecond], filter);
assert.equal(picked.length, 1, `expected only the 5-min Bitcoin row, got ${picked.length}`);
assert.equal(picked[0].conditionId, btc.conditionId);
assert.equal(picked[0].endDateEpochSec, Math.floor(Date.parse("2026-07-19T23:15:00Z") / 1000));

// Earliest-end-first ordering across two valid 5-min rows.
const ethEarlier = snap({
  conditionId: `0x${"7".repeat(64)}`,
  question: "Ethereum Up or Down - July 19, 7:05PM-7:08PM ET", // 3-min → drop
});
const ethValidLater = snap({
  conditionId: `0x${"8".repeat(64)}`,
  question: "Ethereum Up or Down - July 19, 7:10PM-7:15PM ET",
  endDate: "2026-07-19T23:20:00Z", // 5-min, later end (still clears arm close)
});
const ordered = selectDiscoveryCandidates([ethValidLater, btc], filter);
assert.deepEqual(
  ordered.map((c) => c.conditionId),
  [btc.conditionId, ethValidLater.conditionId],
  "candidates sorted earliest-end-first",
);
void ethEarlier;

process.stdout.write("polymarket discovery candidate-selection smoke ok\n");

// ── Regression: past minLeadSec but past arm close is NOT registrable ───────
// This candidate clears minLeadSec (600s > 120s) but arming closed 60s ago
// (endDate - 660s). Admitting it stages a draft, then reverts at gas
// estimation, which aborts the tick — and because estimation failures do not
// count as attempts, the same candidate heads the queue again next tick and
// starves every registrable candidate behind it.
{
  const tooLate = selectDiscoveryCandidates(
    [snap({ conditionId: `0x${"9".repeat(64)}`, endDate: "2026-07-19T23:10:00Z" })],
    filter,
  );
  assert.equal(
    tooLate.length,
    0,
    "a candidate past arm close must be rejected at selection, not at gas estimation",
  );
}
