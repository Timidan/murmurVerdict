// ──────────────────────────────────────────────────────────────────────────────
// Murmur Verdict — className tokens
// Adopted from Linear's DESIGN.md (see docs/launchpad/design-references/).
// Two intentional substitutions: emerald accent (vs Linear lavender), Geist
// family (vs Linear Display/Text/Mono). Everything else is verbatim Linear:
// surface ladder, hairlines, four ink levels, 12px card radius, 56px nav.
// ──────────────────────────────────────────────────────────────────────────────

/* ── Surfaces ─────────────────────────────────────────────────────────────── */

export const surface = {
  /** Page canvas — the deepest dark surface. */
  page: "bg-[var(--color-canvas)] text-[var(--color-ink)] font-sans antialiased",

  /** Default lifted card — Linear `feature-card` / `pricing-card`. */
  card:
    "bg-[var(--color-surface-1)] border border-[var(--color-hairline)] " +
    "rounded-[12px] lift-edge",

  /** Featured / hovered card — surface-2 lift. */
  cardFeatured:
    "bg-[var(--color-surface-2)] border border-[var(--color-hairline-strong)] " +
    "rounded-[12px] lift-edge",

  /** Product-screenshot panel — wider radius, surface-1. */
  panel:
    "bg-[var(--color-surface-1)] border border-[var(--color-hairline)] " +
    "rounded-[16px] lift-edge",

  /** Sub-nav / dropdown / tertiary — surface-3. */
  surface3:
    "bg-[var(--color-surface-3)] border border-[var(--color-hairline-tertiary)]",

  /** A logic-grouping divider; reach for this before adding another card. */
  hairline: "border-t border-[var(--color-hairline)]",
} as const;

/* ── Typography (mirrors Linear's tier names) ────────────────────────────── */

export const text = {
  displayXl: "t-display-xl text-[var(--color-ink)]",
  displayLg: "t-display-lg text-[var(--color-ink)]",
  displayMd: "t-display-md text-[var(--color-ink)]",
  headline: "t-headline text-[var(--color-ink)]",
  cardTitle: "t-card-title text-[var(--color-ink)]",
  subhead: "t-subhead text-[var(--color-ink-muted)]",
  bodyLg: "t-body-lg text-[var(--color-ink-muted)]",
  body: "t-body text-[var(--color-ink-muted)]",
  bodySm: "t-body-sm text-[var(--color-ink-muted)]",
  caption: "t-caption text-[var(--color-ink-subtle)]",
  button: "t-button",
  /** Eyebrow / kicker — uppercase, +0.4px tracking, ink-subtle. */
  eyebrow: "t-eyebrow text-[var(--color-ink-subtle)]",
  mono: "t-mono",
  /** Numeric helper — applies tabular Geist Mono. */
  num: "font-mono tabular-nums",
} as const;

/* ── Buttons ─────────────────────────────────────────────────────────────── */

const buttonBase =
  "t-button inline-flex items-center gap-2 rounded-[8px] " +
  "transition-colors duration-150 " +
  "focus-visible:outline-2 focus-visible:outline-[var(--color-primary-focus)] " +
  "focus-visible:outline-offset-2 active:translate-y-[0.5px]";

export const button = {
  /** Linear `button-primary` — emerald CTA, 8/14 padding. */
  primary:
    buttonBase +
    " bg-[var(--color-primary)] text-[var(--color-on-primary)] " +
    "hover:bg-[var(--color-primary-hover)] " +
    "px-[14px] py-[8px]",

  /** Linear `button-secondary` — surface-1 charcoal with hairline. */
  secondary:
    buttonBase +
    " bg-[var(--color-surface-1)] border border-[var(--color-hairline)] " +
    "text-[var(--color-ink)] hover:bg-[var(--color-surface-2)] " +
    "px-[14px] py-[8px]",

  /** Linear `button-tertiary` — flush against canvas. */
  tertiary:
    buttonBase +
    " bg-[var(--color-canvas)] text-[var(--color-ink)] " +
    "hover:bg-[var(--color-surface-1)] " +
    "px-[14px] py-[8px]",

  /** Inverse white CTA — used sparingly. */
  inverse:
    buttonBase +
    " bg-[var(--color-inverse-canvas)] text-[var(--color-inverse-ink)] " +
    "hover:bg-[var(--color-inverse-surface-1)] " +
    "px-[14px] py-[8px]",
} as const;

/* ── Status pills (Linear `status-badge` semantics, extended for outcomes) ── */

const pillBase =
  "t-caption inline-flex items-center gap-1.5 rounded-[9999px] " +
  "px-[8px] py-[2px] border";

export const pill = {
  /** Default neutral — surface-2 + ink-muted (Linear `status-badge` exact). */
  neutral:
    pillBase +
    " bg-[var(--color-surface-2)] border-[var(--color-hairline)] " +
    "text-[var(--color-ink-muted)]",

  /** Win / good — accent-tinted. */
  good:
    pillBase +
    " bg-[color-mix(in_oklch,var(--color-win)_12%,transparent)] " +
    "border-[color-mix(in_oklch,var(--color-win)_28%,transparent)] " +
    "text-[var(--color-win)]",

  /** Loss / bad — coral-rose tinted. */
  bad:
    pillBase +
    " bg-[color-mix(in_oklch,var(--color-loss)_12%,transparent)] " +
    "border-[color-mix(in_oklch,var(--color-loss)_28%,transparent)] " +
    "text-[var(--color-loss)]",

  /** Warn — oracle_unavailable, late delivery. */
  warn:
    pillBase +
    " bg-[color-mix(in_oklch,var(--color-warn)_12%,transparent)] " +
    "border-[color-mix(in_oklch,var(--color-warn)_28%,transparent)] " +
    "text-[var(--color-warn)]",

  /** Live / pending — tinted accent with breathing dot inside. */
  live:
    pillBase +
    " bg-[color-mix(in_oklch,var(--color-primary)_10%,transparent)] " +
    "border-[color-mix(in_oklch,var(--color-primary)_28%,transparent)] " +
    "text-[var(--color-primary)]",
} as const;

/* ── Outcome routing helper ──────────────────────────────────────────────── */

export type Outcome = "win" | "loss" | "void" | "oracle_unavailable" | string | null | undefined;

export function outcomeTone(o: Outcome): keyof typeof pill {
  if (o === "win") return "good";
  if (o === "loss") return "bad";
  if (o === "oracle_unavailable") return "warn";
  return "neutral";
}

/* ── Layout containers ───────────────────────────────────────────────────── */

export const layout = {
  /** Linear's max content width is ~1280px. */
  container: "mx-auto max-w-[1280px] px-6 md:px-8",
  /** Section rhythm — 96px between sections (Linear `spacing.section`). */
  section: "py-[96px]",
  /** Card interior — 24px padding (Linear `lg`). */
  cardPad: "p-[24px]",
  /** CTA banner padding — 48px (Linear `xxl`). */
  ctaPad: "p-[48px]",
} as const;

/* ── Side semantic colors (BUY/SELL inline glyphs) ───────────────────────── */

export const side = {
  buy: "text-[var(--color-win)]",
  sell: "text-[var(--color-loss)]",
} as const;
