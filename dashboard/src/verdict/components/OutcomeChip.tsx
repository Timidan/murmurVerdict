import type { ReactNode } from "react";
import { chip, outcomeChip, type Outcome } from "../ui/tokens.js";

interface OutcomeChipProps {
  outcome: Outcome;
  /** Override label (e.g. "+0.182" instead of the default outcome name). */
  children?: ReactNode;
  /** Accessible label fallback when children isn't self-describing. */
  ariaLabel?: string;
}

const DEFAULT_LABEL: Record<string, string> = {
  win: "WIN",
  loss: "LOSS",
  void: "VOID",
  oracle_unavailable: "VOID",
  live: "PEND",
};

/**
 * Squared-pill outcome chip — Space Mono caption ALL CAPS, no fill,
 * border in the outcome's status color. Live state breathes.
 */
export function OutcomeChip({ outcome, children, ariaLabel }: OutcomeChipProps) {
  const tone = outcomeChip(outcome);
  const label =
    children ??
    DEFAULT_LABEL[outcome ?? "live"] ??
    DEFAULT_LABEL.live;
  return (
    <span className={chip[tone]} aria-label={ariaLabel}>
      {label}
    </span>
  );
}
