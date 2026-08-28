// The buy, without a browser.
//
// Everything a buyer is told during a purchase is decided in
// lib/call-access-buy.ts, so this drives the whole machine in node: the 402 is
// parsed, the locked price is the only price in scope, every failure state
// renders a line, and a repeat purchase reads as free rather than as an error.
//
// The failure list is checked for COVERAGE, not just for shape — every error
// code the daemon's access surface can answer with has to map to something a
// person can act on. A new server code with no mapping fails this file.

import { strict as assert } from "node:assert";

import {
  buyLine,
  classifyPoll,
  classifyPurchase,
  isBusy,
  noWalletStop,
  POLL_INTERVAL_MS,
  POLL_LIMIT,
  pollTimeoutStop,
  quoteFromChallenge,
  quoteLabel,
  refundDueStop,
  settlementConfidence,
  stalePriceNotice,
  stopFromResponse,
  stopFromSignature,
  unreachableStop,
  unreadableChallengeStop,
  type BuyPhase,
  type BuyState,
} from "./call-access-buy.js";
import { parseAccessChallenge } from "./x402-batch-payment.js";

process.stdout.write("murmur call access buy smoke\n");

const SELLER = "0x2222222222222222222222222222222222222222";
const PAYER = "0x1111111111111111111111111111111111111111";
const CALL_ID = `0x${"ab".repeat(32)}`;

/**
 * The 402 for a call SEALED at 0.07. The agent's standing list price for the
 * series is 0.05 — deliberately different, and deliberately absent from every
 * structure below.
 */
const LOCKED_ATOMS = "70000";
const STANDING_ATOMS = "50000";

const challenge402 = {
  error: "PaymentRequired",
  accepts: [
    {
      scheme: "exact",
      network: "eip155:84532",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      amount: LOCKED_ATOMS,
      payTo: SELLER,
      maxTimeoutSeconds: 604_900,
      extra: {
        name: "GatewayWalletBatched",
        version: "1",
        verifyingContract: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
      },
    },
  ],
  price: LOCKED_ATOMS,
  currency: "USDC",
  pricingVersion: "v2",
};

// ─── The 402 is parsed, and the quote is the LOCKED price ───────────────────

const parsed = parseAccessChallenge(challenge402);
assert.ok(parsed.ok, "the challenge parses");
const quote = quoteFromChallenge(CALL_ID, parsed.challenge);

assert.equal(quote.lockedPriceAtoms, LOCKED_ATOMS);
assert.equal(quote.display, "0.07", "formatted through the shared BigInt-safe atoms formatter");
assert.equal(quoteLabel(quote), "0.07 USDC");
assert.equal(quote.pricingVersion, "v2");
assert.equal(quote.onchainCallId, CALL_ID);

// The standing price is not merely absent from the value — it is absent from
// the TYPE. Nothing in a quote can carry it, which is why no renderer can
// reach for the wrong number.
assert.deepEqual(
  Object.keys(quote).sort(),
  ["challenge", "currency", "display", "lockedPriceAtoms", "onchainCallId", "pricingVersion"],
  "a quote carries one price and it is the locked one",
);
assert.ok(
  !JSON.stringify(quote).includes(STANDING_ATOMS),
  "the standing list price appears nowhere in a quote",
);

