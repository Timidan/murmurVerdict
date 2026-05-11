// ─── TierBadge — one-line agent-tier chip (Phase 7c) ───────────────────────
//
// Compact terminal-style chip used on:
//   · AccountPage agent rows (replaces the bare ck-label `[ CASUAL ]`)
//   · AgentSettingsPage header
//
// Visual ladder (DESIGN.md + tokens):
//   casual         → ck-dim       (lowest tier, unconfirmed)
//   wallet_only    → ck-pos       (white display tone — wallet proof)
//   attested       → ck-neg       (accent red — Olas bond, sentinel tier)
//   verified       → ck-pos bold  (white display — verified identity)
//   benchmark      → ck-dim mono  (legacy bench bots)
//   shadow         → ck-dim ital  (legacy; deprecated, scheduled for removal)
//   internal_test  → ck-dim       (operator-only)
//
// Uses ALL CAPS Space Mono via .ck-label + the existing color tokens. The
// chip itself is a hairline-bordered pill — same visual class as elsewhere
// in COMPACT — so it doesn't break the Nothing density rhythm.

import type { AgentKind } from "../api.js";

export interface TierBadgeProps {
  /** Defaults to `casual` when null — the most defensive guess for the
   *  Phase 7a/7b onboarding flow where `kind` may be null mid-bootstrap. */
  kind: AgentKind | string | null | undefined;
}

interface TierStyle {
  label: string;
  /** Composition of ck-* class tokens. Never hardcoded colors. */
  cls: string;
}

// Keep this in sync with src/verdict/schema.ts:AgentKindSchema. New kinds
// fall through to the `unknown` style — defensive vs. backend additions.
const TIER_STYLES: Record<string, TierStyle> = {
  casual: { label: "CASUAL", cls: "ck-dim" },
  wallet_only: { label: "WALLET", cls: "ck-pos" },
  attested: { label: "ATTESTED", cls: "ck-neg" },
  verified: { label: "VERIFIED", cls: "ck-pos" },
  benchmark: { label: "BENCHMARK", cls: "ck-dim" },
  shadow: { label: "SHADOW", cls: "ck-dim italic" },
  internal_test: { label: "INTERNAL", cls: "ck-dim" },
};

export function TierBadge({ kind }: TierBadgeProps) {
  const k = (kind ?? "casual").toString();
  const style = TIER_STYLES[k] ?? { label: k.toUpperCase(), cls: "ck-dim" };
  return (
    <span
      className={
        "ck-label inline-flex items-center px-[6px] py-[1px] border " +
        "border-[var(--color-border-vis)] " +
        style.cls
      }
    >
      [ {style.label} ]
    </span>
  );
}
