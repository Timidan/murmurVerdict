// ─── Buying early decrypt access, as a state machine ────────────────────────
//
// PURE. Data in, data out — no React, no fetch, no wallet. The component that
// drives this (components/compact/BuyAccessPanel.tsx) owns the network and the
// signature prompt; everything that decides WHAT THE BUYER IS TOLD lives here,
// so every branch is smoke-testable in node.
//
// ONE PRICE EXISTS IN THIS FILE, AND IT IS THE LOCKED ONE.
//
// `BuyQuote` has no field for an agent's standing list price, the same way
// `OpenCallView` in listings-matrix.ts has none. The number it carries comes
// from the 402 challenge, which the daemon resolves through the same
// `termsFromSnapshot` the storefront reads — the call's own frozen snapshot.
// A renderer cannot reach for "the price" here because only one is in scope.
//
// The buy is IDEMPOTENT and this file leans on that rather than guarding it:
// murmur checks the chain for an existing grant to the payer BEFORE settling,
// so re-presenting a payment for access you already hold answers 200
// `granted: true` and charges nothing. A repeat is a legitimate action, not an
// error, and it renders as one.

import { formatAtoms } from "./atoms-format.js";
import type { ParsedChallenge } from "./x402-batch-payment.js";

/**
 * What the checkout will charge for ONE sealed call, as the daemon quoted it.
 *
 * Deliberately built only from a 402 response. Nothing constructs a quote from
 * a listing row, because a listing row is the place a standing price could
 * arrive from.
 */
export interface BuyQuote {
  onchainCallId: string;
  /** Atoms, BigInt-safe as a string. The LOCKED price for this call. */
  lockedPriceAtoms: string;
  currency: string;
  pricingVersion: string;
  /** "0.07" — through the shared atoms formatter, never through Number(). */
  display: string;
  challenge: ParsedChallenge;
}

export function quoteFromChallenge(
  onchainCallId: string,
  challenge: ParsedChallenge,
): BuyQuote {
  return {
    onchainCallId,
    lockedPriceAtoms: challenge.priceAtoms,
    currency: challenge.currency,
    pricingVersion: challenge.pricingVersion,
    display: formatAtoms(challenge.priceAtoms, challenge.currency),
    challenge,
  };
}

/** `0.07 USDC`, for the one place the buyer confirms an amount. */
export function quoteLabel(quote: BuyQuote): string {
  return `${quote.display} ${quote.currency.toUpperCase()}`;
}

/**
 * Does the price the row was DRAWN with still match the price the checkout
 * quotes? A sealed call's locked terms never change, so a mismatch means this
 * browser is holding a stale inventory read — not that the price moved.
 *
 * Returns null when they agree. When they disagree the caller renders the
 * QUOTE, because the quote is what gets signed; the message only explains why
 * the row above it says something else.
 */
export function stalePriceNotice(
  rowLockedPriceAtoms: string,
  quote: BuyQuote,
): string | null {
  if (rowLockedPriceAtoms === quote.lockedPriceAtoms) return null;
  return (
    `This list was drawn at ${formatAtoms(rowLockedPriceAtoms, quote.currency)} ` +
    `${quote.currency.toUpperCase()}. The checkout quotes ${quoteLabel(quote)}, ` +
    `and that is the amount you would sign. Reload to refresh the list.`
  );
}

/* ── Stops ────────────────────────────────────────────────────────────────── */

/**
 * WHERE in the buy a refusal arrived. It changes what is true about the money,
 * and therefore what the buyer has to be told.
 *
 *   quote    the unpaid POST that asks for the 402. No wallet has been touched
 *            yet, so a refusal here must not mention charging AT ALL — there
 *            was no payment to reassure anybody about, and naming one invents
 *            an event the buyer then has to go and check.
 *   present  the POST carrying a signed authorization. The daemon re-runs
 *            eligibility here — sale window, call state, cohort capacity —
 *            BEFORE it authorizes or settles, so every eligibility code is
 *            reachable in this phase too, with a signature already given. Those
 *            stops must say what happened to the money.
 *
 * Same server code, two different true sentences. That is the whole reason
 * this parameter exists.
 */
export type BuyPhase = "quote" | "present";