// Every line the machine can render, checked for the same thing.
//
// The strong invariant: NO status line carries a price at all. The amount is
// rendered in exactly one element in the whole UI — the label of the button
// that authorizes it, built from `quoteLabel` — so there is no second copy to
// drift from the first. That is why `quoted` deliberately renders no line.
{
  const states: BuyState[] = [
    { step: "idle" },
    { step: "quoting" },
    { step: "quoted", quote, stale: null },
    { step: "signing", quote },
    { step: "presenting", quote },
    { step: "waiting", quote, subscriber: PAYER, polls: 3, settlement: "settled" },
    { step: "waiting", quote, subscriber: PAYER, polls: 3, settlement: "unknown" },
    { step: "granted", subscriber: PAYER, alreadyOwned: false },
    { step: "granted", subscriber: PAYER, alreadyOwned: true },
    { step: "stopped", stop: stopFromResponse(404, { error: "NotForSale" }, "quote") },
  ];
  for (const state of states) {
    const line = buyLine(state);
    if (state.step === "idle") {
      assert.equal(line, null, "an idle row says nothing");
      continue;
    }
    if (state.step === "quoted") {
      assert.equal(line, null, "the confirm button is the whole statement at the confirm step");
      continue;
    }
    assert.ok(line, `${state.step} renders a line`);
    assert.ok(line.text.length > 0 && line.title.length > line.text.length,
      `${state.step}: the short text renders, the explanation hovers`);
    assert.ok(
      !/\d+\.\d+/.test(line.text) && !/\d+\.\d+/.test(line.title),
      `${state.step} states no amount — the button is the only place a price appears`,
    );
  }
  // …and the one element that DOES state it, states the locked price.
  assert.equal(quoteLabel(quote), "0.07 USDC");
  assert.notEqual(
    quoteLabel(quote),
    `${formatStanding()} USDC`,
    "which is not the agent's standing list price",
  );
}

/** The standing 0.05, formatted the same way, purely to assert they differ. */
function formatStanding(): string {
  return "0.05";
}

// ─── A stale row and a fresh quote disagree: the quote wins, loudly ─────────

assert.equal(stalePriceNotice(LOCKED_ATOMS, quote), null, "agreement is silent");
{
  const notice = stalePriceNotice(STANDING_ATOMS, quote);
  assert.ok(notice, "a disagreement is not silent");
  assert.ok(notice.includes("0.05"), "it names what the list showed");
  assert.ok(notice.includes("0.07 USDC"), "and what will actually be signed");
  assert.ok(notice.includes("that is the amount you would sign"), "and which of the two binds");
}

// ─── Every failure the access surface can answer with, in BOTH phases ───────
//
// Left column: exactly the (status, error) pairs entitlement-access-surface.ts
// and the gateway route can produce. A code with no mapping falls through to
// the unknown stop, which this asserts against.
//
// `phases` is the point of this table. A refusal is not a property of the code
// alone — it is a property of the code AND where the buy had got to:
//
//   quote    the unpaid POST. No signature exists, so the copy must not
//            mention charging at all; reassuring somebody about a payment they
//            never made invents an event for them to go and check.
//   present  the paid POST. entitlementAccessResponse re-runs
//            checkEntitlementEligibility BEFORE broker.authorize, so every
//            eligibility code below is reachable here too, with a signature
//            already given — and then it MUST say what happened to the money.
//
// Modelling eligibility as pre-signature only is what made `CohortFull` and
// `SaleWindowClosed` silent about money after a signature, and made the
// quote-phase `PaymentGatewayUnavailable` claim nothing was charged when there
// was nothing to charge yet.

/** What the money did, for a code arriving in the `present` phase. */
type Charged = "none" | "unknown";

