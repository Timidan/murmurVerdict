import type { ButtonHTMLAttributes, ReactNode } from "react";
import { button } from "../ui/tokens.js";

type Variant = "primary" | "secondary" | "destructive";

interface PillButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  children: ReactNode;
}

/**
 * Pill 999px button — Nothing canonical. Space Mono ALL CAPS, min-height
 * 44px (touch-target compliant), tactile translateY(1px) on :active.
 *
 * - primary:     white bg / black text — the CTA. One per screen.
 * - secondary:   transparent + hairline border.
 * - destructive: accent border + accent text — used for unfollow / dispute.
 */
export function PillButton({
  variant = "secondary",
  className = "",
  children,
  ...rest
}: PillButtonProps) {
  return (
    <button {...rest} className={`${button[variant]} ${className}`.trim()}>
      {children}
    </button>
  );
}