/**
 * A reason the buy went no further. Every one of these is terminal for THIS
 * attempt; `retryable` says whether trying again could plausibly differ.
 *
 * `headline` is what the row shows — a few words. `detail` is the whole
 * sentence and belongs on `title=`, per the design rule that detail hovers.
 */
export interface BuyStop {
  code: string;
  headline: string;
  detail: string;
  tone: "dim" | "neg";
  retryable: boolean;
}

/** Body fields the access surface answers with. All optional — junk is tolerated. */
interface AccessErrorBody {
  error?: unknown;
  message?: unknown;
  granted?: unknown;
  refundDue?: unknown;
  subscriber?: unknown;
  status?: unknown;
  grantTxHash?: unknown;
}

function errorCode(body: unknown): string {
  const record = (body ?? {}) as AccessErrorBody;
  return typeof record.error === "string" ? record.error : "";
}

function serverMessage(body: unknown): string {
  const record = (body ?? {}) as AccessErrorBody;
  return typeof record.message === "string" ? record.message : "";
}

/**
 * Circle reports a short Gateway balance as an invalid-reason on verification.
 *
 * It matters that this reads differently from every other 402: the money is not
 * short in the wallet, it is short in the buyer's Circle Gateway DEPOSIT. The
 * batched scheme spends that balance, deposits take ~65 blocks to become
 * spendable, and no browser button can shorten that. Saying "insufficient
 * funds" would send a buyer to look at a wallet balance that is not the one
 * being spent.
 */
function isInsufficientGatewayBalance(message: string): boolean {
  return /insufficient[_\s-]?balance|insufficient funds/i.test(message);
}

/**
 * What a code means for the MONEY when it arrives after a signature.
 *
 *   none     the daemon refused before settlement ran. Verification, the
 *            requirements match and the eligibility re-check all sit before
 *            `settle()` in entitlement-access.ts, so a signature exists but no
 *            payment was ever presented to Circle.
 *   unknown  the answer does not establish either way. Claiming "nothing was
 *            charged" here is the failure this whole phase split exists to
 *            prevent.
 */
type ChargeOutcome = "none" | "unknown";

const CHARGE_CLAUSE: Record<ChargeOutcome, string> = {
  none: "Nothing was charged.",
  unknown:
    "Whether the payment settled is not known from this answer. Check the purchases panel on your account before paying again.",
};

interface StopSpec {
  headline: string;
  /** Phase-neutral: what happened, carrying no money language of any kind. */
  detail: string;
  tone: "dim" | "neg";
  retryable: boolean;
  charged: ChargeOutcome;
}

const STOPS: Record<string, StopSpec> = {
  PaidAccessDisabled: {
    headline: "no checkout here",
    detail:
      "This deployment does not run the paid access surface, so nothing can be bought from it.",
    tone: "dim",
    retryable: false,
    charged: "none",
  },
  NotForSale: {
    headline: "not for sale",
    detail: "This agent does not sell early access to its calls.",
    tone: "dim",
    retryable: false,
    charged: "none",
  },
  CallNotFound: {
    headline: "unknown call",
    detail: "This deployment has no record of that sealed call.",
    tone: "dim",
    retryable: false,
    charged: "none",
  },
  BadCallId: {
    headline: "bad call id",
    detail: "The call id is not a 32-byte hash, so no sale could be looked up.",
    tone: "neg",
    retryable: false,
    charged: "none",
  },
  SaleWindowClosed: {
    headline: "sale closed",
    detail:
      "The window for buying early access to this call has closed. It closes before the prediction window opens, not at reveal.",
    tone: "dim",
    retryable: false,
    charged: "none",
  },
  CallNotSealed: {
    headline: "no longer sealed",
    detail: "This call is no longer sealed, so there is no early access left to sell.",
    tone: "dim",
    retryable: false,
    charged: "none",
  },
  CallNotSellable: {
    headline: "not sellable",
    detail:
      "The chain did not record this call as an early-access submission, so a grant could not be delivered for it.",
    tone: "dim",
    retryable: false,
    charged: "none",
  },
  CohortFull: {
    headline: "full",
    detail:
      "This call has reached the maximum number of subscribers its owner allowed. Paying again would not add a seat.",
    tone: "dim",
    retryable: false,
    charged: "none",
  },
  PaymentGatewayUnavailable: {
    headline: "gateway down",
    detail: "Circle's payment gateway could not be reached, so no price could be quoted or verified.",
    tone: "neg",
    retryable: true,
    charged: "none",
  },
  PaymentRequirementsMismatch: {
    headline: "terms moved",
    detail:
      "The signed payment no longer matches the terms this call is sold under. Start the buy again to sign against the current challenge.",
    tone: "neg",
    retryable: true,
    charged: "none",
  },
  MalformedPayment: {
    headline: "payment rejected",
    detail: "The payment envelope was not accepted.",
    tone: "neg",
    retryable: true,
    charged: "none",
  },
  // Circle answered the settle call with a definitive rejection, so the
  // reservation is released and a fresh nonce can retry.
  PaymentSettlementFailed: {
    headline: "settlement rejected",
    detail: "Circle rejected the settlement, so the payment did not go through.",
    tone: "neg",
    retryable: true,
    charged: "none",
  },
  // Reachable both before settlement (an adoption or reservation that could not
  // be read back) and after one that DID settle but whose row then vanished.
  // The two are indistinguishable from here, so this must not claim either.
  InternalStateInconsistent: {
    headline: "checkout confused",
    detail: "The checkout could not resolve this purchase's own state.",
    tone: "neg",
    retryable: false,
    charged: "unknown",
  },
};