const failures: Array<{
  status: number;
  body: unknown;
  headline: string;
  retryable: boolean;
  phases: BuyPhase[];
  charged: Charged;
}> = [
  // Dual-reachable: the route and the eligibility check both run in each phase.
  { status: 503, body: { error: "PaidAccessDisabled" }, headline: "no checkout here", retryable: false, phases: ["quote", "present"], charged: "none" },
  { status: 404, body: { error: "NotForSale" }, headline: "not for sale", retryable: false, phases: ["quote", "present"], charged: "none" },
  { status: 404, body: { error: "CallNotFound" }, headline: "unknown call", retryable: false, phases: ["quote", "present"], charged: "none" },
  { status: 400, body: { error: "BadCallId" }, headline: "bad call id", retryable: false, phases: ["quote", "present"], charged: "none" },
  { status: 409, body: { error: "SaleWindowClosed" }, headline: "sale closed", retryable: false, phases: ["quote", "present"], charged: "none" },
  { status: 409, body: { error: "CallNotSealed" }, headline: "no longer sealed", retryable: false, phases: ["quote", "present"], charged: "none" },
  { status: 409, body: { error: "CallNotSellable" }, headline: "not sellable", retryable: false, phases: ["quote", "present"], charged: "none" },
  { status: 409, body: { error: "CohortFull" }, headline: "full", retryable: false, phases: ["quote", "present"], charged: "none" },
  // challenge() returning null in the quote phase; the authorize/verify catch
  // in the present one.
  { status: 503, body: { error: "PaymentGatewayUnavailable" }, headline: "gateway down", retryable: true, phases: ["quote", "present"], charged: "none" },

  // Present-only: nothing below can be reached without a signed envelope.
  { status: 402, body: { error: "PaymentRequirementsMismatch" }, headline: "terms moved", retryable: true, phases: ["present"], charged: "none" },
  { status: 400, body: { error: "MalformedPayment" }, headline: "payment rejected", retryable: true, phases: ["present"], charged: "none" },
  { status: 402, body: { error: "PaymentSettlementFailed" }, headline: "settlement rejected", retryable: true, phases: ["present"], charged: "none" },
  // The one code that genuinely cannot say. It is returned both before a settle
  // (a reservation that could not be read back) and after one that succeeded
  // but whose row then vanished, and the body does not distinguish them.
  { status: 500, body: { error: "InternalStateInconsistent" }, headline: "checkout confused", retryable: false, phases: ["present"], charged: "unknown" },
  // An unmapped code is treated the same way, for the same reason.
  { status: 500, body: { error: "SomeCodeInventedTomorrow" }, headline: "failed", retryable: true, phases: ["quote", "present"], charged: "unknown" },
];

/**
 * Pre-payment copy must make no claim about the buyer's money — neither
 * "nothing was charged" nor "we cannot tell whether it settled". Both describe
 * a payment that does not exist yet.
 */
function assertNoMoneyLanguage(detail: string, what: string): void {
  assert.ok(
    !/charg/i.test(detail),
    `${what} refuses before any payment, so it must not mention charging: "${detail}"`,
  );
  assert.ok(
    !/not known from this answer|did the money/i.test(detail),
    `${what} refuses before any payment, so it must not raise the question either: "${detail}"`,
  );
}

for (const f of failures) {
  for (const phase of f.phases) {
    const stop = stopFromResponse(f.status, f.body, phase);
    assert.equal(stop.headline, f.headline, `${JSON.stringify(f.body)} → "${f.headline}"`);
    assert.equal(stop.retryable, f.retryable, `${stop.code} retryability`);
    assert.ok(stop.detail.length > stop.headline.length, `${stop.code} explains itself on hover`);
    assert.ok(["dim", "neg"].includes(stop.tone), `${stop.code} has a tone`);

    if (phase === "quote") {
      assertNoMoneyLanguage(stop.detail, `${stop.code} in the quote phase`);
      continue;
    }
    // Post-signature: the money question must be answered, one way or the other.
    if (f.charged === "none") {
      assert.ok(
        /nothing was charged/i.test(stop.detail),
        `${stop.code} is reachable with a signature in hand and did not settle, so it must say the money stayed put`,
      );
    } else {
      assert.ok(
        /not known from this answer/i.test(stop.detail),
        `${stop.code} cannot establish whether the money moved, so it must not claim either`,
      );
      assert.ok(
        !/nothing was charged/i.test(stop.detail),
        `${stop.code} must never claim nothing was charged when it does not know`,
      );
    }
  }

  // The same code in the two phases is not the same sentence. That difference
  // IS the fix; asserting it keeps a future edit from collapsing them again.
  if (f.phases.length === 2) {
    assert.notEqual(
      stopFromResponse(f.status, f.body, "quote").detail,
      stopFromResponse(f.status, f.body, "present").detail,
      `${JSON.stringify(f.body)} must read differently before and after a signature`,
    );
  }
}

