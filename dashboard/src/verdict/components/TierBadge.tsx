// ─── TierBadge — one-line agent-tier chip (Phase 7c) ───────────────────────
//
// Compact terminal-style chip used on:
//   · AccountPage agent rows (replaces the bare ck-label `[ AGENT ]`)
//   · AgentSettingsPage header
//
// Visual ladder (Wave 3 — collapsed enum, see api.ts:AgentKind):
//   agent          → ck-pos       (canonical Privy-owned default, white tone)
//   attested       → ck-neg       (accent red — Olas bond, sentinel tier)
//   benchmark      → ck-dim mono  (system-curated comparison bots)
//   internal_test  → ck-dim       (operator-only)
//
// Anything else — including stale `casual`/`wallet_only`/`verified`/`shadow`
// literals lingering in local-dev DBs before the backend migration lands —
// falls through to the `unknown` style and renders the raw upper-cased label.
// We do NOT crash on unknown values; the DB migration handles the rename.
//
// Uses ALL CAPS Space Mono via .ck-label + the existing color tokens. The
// chip itself is a hairline-bordered pill — same visual class as elsewhere
// in COMPACT — so it doesn't break the Nothing density rhythm.

import type { AgentKind } from "../api.js";

export interface TierBadgeProps {
  /** Defaults to `agent` when null — the canonical Privy-owned default for
   *  the Phase 7a/7b onboarding flow where `kind` may be null mid-bootstrap. */
  kind: AgentKind | string | null | undefined;
}

interface TierStyle {
  label: string;
  /** Composition of ck-* class tokens. Never hardcoded colors. */
  cls: string;
}

// Keep this in sync with src/verdict/schema.ts:AgentKindSchema. New kinds
// fall through to the `unknown` style — defensive vs. backend additions
// and against stale pre-Wave-3 literals in local-dev DBs.
const TIER_STYLES: Record<string, TierStyle> = {
  agent: { label: "AGENT", cls: "ck-pos" },
  attested: { label: "ATTESTED", cls: "ck-neg" },
  benchmark: { label: "BENCHMARK", cls: "ck-dim" },
  internal_test: { label: "INTERNAL", cls: "ck-dim" },
};

export function TierBadge({ kind }: TierBadgeProps) {
  const k = (kind ?? "agent").toString();
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