const UNKNOWN_STOP: StopSpec = {
  headline: "failed",
  detail: "The checkout answered in a way this page does not recognise.",
  tone: "neg",
  retryable: true,
  charged: "unknown",
};

/**
 * A server error body → the stop the row renders, in the phase it arrived in.
 *
 * `phase` is required on purpose. It used to be absent, and the copy was
 * written as if eligibility could only refuse before a signature: `CohortFull`
 * and `SaleWindowClosed` said nothing about money even when they arrived with a
 * signature in hand, while the quote-phase `PaymentGatewayUnavailable`
 * reassured a buyer about a charge that could not have happened yet.
 */
export function stopFromResponse(status: number, body: unknown, phase: BuyPhase): BuyStop {
  const code = errorCode(body) || `HTTP${status}`;
  const message = serverMessage(body);
  const spec = specFor(code, message);
  const detail = phase === "present" ? `${spec.detail} ${CHARGE_CLAUSE[spec.charged]}` : spec.detail;
  return {
    code,
    headline: spec.headline,
    tone: spec.tone,
    retryable: spec.retryable,
    detail: detailWith(detail, message),
  };
}

function specFor(code: string, message: string): StopSpec {
  if (code === "PaymentVerificationFailed") {
    // Verification runs before settlement either way, so both branches are
    // `charged: "none"` — what differs is WHICH balance the buyer must look at.
    return isInsufficientGatewayBalance(message)
      ? {
          headline: "gateway balance short",
          detail:
            "Circle rejected the payment for a short Gateway balance. This scheme spends USDC you have DEPOSITED with Circle's Gateway, not the balance sitting in your wallet, and a fresh deposit takes about 65 blocks to become spendable.",
          tone: "neg",
          retryable: true,
          charged: "none",
        }
      : {
          headline: "payment rejected",
          detail: `Circle did not accept the payment${message ? `: ${message}` : ""}.`,
          tone: "neg",
          retryable: true,
          charged: "none",
        };
  }
  return STOPS[code] ?? UNKNOWN_STOP;
}

/**
 * The 402 arrived but this page cannot sign what it asks for.
 *
 * Quote phase only, by construction — the challenge is read once, before any
 * wallet prompt — so it names no charge.
 */
export function unreadableChallengeStop(reason: string): BuyStop {
  return {
    code: "UnreadableChallenge",
    headline: "cannot quote",
    detail: `The checkout answered with terms this page cannot sign: ${reason}.`,
    tone: "neg",
    retryable: false,
  };
}

/**
 * The daemon did not answer at all.
 *
 * Phase decides everything here. Before a signature there is no payment to
 * describe. After one, the request may or may not have reached settlement, and
 * saying "nothing was charged" would be a guess about somebody's money.
 */