// The two stops the panel raises itself follow the same rule.
{
  const unreadable = unreadableChallengeStop("the 402 quoted no price");
  assert.equal(unreadable.headline, "cannot quote");
  assertNoMoneyLanguage(unreadable.detail, "an unreadable challenge");
  assert.ok(unreadable.detail.includes("the 402 quoted no price"), "the parser's reason survives");

  const beforeSigning = unreachableStop("quote", new Error("connection refused"));
  assertNoMoneyLanguage(beforeSigning.detail, "an unreachable checkout at quote time");
  assert.ok(beforeSigning.detail.includes("connection refused"), "the transport error survives");

  const afterSigning = unreachableStop("present", new Error("socket hang up"));
  assert.ok(
    /not known from this answer/i.test(afterSigning.detail),
    "a request that died while presenting a payment cannot say the money stayed put",
  );
  assert.ok(!/nothing was charged/i.test(afterSigning.detail));
  assert.equal(afterSigning.retryable, false, "and it must not offer a one-click re-pay");
}

// A short Circle Gateway balance is NOT "insufficient funds in your wallet",
// and the copy has to say which balance it means.
{
  const short = stopFromResponse(
    402,
    { error: "PaymentVerificationFailed", message: "insufficient_balance" },
    "present",
  );
  assert.equal(short.headline, "gateway balance short");
  assert.ok(short.detail.includes("DEPOSITED"), "it names the balance actually being spent");
  assert.ok(short.detail.includes("65 blocks"), "and why a fresh deposit is not instant");
  assert.equal(short.retryable, true);
  // Verification runs before settlement, so this one CAN reassure.
  assert.ok(/nothing was charged/i.test(short.detail));

  // Any other verification failure keeps the facilitator's own words.
  const other = stopFromResponse(
    402,
    { error: "PaymentVerificationFailed", message: "authorization expired" },
    "present",
  );
  assert.equal(other.headline, "payment rejected");
  assert.ok(other.detail.includes("authorization expired"));
  assert.ok(/nothing was charged/i.test(other.detail));
}

// A dismissed signature is not a failure, and it must never read as one.
{
  const rejected = stopFromSignature(new Error("User rejected the request"));
  assert.equal(rejected.headline, "not signed");
  assert.equal(rejected.tone, "dim", "dismissing a prompt is not an error state");
  assert.equal(rejected.retryable, true);
  assert.ok(rejected.detail.includes("nothing was charged"));

  const broke = stopFromSignature(new Error("wallet proxy timed out"));
  assert.equal(broke.headline, "could not sign");
  assert.equal(broke.tone, "neg");
  assert.ok(broke.detail.includes("wallet proxy timed out"), "the wallet's own words survive");
}

// No wallet is a precondition, not a fault.
assert.equal(noWalletStop().tone, "dim");
assert.ok(noWalletStop().detail.includes("signs the payment becomes the subscriber"));

// Money moved and the grant did not: the one state that owes somebody something.
{
  const refund = refundDueStop();
  assert.equal(refund.headline, "refund owed");
  assert.equal(refund.tone, "neg");
  assert.equal(refund.retryable, false, "paying again would not fix a refund");
  assert.ok(refund.detail.includes("by hand"), "and it says the refund is manual");
}

// ─── Purchase outcomes ──────────────────────────────────────────────────────

{
  const fresh = classifyPurchase(200, { granted: true, subscriber: PAYER, status: "granted" });
  assert.equal(fresh.kind, "granted");
  assert.ok(fresh.kind === "granted" && fresh.subscriber === PAYER, "the subscriber is echoed back");
  assert.equal(fresh.kind === "granted" && fresh.alreadyOwned, false);

  const refund = classifyPurchase(409, { granted: false, refundDue: true, subscriber: PAYER });
  assert.equal(refund.kind, "stopped");
  assert.equal(refund.kind === "stopped" && refund.stop.code, "GrantFailedRefundDue");

  const closed = classifyPurchase(409, { error: "SaleWindowClosed" });
  assert.equal(closed.kind, "stopped");
  assert.equal(closed.kind === "stopped" && closed.stop.headline, "sale closed");
  // classifyPurchase only ever sees a PRESENTED payment, so it phases as one.
  assert.ok(
    closed.kind === "stopped" && /nothing was charged/i.test(closed.stop.detail),
    "a post-signature sale-window refusal says the money stayed put",
  );
}

