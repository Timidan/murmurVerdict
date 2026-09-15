/**
 * Series clock: the single source of truth for a market instance's schedule.
 * Every instant derives from the venue's end time plus four per-series
 * constants fixed at registration.
 *
 *   armCloseAt      consumers stop arming; the cohort is frozen
 *        │          murmur commits the cohort in this gap
 *   submissionOpenAt   providers may begin submitting
 *        │
 *   earlyAccessCutoffAt   last submission that can still be SOLD
 *        │              (later ones are refereed and scored, never granted)
 *   submissionCloseAt   last submission accepted at all; == prediction window
 *        │              start, so nothing is accepted once the window is live
 *   marketResolutionAt  the venue's end time — when the outcome is determined
 *        │
 *   publicRevealAt      the value becomes public
 *
 * `commitMarginSec` must be positive: the cohort commit is a transaction, and
 * without a margin a provider's submit could be mined before it.
 *
 * Windows are half-open `[open, close)`. A submission at exactly
 * `submissionCloseAt` is REJECTED: the window has begun and the opening price
 * may already be observable.
 *
 * Keep `marketResolutionAt` and `publicRevealAt` separate; reveal is embargoed
 * past resolution, and the resolver keys its horizon off marketResolutionAt.
 */

export interface SeriesClockConfig {
  /** Providers may submit from `submissionCloseAt - submissionOpenLeadSec`. */
  submissionOpenLeadSec: number;
  /** Ordering margin between arm close and submissions opening. Must be > 0. */
  commitMarginSec: number;
  /**
   * Delivery headroom reserved before the prediction window opens. A call sold
   * to subscribers must be granted and decryptable before the window is live,
   * so sellable submissions stop this far ahead of `submissionCloseAt`.
   */
  deliveryBudgetSec: number;
  /** How long after market resolution the sealed value stays private. */
  embargoSec: number;
}

export interface SeriesClock {
  armCloseAtMs: number;
  submissionOpenAtMs: number;
  earlyAccessCutoffAtMs: number;
  submissionCloseAtMs: number;
  marketResolutionAtMs: number;
  publicRevealAtMs: number;
}

export class SeriesClockConfigError extends Error {
  constructor(
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "SeriesClockConfigError";
  }
}

const SEC = 1_000;

function requirePositiveInt(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new SeriesClockConfigError(
      `${name} must be a positive whole number of seconds`,
      { [name]: value },
    );
  }
}

/**
 * Validate a series' constants independently of any instance. Call this at
 * registration: a misordered config yields a schedule that is silently
 * unusable (zero-length or inverted windows) rather than obviously broken.
 */
export function assertSeriesClockConfig(config: SeriesClockConfig): void {
  requirePositiveInt(config.submissionOpenLeadSec, "submissionOpenLeadSec");
  requirePositiveInt(config.commitMarginSec, "commitMarginSec");
  requirePositiveInt(config.deliveryBudgetSec, "deliveryBudgetSec");
  requirePositiveInt(config.embargoSec, "embargoSec");

  // submissionOpenLeadSec > deliveryBudgetSec, strictly. Equal collapses the
  // sellable window to zero length; less inverts it, putting the early-access
  // cutoff before submissions even open.
  if (config.submissionOpenLeadSec <= config.deliveryBudgetSec) {
    throw new SeriesClockConfigError(
      "submissionOpenLeadSec must be strictly greater than deliveryBudgetSec, " +
        "or there is no window in which a sellable call can be submitted",
      {
        submissionOpenLeadSec: config.submissionOpenLeadSec,
        deliveryBudgetSec: config.deliveryBudgetSec,
      },
    );
  }
}

/**
 * Derive an instance's schedule. `windowSec` is the prediction window length
 * (for Polymarket up/down series it is parsed from the question text, since
 * Gamma's `startDate` is market *creation* time, not window start).
 *
 * Throws if the config is invalid or if the resulting schedule is degenerate.
 */
export function deriveSeriesClock(input: {
  endDateMs: number;
  windowSec: number;
  config: SeriesClockConfig;
}): SeriesClock {
  const { endDateMs, windowSec, config } = input;

  if (!Number.isFinite(endDateMs) || !Number.isInteger(endDateMs)) {
    throw new SeriesClockConfigError("endDateMs must be an integer epoch ms", {
      endDateMs,
    });
  }
  // The chain stores whole seconds; a sub-second end time cannot round-trip
  // through registration and acceptance consistently.
  if (endDateMs % SEC !== 0) {
    throw new SeriesClockConfigError(
      "endDateMs must land on a whole second; sub-second market end times " +
        "cannot be represented identically on-chain and off-chain",
      { endDateMs },
    );
  }
  requirePositiveInt(windowSec, "windowSec");
  assertSeriesClockConfig(config);

  const marketResolutionAtMs = endDateMs;
  const submissionCloseAtMs = endDateMs - windowSec * SEC;
  const earlyAccessCutoffAtMs =
    submissionCloseAtMs - config.deliveryBudgetSec * SEC;
  const submissionOpenAtMs =
    submissionCloseAtMs - config.submissionOpenLeadSec * SEC;
  const armCloseAtMs = submissionOpenAtMs - config.commitMarginSec * SEC;
  const publicRevealAtMs = endDateMs + config.embargoSec * SEC;

  return {
    armCloseAtMs,
    submissionOpenAtMs,
    earlyAccessCutoffAtMs,
    submissionCloseAtMs,
    marketResolutionAtMs,
    publicRevealAtMs,
  };
}

/**
 * Registration must finish before arming closes, not just before the market
 * ends; a long window can put `armCloseAt` before the instance even exists.
 */
export function isRegistrable(clock: SeriesClock, nowMs: number): boolean {
  return nowMs < clock.armCloseAtMs;
}

export type SubmissionClass = "early_access" | "late_unsellable";

export type SubmissionAdmission =
  | { admitted: true; class: SubmissionClass }
  | { admitted: false; reason: "before_submission_open" | "after_submission_close" };

/**
 * Classify a submission attempt against the clock. Half-open throughout:
 * `[submissionOpenAt, earlyAccessCutoffAt)` is sellable,
 * `[earlyAccessCutoffAt, submissionCloseAt)` is refereed-only, and
 * `submissionCloseAt` itself is already too late.
 *
 * The distinction is load-bearing beyond commerce: a provider who only ever
 * submits in the late window is predicting with strictly more information than
 * one who sells, so the two classes must not share a reputation score.
 */
export function classifySubmission(
  clock: SeriesClock,
  atMs: number,
): SubmissionAdmission {
  if (atMs < clock.submissionOpenAtMs) {
    return { admitted: false, reason: "before_submission_open" };
  }
  if (atMs >= clock.submissionCloseAtMs) {
    return { admitted: false, reason: "after_submission_close" };
  }
  return {
    admitted: true,
    class: atMs < clock.earlyAccessCutoffAtMs ? "early_access" : "late_unsellable",
  };
}