export function unreachableStop(phase: BuyPhase, error: unknown): BuyStop {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (phase === "quote") {
    return {
      code: "Unreachable",
      headline: "cannot reach checkout",
      detail: `The checkout did not answer: ${message}. Nothing has been signed.`,
      tone: "neg",
      retryable: true,
    };
  }
  return {
    code: "Unreachable",
    headline: "no answer",
    detail:
      `The daemon did not answer while presenting the payment: ${message}. ` +
      CHARGE_CLAUSE.unknown,
    tone: "neg",
    retryable: false,
  };
}

/** The signature prompt was dismissed, or the wallet refused. */
export function stopFromSignature(error: unknown): BuyStop {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/reject|denied|cancel|dismiss|user closed/i.test(message)) {
    return {
      code: "SignatureRejected",
      headline: "not signed",
      detail: "You dismissed the signature, so no payment was made and nothing was charged.",
      tone: "dim",
      retryable: true,
    };
  }
  return {
    code: "SignatureFailed",
    headline: "could not sign",
    detail: `The wallet could not sign the payment${message ? `: ${message}` : ""}. Nothing was charged.`,
    tone: "neg",
    retryable: true,
  };
}

/** The grant could not be delivered after the money moved. */
export function refundDueStop(): BuyStop {
  return {
    code: "GrantFailedRefundDue",
    headline: "refund owed",
    detail:
      "The payment settled but the on-chain grant could not be delivered, so a refund is owed to you. The operator sends refunds by hand; the row is on your account's purchases panel.",
    tone: "neg",
    retryable: false,
  };
}

/** The refund for that undelivered grant is already recorded. Nothing is owed. */
export function refundedStop(): BuyStop {
  return {
    code: "GrantFailedRefunded",
    headline: "refunded",
    detail:
      "The on-chain grant could not be delivered, so the operator refunded this payment. Nothing is owed to you; the row is on your account's purchases panel.",
    tone: "dim",
    retryable: false,
  };
}

/**
 * `refunded` is the SETTLED end of the same story `grant_failed_refund_due`
 * starts, and telling a buyer money is owed after it has been sent back sends
 * them chasing a refund they already have.
 */
function refundStop(serverStatus: unknown): BuyStop {
  return serverStatus === "refunded" ? refundedStop() : refundDueStop();
}

/** No wallet to pay from — the one precondition this page cannot supply itself. */
export function noWalletStop(): BuyStop {
  return {
    code: "NoWallet",
    headline: "sign in to buy",
    detail:
      "The wallet that signs the payment becomes the subscriber, so a buy needs a signed-in wallet. Nothing else identifies the buyer.",
    tone: "dim",
    retryable: false,
  };
}

function detailWith(base: string, message: string): string {
  return message && !base.includes(message) ? `${base} (${message})` : base;
}

/* ── The machine ──────────────────────────────────────────────────────────── */

/**
 * Has the money definitely moved?
 *
 * Read off the server's own status union
 * (src/verdict/repos/entitlements-repo.ts `EntitlementStatus`), which a 202
 * echoes back as `status`:
 *
 *   payment_settling      reserved; the settle call is in flight, or belongs to
 *                         a CONCURRENT request that this one never made
 *   settlement_unknown    the rail threw or answered ambiguously — money may or
 *                         may not have moved; only the reconciler can say
 *   grant_queued          settled: the receipt id and amount are recorded
 *   grant_broadcast       settled: the grant tx is out
 *   granted               settled and delivered (a 200, not a 202)
 *   grant_failed_refund_due   settled, and owed back (a 409)
 *   refunded                  settled, and already sent back (a 409)
 *
 * Only the third and fourth are evidence of a completed payment. Anything else
 * — including a status this page has never heard of — is "unknown", because the
 * safe default when you cannot tell is not to claim somebody was charged.
 */
export type SettlementConfidence = "settled" | "unknown";

const SETTLED_STATUSES = new Set(["grant_queued", "grant_broadcast", "granted"]);

export function settlementConfidence(serverStatus: unknown): SettlementConfidence {
  return typeof serverStatus === "string" && SETTLED_STATUSES.has(serverStatus)
    ? "settled"
    : "unknown";
}