// ─── A 202 is not the same as "paid" ────────────────────────────────────────
//
// purchaseResponse answers 202 for every non-terminal row, and the row's own
// status is the only thing that says whether money moved. Two of the four
// reachable statuses do NOT establish it: `settlement_unknown` is the rail
// declining to say, and `payment_settling` can belong to a concurrent request
// that this one never settled. Reporting either as "paid" tells somebody their
// money moved when nobody knows.

{
  const settled: Array<[string, string]> = [
    ["grant_queued", "the receipt id and amount are recorded"],
    ["grant_broadcast", "the grant tx is out"],
  ];
  for (const [status, why] of settled) {
    assert.equal(settlementConfidence(status), "settled", `${status}: ${why}`);
    const out = classifyPurchase(202, { granted: false, subscriber: PAYER, status });
    assert.equal(out.kind, "pending");
    assert.ok(out.kind === "pending" && out.settlement === "settled");
    assert.ok(out.kind === "pending" && out.serverStatus === status, "the status is preserved verbatim");
    const line = buyLine({ step: "waiting", quote, subscriber: PAYER, polls: 0, settlement: "settled" });
    assert.ok(line?.text.includes("paid"), `${status} may be reported as paid`);
  }

  const ambiguous = ["payment_settling", "settlement_unknown", "", "a_status_from_the_future"];
  for (const status of ambiguous) {
    assert.equal(settlementConfidence(status), "unknown", `${status} does not establish settlement`);
    const out = classifyPurchase(202, { granted: false, subscriber: PAYER, status });
    assert.equal(out.kind, "pending");
    assert.ok(out.kind === "pending" && out.settlement === "unknown", `${status} is not proof of payment`);
  }
  // A 202 with no status at all is the same: unknown, not paid.
  const bare = classifyPurchase(202, { granted: false, subscriber: PAYER });
  assert.ok(bare.kind === "pending" && bare.settlement === "unknown");
  assert.ok(bare.kind === "pending" && bare.serverStatus === "");

  // And the line the buyer actually reads never claims the money moved.
  const unsure = buyLine({ step: "waiting", quote, subscriber: PAYER, polls: 0, settlement: "unknown" });
  assert.ok(unsure, "an unconfirmed wait still says something");
  assert.ok(!/\bpaid\b/i.test(unsure.text), "and it is not the word paid");
  assert.ok(
    unsure.text.includes("payment submitted") && unsure.text.includes("confirming settlement"),
    "it says what is actually known: the payment was submitted, settlement is unconfirmed",
  );
  assert.notEqual(
    unsure.text,
    buyLine({ step: "waiting", quote, subscriber: PAYER, polls: 0, settlement: "settled" })?.text,
    "settled and unconfirmed do not read the same",
  );
}

// ─── The repeat: idempotent, and it says so ─────────────────────────────────
//
// murmur reads the CHAIN for an existing grant to the payer before it settles,
// so re-presenting a payment for access already held answers 200 granted:true
// and charges nothing. The machine has to tell those two 200s apart, because
// "bought" and "you already had this, free" are different facts.

