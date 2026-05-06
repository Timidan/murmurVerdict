// ──────────────────────────────────────────────────────────────────────────────
// Murmur Verdict — Nothing-canonical className tokens
// Source: nothing-design skill (~/.claude/skills/nothing-design/references/)
// Spec: docs/launchpad/V14_HANDOFF.md
//
// Discipline: 3 fonts (Doto / Space Grotesk / Space Mono), 1 accent (#D71921),
// pill 999px buttons, ALL CAPS labels via Space Mono, ease-out only motion,
// pure #000 OLED canvas (intentional override per Nothing brand).
// ──────────────────────────────────────────────────────────────────────────────

/* ── Surfaces ─────────────────────────────────────────────────────────────── */

export const surface = {
  /** Page canvas — pure OLED black. */
  page: "bg-[var(--color-bg)] text-[var(--color-primary)] font-sans antialiased",

  /** Sidebar / sub-nav — surface ladder step 1. */
  sidebar: "bg-[var(--color-surface)] border-r border-[var(--color-border)]",

  /** Lifted row / elevated panel — used for active sidebar item, hover. */
  raised: "bg-[var(--color-raised)]",

  /** Hairline rule between sections. The default separator — reach for this
   *  before adding a card or a divider line. */
  hairline: "border-t border-[var(--color-border)]",
  hairlineRight: "border-r border-[var(--color-border)]",
  hairlineBottom: "border-b border-[var(--color-border)]",
} as const;

/* ── Typography (mirrors Nothing tier names) ─────────────────────────────── */

export const text = {
  /** Doto hero — the score readout protagonist. */
  display: "t-display",
  /** Doto subordinate — secondary numerical display (e.g., LiveCounter). */
  displayMd: "t-display-md",

  heading: "t-heading",
  subheading: "t-subheading",

  /** Space Mono stat number — for stat-cell readouts. */
  statNum: "t-stat-num",

  body: "t-body",
  bodySm: "t-body-sm",

  /** Tabular Space Mono — timestamps, side, horizon, conf. */
  data: "t-data",

  /** ALL CAPS Space Mono — stat labels, sidebar sections, chips. */
  label: "t-label",

  /** Sentence-case Space Mono — top bar, crumb, footer hints. */
  meta: "t-meta",

  button: "t-button",
} as const;

/* ── Buttons (pill 999px, Nothing canonical) ─────────────────────────────── */

const buttonBase =
  "t-button inline-flex items-center justify-center gap-2 " +
  "rounded-full px-6 py-3 min-h-[44px] " +
  "transition-colors duration-150 ease-out press-feedback " +
  "cursor-pointer";

export const button = {
  /** Primary — white background, black text. The CTA. */
  primary:
    buttonBase +
    " bg-[var(--color-display)] text-[var(--color-bg)] border border-[var(--color-display)] " +
    "hover:bg-[var(--color-primary)] hover:border-[var(--color-primary)]",

  /** Secondary — transparent, hairline border. */
  secondary:
    buttonBase +
    " bg-transparent text-[var(--color-primary)] border border-[var(--color-border-vis)] " +
    "hover:border-[var(--color-display)] hover:text-[var(--color-display)]",

  /** Destructive — accent border + accent text, used for unfollow / dispute. */
  destructive:
    buttonBase +
    " bg-transparent text-[var(--color-accent)] border border-[var(--color-accent)] " +
    "hover:bg-[var(--color-accent-tint)]",
} as const;

/* ── Chips / pills (outcome, status, rank badge) ─────────────────────────── */

const chipBase =
  "t-label inline-flex items-center gap-1.5 rounded-full " +
  "px-3 py-1 border";

export const chip = {
  /** Default neutral — unset state. */
  neutral:
    chipBase +
    " bg-transparent border-[var(--color-border-vis)] text-[var(--color-secondary)]",

  /** Win / good — white-on-white border (Nothing's monochrome-first rule). */
  win:
    chipBase +
    " bg-transparent border-[var(--color-display)] text-[var(--color-display)]",

  /** Loss / bad — accent. */
  loss:
    chipBase +
    " bg-transparent border-[var(--color-accent)] text-[var(--color-accent)]",

  /** Live / pending — accent + breathing pulse on motion-OK clients. */
  live:
    chipBase +
    " bg-transparent border-[var(--color-accent)] text-[var(--color-accent)] nothing-live",

  /** Void — disabled grey. */
  void:
    chipBase +
    " bg-transparent border-[var(--color-disabled)] text-[var(--color-disabled)]",

  /** Rank badge — accent pill, used inline next to agent name. */
  rank:
    chipBase +
    " bg-transparent border-[var(--color-accent)] text-[var(--color-accent)]",
} as const;

/* ── Outcome routing helper ──────────────────────────────────────────────── */

export type Outcome =
  | "win"
  | "loss"
  | "void"
  | "oracle_unavailable"
  | "live"
  | string
  | null
  | undefined;

export function outcomeChip(o: Outcome): keyof typeof chip {
  if (o === "win") return "win";
  if (o === "loss") return "loss";
  if (o === "live" || o === null || o === undefined) return "live";
  if (o === "void" || o === "oracle_unavailable") return "void";
  return "neutral";
}

/* ── Layout containers ───────────────────────────────────────────────────── */

export const layout = {
  /** Two-pane Devin shell: 240px sidebar + 1fr main. */
  shellGrid: "grid grid-cols-[240px_1fr] grid-rows-[38px_1fr] min-h-dvh",

  /** Top bar — 38px, hairline bottom. */
  topbar:
    "col-span-2 h-[38px] border-b border-[var(--color-border)] " +
    "flex items-center justify-between px-4 " +
    "bg-[var(--color-bg)]",

  /** Main pane content padding. */
  mainPad: "px-6 py-5",
  mainPadXL: "px-8 py-8",
} as const;

/* ── Side semantic colors (BUY/SELL inline glyphs) ───────────────────────── */

export const side = {
  /** BUY — neutral white. Up-side has no special color in Nothing. */
  buy: "text-[var(--color-display)]",
  /** SELL — accent red, marks the call as one-way. */
  sell: "text-[var(--color-accent)]",
} as const;