export type BuyState =
  | { step: "idle" }
  /** Asking the daemon what this call costs. No money, no wallet yet. */
  | { step: "quoting" }
  /** The 402 came back. The buyer confirms this exact amount before signing. */
  | { step: "quoted"; quote: BuyQuote; stale: string | null }
  /** The wallet is holding a signature prompt. */
  | { step: "signing"; quote: BuyQuote }
  /** Signed, and presented to the daemon. */
  | { step: "presenting"; quote: BuyQuote }
  /**
   * Presented, and the grant has not landed yet. `settlement` carries whether
   * the money is KNOWN to have moved — a 202 is not proof that it did, and the
   * line this state renders changes accordingly.
   */
  | {
      step: "waiting";
      quote: BuyQuote;
      subscriber: string;
      polls: number;
      settlement: SettlementConfidence;
    }
  /** Terminal success. `alreadyOwned` means the repeat cost nothing. */
  | { step: "granted"; subscriber: string; alreadyOwned: boolean }
  | { step: "stopped"; stop: BuyStop };

export const IDLE: BuyState = { step: "idle" };

/** True while a network call or a wallet prompt is outstanding. */
export function isBusy(state: BuyState): boolean {
  return (
    state.step === "quoting" ||
    state.step === "signing" ||
    state.step === "presenting" ||
    state.step === "waiting"
  );
}

/**
 * What a POST /access carrying a payment means.
 *
 * 200 splits two ways on the wire — a fresh grant and a grant this payer
 * already held both answer `granted: true` — and the machine keeps them apart
 * because "you already own this, nothing was charged" is a different thing to
 * tell somebody than "bought".
 *
 * 202 splits too, and that split used to be dropped. Every 202 was reported as
 * "paid", but the status it carries can be `settlement_unknown` (the rail did
 * not say whether the money moved) or a `payment_settling` reservation opened
 * by a DIFFERENT request, in which case this one never settled anything.
 * Telling a buyer their money moved when nobody knows is the wrong failure, so
 * the status is preserved and the confidence derived from it.
 */
export type PurchaseOutcome =
  | { kind: "granted"; subscriber: string; alreadyOwned: boolean }
  | {
      kind: "pending";
      subscriber: string;
      /** The server's own status string, verbatim. "" when it sent none. */
      serverStatus: string;
      settlement: SettlementConfidence;
    }
  | { kind: "stopped"; stop: BuyStop };

export function classifyPurchase(
  status: number,
  body: unknown,
  /** What the entitlement row said BEFORE this attempt, when the caller knows. */
  knownBefore?: { granted: boolean },
): PurchaseOutcome {
  const record = (body ?? {}) as AccessErrorBody;
  const subscriber = typeof record.subscriber === "string" ? record.subscriber : "";

  if (status === 200 && record.granted === true) {
    return { kind: "granted", subscriber, alreadyOwned: knownBefore?.granted === true };
  }
  if (status === 202) {
    return {
      kind: "pending",
      subscriber,
      serverStatus: typeof record.status === "string" ? record.status : "",
      settlement: settlementConfidence(record.status),
    };
  }
  if (status === 409 && record.refundDue === true) {
    return { kind: "stopped", stop: refundStop(record.status) };
  }
  // Anything reaching here answered a PRESENTED payment.
  return { kind: "stopped", stop: stopFromResponse(status, body, "present") };
}

/** The shape GET /access/status answers with, narrowed to what the buy needs. */
export interface AccessStatusBody {
  status?: string;
  grant?: { onchainGranted?: boolean; txHash?: string | null };
  lastError?: string | null;
}

export type PollOutcome =
  | { kind: "granted" }
  | { kind: "pending"; settlement: SettlementConfidence }
  | { kind: "stopped"; stop: BuyStop };

/**
 * The on-chain grant is the authority, not the local row: `onchainGranted` is
 * read from the contract, so it stays true even when the daemon's own record of
 * the purchase is missing.
 *
 * A pending poll also re-reads the settlement confidence, which is how a
 * purchase that started out ambiguous upgrades its line once the row reaches
 * `grant_queued` — and how one that never settles keeps saying so.
 */