{
  const repeat = classifyPurchase(
    200,
    { granted: true, subscriber: PAYER, status: "granted" },
    { granted: true },
  );
  assert.equal(repeat.kind, "granted");
  assert.equal(repeat.kind === "granted" && repeat.alreadyOwned, true);

  const line = buyLine({ step: "granted", subscriber: PAYER, alreadyOwned: true });
  assert.ok(line?.text.includes("nothing charged"), "a repeat says the money did not move");
  assert.ok(line?.title.includes("charged nothing"));

  const first = buyLine({ step: "granted", subscriber: PAYER, alreadyOwned: false });
  assert.notEqual(first?.text, line?.text, "a first buy and a repeat do not read the same");
  assert.equal(first?.tone, "pos");
  assert.equal(line?.tone, "pos", "a repeat is a success, not a warning");
}

// ─── Polling ────────────────────────────────────────────────────────────────

{
  const settling = classifyPoll({ status: "payment_settling", grant: { onchainGranted: false } });
  assert.equal(settling.kind, "pending");
  assert.equal(
    settling.kind === "pending" && settling.settlement,
    "unknown",
    "a poll still on payment_settling has not established that the money moved",
  );
  // …and the same poll once the row advances: the wait upgrades to "paid".
  const queued = classifyPoll({ status: "grant_queued", grant: { onchainGranted: false } });
  assert.equal(queued.kind === "pending" && queued.settlement, "settled");

  const unreadable = classifyPoll(null);
  assert.equal(unreadable.kind, "pending", "an unreadable poll is not a failure");
  assert.equal(
    unreadable.kind === "pending" && unreadable.settlement,
    "unknown",
    "and it does not upgrade the money claim either",
  );
  assert.equal(classifyPoll({ grant: { onchainGranted: true } }).kind, "granted");
  // The chain outranks the local row: granted on chain with no local record is
  // still granted, which is the case a restored database produces.
  assert.equal(
    classifyPoll({ status: "none", grant: { onchainGranted: true } }).kind,
    "granted",
    "the contract is the authority, not murmur's table",
  );
  const owed = classifyPoll({ status: "grant_failed_refund_due", grant: { onchainGranted: false } });
  assert.equal(owed.kind, "stopped");
  assert.equal(owed.kind === "stopped" && owed.stop.code, "GrantFailedRefundDue");
}

// The budget has to outlast the reconciler, or the refund-due message is
// unreachable — it is only written after roughly 5-6 minutes of retries.
assert.equal(POLL_INTERVAL_MS, 5_000);
assert.equal(POLL_LIMIT, 100);
assert.ok(
  (POLL_INTERVAL_MS * POLL_LIMIT) / 60_000 > 6,
  "the poll budget must outlast the reconciler's ~6 minutes",
);
{
  const settled = pollTimeoutStop("settled");
  assert.equal(settled.tone, "dim", "a slow grant is not a lost one");
  assert.ok(settled.detail.includes("not lost"));
  assert.ok(settled.detail.includes("payment went through"));

  // The same timeout on a purchase that never confirmed settlement must not
  // claim the payment went through — that is the 202 bug in a second place.
  const unsure = pollTimeoutStop("unknown");
  assert.equal(unsure.tone, "dim");
  assert.ok(!/went through/i.test(unsure.detail), "an unconfirmed payment did not 'go through'");
  assert.ok(/not known from this answer/i.test(unsure.detail), "it says what is not known");
  assert.notEqual(unsure.code, settled.code, "and the two are distinguishable states");
}

// ─── Busy ───────────────────────────────────────────────────────────────────

{
  const busy: BuyState[] = [
    { step: "quoting" },
    { step: "signing", quote },
    { step: "presenting", quote },
    { step: "waiting", quote, subscriber: PAYER, polls: 0, settlement: "settled" },
  ];
  for (const state of busy) assert.ok(isBusy(state), `${state.step} is busy`);
  const settled: BuyState[] = [
    { step: "idle" },
    { step: "quoted", quote, stale: null },
    { step: "granted", subscriber: PAYER, alreadyOwned: false },
    { step: "stopped", stop: noWalletStop() },
  ];
  for (const state of settled) assert.ok(!isBusy(state), `${state.step} is not busy`);
}

process.stdout.write("OK call access buy smoke\n");