export function classifyPoll(body: AccessStatusBody | null | undefined): PollOutcome {
  if (body?.grant?.onchainGranted === true) return { kind: "granted" };
  if (body?.status === "grant_failed_refund_due" || body?.status === "refunded") {
    return { kind: "stopped", stop: refundStop(body.status) };
  }
  return { kind: "pending", settlement: settlementConfidence(body?.status) };
}

/**
 * How long to wait for a grant before saying so.
 *
 * 100 × 5s ≈ 8m20s, matching tools/subscriber-buy-access.ts exactly. Sized to
 * OUTLAST the slowest honest answer rather than the fastest: a purchase that
 * stalls mid-settle only reaches its terminal refund-due state after the
 * reconciler's full budget, measured live at 5-6 minutes. A shorter budget
 * expires before the one message that tells a buyer money is owed back.
 */
export const POLL_INTERVAL_MS = 5_000;
export const POLL_LIMIT = 100;

/**
 * The wait ran out. What it ran out ON decides the sentence: a settled payment
 * whose grant is slow is genuinely "not lost", while a purchase that never
 * confirmed settlement cannot be described as having gone through.
 */
export function pollTimeoutStop(settlement: SettlementConfidence): BuyStop {
  if (settlement === "settled") {
    return {
      code: "GrantTimeout",
      headline: "still landing",
      detail:
        "The payment went through and the grant has not confirmed yet. It is not lost — check the purchases panel on your account, which reads the same record.",
      tone: "dim",
      retryable: false,
    };
  }
  return {
    code: "SettlementTimeout",
    headline: "still confirming",
    detail:
      "This purchase has not confirmed either its settlement or its grant yet. " +
      CHARGE_CLAUSE.unknown,
    tone: "dim",
    retryable: false,
  };
}

/* ── What the row says ────────────────────────────────────────────────────── */

export interface BuyLine {
  tone: "dim" | "pos" | "neg";
  text: string;
  /** The whole explanation, for `title=`. Never rendered inline. */
  title: string;
}

/**
 * One short line per state — and NO LINE CARRIES AN AMOUNT.
 *
 * The price is rendered in exactly one place in the whole UI: the label of the
 * button that authorizes it, built from `quoteLabel` on the 402's quote. A
 * status line that also stated a number would be a second copy to keep in step
 * with the first, and the two-price bug on this path is precisely a copy that
 * drifted. So `quoted` returns null: at that step the button is the whole
 * statement.
 */
export function buyLine(state: BuyState): BuyLine | null {
  switch (state.step) {
    case "idle":
      return null;
    case "quoting":
      return {
        tone: "dim",
        text: "asking the price…",
        title: "Requesting the payment challenge for this call. No wallet is involved yet.",
      };
    case "quoted":
      return null;
    case "signing":
      return {
        tone: "dim",
        text: "waiting for your signature…",
        title: "Your wallet is holding the payment authorization. Nothing is charged until it is signed and presented.",
      };
    case "presenting":
      return {
        tone: "dim",
        text: "presenting payment…",
        title: "The signed authorization is with the daemon, which verifies it before charging anything.",
      };
    case "waiting":
      // Two different facts, and the difference is somebody's money. Only the
      // first says "paid", and it says it only when the server's own status
      // records a settled payment.
      return state.settlement === "settled"
        ? {
            tone: "dim",
            text: "paid · waiting for the grant…",
            title:
              "The payment is verified and settled, and the on-chain decrypt grant is being broadcast to your wallet. " +
              "This usually takes under a minute.",
          }
        : {
            tone: "dim",
            text: "payment submitted · confirming settlement and grant…",
            title:
              "Your signed payment is with murmur, which has not yet confirmed that it settled. " +
              "This resolves either way on its own; the purchases panel on your account reads the same record.",
          };
    case "granted":
      return state.alreadyOwned
        ? {
            tone: "pos",
            text: "already yours · nothing charged",
            title:
              "This wallet already held decrypt access to this call, so murmur charged nothing and re-confirmed the grant.",
          }
        : {
            tone: "pos",
            text: "granted",
            title:
              "Your wallet can now decrypt this call before its public reveal. Decrypt it locally here or from your purchases. murmur never sees the plaintext.",
          };
    case "stopped":
      return { tone: state.stop.tone, text: state.stop.headline, title: state.stop.detail };
  }
}
