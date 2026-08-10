/* @jsxRuntime automatic */
/* @jsxImportSource react */
/*
 * ^ Per-file JSX pragmas for esbuild. Vite (@vitejs/plugin-react) and the
 * dashboard tsconfig ("jsx": "react-jsx") already use the automatic runtime —
 * no file in dashboard/src imports React by default. But `tsx` resolves the
 * REPO-ROOT tsconfig, which sets no "jsx", so esbuild would fall back to the
 * classic React.createElement transform and this module would throw
 * "React is not defined" under `npx tsx dashboard/src/verdict/icons.smoke.ts`
 * (which is exactly how tools/run-smokes.mjs runs it). The pragmas pin the
 * automatic runtime for every consumer; they are a no-op for Vite and tsc.
 */

/**
 * The murmur glyph set — inline, currentColor, 16-grid, square-cap grammar.
 * Geometry source of truth for drawing: .superpowers/icons-draft/ (owner-
 * approved 2026-08-06/07). This module is the shipped source. Icons are
 * decorative-by-contract: always aria-hidden, always beside visible text
 * (exception: the icon-only topbar nav, owner-carved 2026-08-07 — labels on
 * demand via aria-label + hover tip).
 */

// Type-only: erased before any runtime sees it, so the pragmas above still
// describe the whole module's React footprint (no value import of React).
import type { ReactNode } from "react";

const GLYPHS = {
  agent: (
    <>
      <rect x="3.5" y="5.5" width="9" height="7" />
      <path d="M8 5.5V2.5" />
      <rect x="5" y="8" width="2" height="2" fill="currentColor" stroke="none" />
      <rect x="9" y="8" width="2" height="2" fill="currentColor" stroke="none" />
    </>
  ),
  "controller-wallet": (
    <>
      <path d="M12.5 7.5V4.5H2.5V12.5H12.5V10.5" />
      <path d="M3.5 4.5V2.5H12.5" />
      <rect x="10.5" y="7.5" width="4" height="3" />
      <rect x="11" y="8" width="2" height="2" fill="currentColor" stroke="none" />
    </>
  ),
  attest: (
    <path d="M10.5 2.5L13.5 5.5L5.5 13.5H2.5V10.5Z" />
  ),
  "runtime-key": (
    <>
      <path d="M2.5 6.5L5.5 3.5L8.5 6.5L5.5 9.5Z M7.5 7.5L13.5 13.5 M10.5 10.5L12.5 8.5 M12.5 12.5L13.5 11.5" />
      <rect x="5" y="6" width="1" height="1" fill="currentColor" stroke="none" />
    </>
  ),
  seal: (
    <>
      <rect x="2.5" y="4.5" width="11" height="8" />
      <path d="M2.5 4.5L8 9.5L13.5 4.5" />
      <rect x="7" y="8" width="2" height="2" fill="currentColor" stroke="none" />
    </>
  ),
  "confirm-live": (
    <>
      <rect x="2.5" y="3.5" width="10" height="10" />
      <path d="M4.5 8.5L6.5 10.5L10.5 6.5" />
      <rect x="12" y="2" width="2" height="2" fill="currentColor" stroke="none" />
    </>
  ),
  market: (
    <>
      <path d="M2.5 12.5L6.5 8.5L9.5 10.5L13.5 4.5" />
      <path d="M10.5 4.5H13.5 M13.5 4.5V7.5" />
      <path d="M2.5 13.5H13.5" />
    </>
  ),
  verdict: (
    <path d="M2.5 2.5H11.5L13.5 4.5V13.5H2.5Z M11.5 2.5V4.5H13.5 M5.5 7.5L7.5 10.5L10.5 6.5" />
  ),
  resolve: (
    <path d="M2.5 3.5L7.5 8.5 M2.5 12.5L7.5 8.5 M7.5 8.5H13.5 M11.5 6.5L13.5 8.5L11.5 10.5" />
  ),
  dispute: (
    // head-to-head arrows (confrontation), NOT parallel lanes — ⇄ reads as
    // swap/exchange, wrong in a product that moves money (drawing-pass review)
    <>
      <path d="M1.5 8H5.5 M3.5 5.5L6 8L3.5 10.5" />
      <path d="M14.5 8H10.5 M12.5 5.5L10 8L12.5 10.5" />
    </>
  ),
  leaderboard: (
    <path d="M1.5 13.5V8.5H5.5 M5.5 13.5V2.5H9.5V13.5 M9.5 10.5H13.5V13.5 M1.5 13.5H13.5" />
  ),
  feed: (
    <>
      <path d="M4.5 3.5H13.5 M4.5 7.5H10.5 M4.5 11.5H12.5" />
      <rect x="2" y="3" width="1" height="1" fill="currentColor" stroke="none" />
      <rect x="2" y="7" width="1" height="1" fill="currentColor" stroke="none" />
      <rect x="2" y="11" width="1" height="1" fill="currentColor" stroke="none" />
    </>
  ),
  webhook: (
    <>
      <rect x="2.5" y="2.5" width="4" height="4" />
      <path d="M6.5 4.5H11.5V9.5" />
      <path d="M9.5 7.5L11.5 9.5L13.5 7.5" />
      {/* 7×2 socket bar: the delivery target — documented exception to the
          2×2 fill cap, same class as live-dot's core */}
      <rect x="8" y="12" width="7" height="2" fill="currentColor" stroke="none" />
    </>
  ),
  api: (
    <path d="M5.5 3.5L1.5 8.5L5.5 12.5 M10.5 3.5L14.5 8.5L10.5 12.5 M9.5 2.5L6.5 13.5" />
  ),
  "skill-file": (
    <>
      <rect x="2.5" y="3.5" width="11" height="9" />
      <path d="M2.5 5.5H13.5" />
      <path d="M4.5 7.5L6.5 9.5L4.5 11.5 M8.5 11.5H11.5" />
    </>
  ),
  x402: (
    <g fill="currentColor" stroke="none">
      <rect x="2" y="2" width="2" height="2" /><rect x="4" y="4" width="2" height="2" />
      <rect x="6" y="6" width="2" height="2" /><rect x="8" y="8" width="2" height="2" />
      <rect x="10" y="10" width="2" height="2" /><rect x="12" y="12" width="2" height="2" />
      <rect x="12" y="2" width="2" height="2" /><rect x="10" y="4" width="2" height="2" />
      <rect x="8" y="6" width="2" height="2" /><rect x="6" y="8" width="2" height="2" />
      <rect x="4" y="10" width="2" height="2" /><rect x="2" y="12" width="2" height="2" />
    </g>
  ),
  mcp: <path d="M2.5 10.5L8.5 4.5L10.5 6.5L5.5 11.5L7.5 13.5L13.5 7.5" />,
  badge: (
    // nav-aligned dog-eared card (one silhouette per concept across tiers);
    // differentiates from verdict's doc by its mark — solid seal, not a check
    <>
      <path d="M2.5 2.5H10.5L13.5 5.5V13.5H2.5Z M10.5 2.5V5.5H13.5" />
      <rect x="8" y="8" width="3" height="3" fill="currentColor" stroke="none" />
    </>
  ),
  "self-host": (
    <>
      <path d="M2.5 6.5L8 1.5L13.5 6.5" />
      <path d="M3.5 5.5V13.5H12.5V5.5" />
      <path d="M5.5 8.5H10.5 M5.5 11.5H10.5" />
      <rect x="5" y="8" width="1" height="1" fill="currentColor" stroke="none" />
    </>
  ),
  settings: (
    // vertical sliders — exits the horizontal rules+marks family entirely
    // (feed/reputation lookalike class, REDRAW-BRIEF rule 8)
    <path d="M5.5 2.5V13.5 M10.5 2.5V13.5 M3.5 5.5H7.5 M8.5 10.5H12.5" />
  ),
  revoke: (
    <>
      <rect x="3.5" y="3.5" width="9" height="9" />
      <path d="M2.5 13.5L13.5 2.5" />
    </>
  ),
  rotate: (
    <>
      <path d="M3.5 8.5V4.5H10.5 M8.5 2.5L10.5 4.5L8.5 6.5" />
      <path d="M12.5 7.5V11.5H5.5 M7.5 9.5L5.5 11.5L7.5 13.5" />
    </>
  ),
  "kill-switch": (
    <>
      <rect x="5.5" y="2.5" width="5" height="11" />
      {/* 2×4 rocker block: the ON-position payload — documented exception
          to the 2×2 fill cap, same class as live-dot's core */}
      <rect x="7" y="4" width="2" height="4" fill="currentColor" stroke="none" />
    </>
  ),
  "live-dot": (
    <>
      {/* Two paths, not one subpath pair: identical coordinates to the former
          combined `M… M…` d, split so the live-transmission animation can
          drive the inbound and outbound chevrons on their own keyframes
          (compact.css `.ck-live-tx`, matched by :first-of-type/:nth-of-type).
          Order is load-bearing — in first, out second. */}
      <path d="M4.5 4.5L2.5 8L4.5 11.5" />
      <path d="M11.5 4.5L13.5 8L11.5 11.5" />
      {/* 4×4 core: the semantic payload must survive at 16 — documented
          exception to the 2×2 fill cap (inline-critique refine row) */}
      <rect x="6" y="6" width="4" height="4" fill="currentColor" stroke="none" />
    </>
  ),
  copy: (
    <>
      <path d="M5.5 10.5H1.5V1.5H10.5V5.5" />
      <rect x="5.5" y="5.5" width="9" height="9" />
    </>
  ),
  link: (
    <>
      <path d="M8.5 3.5H3.5V8.5H5.5 M8.5 3.5V8.5" />
      <path d="M10.5 7.5H12.5V12.5H7.5V7.5" />
    </>
  ),
  "external-link": (
    <path d="M7.5 2.5H2.5V13.5H13.5V8.5 M8.5 2.5H13.5V7.5 M13.5 2.5L7.5 8.5" />
  ),
} as const;

export type IconName = keyof typeof GLYPHS;
export const ICON_NAMES = Object.keys(GLYPHS) as readonly IconName[];

/**
 * An inline glyph.
 *
 * SIZE CONTRACT: 16 or 32, and the type enforces it. The grid is 16 with
 * half-integer coordinates (x="3.5") and stroke 1, so only an integer scale
 * puts every edge on a device pixel. Measured over the whole set, 16 renders
 * 23.7% of its drawn pixels as partial-coverage grey; 12px renders 91.8% and
 * 13px 96.0%, and a sub-pixel stroke can never paint a solid pixel — a 12px
 * glyph comes out paler than the 13px label beside it. 24 is NOT a safe
 * middle (measured 57.9%, worse than 12): the earlier "near-perfect 1.5×
 * snap" note was wrong and is gone. When 16 is too big for the row — a 12px
 * tab, a 12px status chip, a 12px column header — the answer is no glyph, not
 * a smaller one; those rows already carry their own word. (The neighbours it
 * is measured against are the shipped ones: labels 13, colheads/tabs/chips 12
 * on the floor, titles 18 — the sizes this note used to cite, 10 and 11, no
 * longer exist anywhere in the cockpit.)
 *
 * The nav tier (`IkNav`) is the right tool at 24/48.
 *
 * Decorative by contract: always aria-hidden, always beside visible text, so
 * dropping one never changes an accessible name.
 */
export function Ik({
  name,
  size = 16,
  className,
}: {
  name: IconName;
  size?: 16 | 32;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1}
      strokeLinecap="square"
      strokeLinejoin="miter"
      aria-hidden="true"
      className={className}
      style={{ flex: "none" }}
    >
      {GLYPHS[name]}
    </svg>
  );
}

/* ------------------------------------------------------------------------- *
 * NAV tier — heavier weight, drawn for the topbar, not for inline text.
 * ------------------------------------------------------------------------- */

/**
 * Nav-weight glyphs: a 24-grid redraw of the six topbar destinations. The
 * outlines stroke at 1px on half-pixel offsets (owner's thickness ruling,
 * 2026-08-07 — supersedes the stroke-2/integer geometry still in the draft
 * files); the fills are whole-number silhouettes. Fill geometry source of
 * truth: .superpowers/icons-draft/nav/<name>-fill.svg, copied verbatim with
 * only paint attributes relocated (see IkNav). Outline geometry is the draft
 * outlines shifted +0.5 (rects inset to keep both edges on the half-grid).
 *
 * Two states per concept, per the nav convention: `outline` at rest, `fill`
 * when the route is current. The fill is not a filled-in outline — it is a
 * separate silhouette drawn to carry real mass, so the active destination
 * reads as weight rather than as a colour change alone; against the hairline
 * rest state that contrast is the whole signal.
 *
 * This tier still exists apart from the 16-grid inline set because nav glyphs
 * render at 24/48: a 16-grid drawing only reaches those sizes by fractional
 * scaling, which lands every edge between device pixels. Native 24-grid
 * geometry is what keeps the drawing hard. See IkNav for the size contract.
 */
const NAV_GLYPHS = {
  market: {
    outline: (
      <>
        <path d="M3.5 16.5L9.5 10.5L13.5 14.5L21.5 5.5" />
        <path d="M15.5 5.5H21.5V11.5" />
        <path d="M3.5 21.5H21.5" />
      </>
    ),
    fill: (
      <>
        <path fill="currentColor" d="M2 22V16L9 9L13 13L19 6L22 9V22Z" />
        <path fill="currentColor" d="M13 2H22V11L19 8L15 4Z" />
      </>
    ),
  },
  leaderboard: {
    outline: (
      <path d="M3.5 21.5V9.5H9.5V21.5 M9.5 9.5V4.5H15.5V21.5 M15.5 21.5V12.5H21.5V21.5 M3.5 21.5H21.5" />
    ),
    // Source root carries fill="currentColor"; hoisted one level onto <g> so
    // the bare rect geometry stays verbatim (same construction as `x402`).
    fill: (
      <g fill="currentColor">
        <rect x="2" y="8" width="6" height="14" />
        <rect x="9" y="3" width="6" height="19" />
        <rect x="16" y="11" width="6" height="11" />
      </g>
    ),
  },
  feed: {
    outline: (
      <>
        <rect x="3.5" y="3.5" width="17" height="3" />
        <rect x="3.5" y="10.5" width="11" height="3" />
        <rect x="3.5" y="17.5" width="14" height="3" />
      </>
    ),
    fill: (
      <g fill="currentColor">
        <rect x="2" y="2" width="20" height="6" />
        <rect x="2" y="9" width="14" height="6" />
        <rect x="2" y="16" width="17" height="6" />
      </g>
    ),
  },
  "confirm-live": {
    outline: (
      <>
        <path d="M18.5 12.5V20.5H3.5V5.5H14.5" />
        <path d="M6.5 12.5L10.5 16.5L19.5 5.5" />
        <rect x="18" y="2" width="4" height="4" fill="currentColor" stroke="none" />
      </>
    ),
    fill: (
      <>
        <path
          fill="currentColor"
          fillRule="evenodd"
          d="M2 4H19V21H2Z M4 12L6 10L10 14L16 6L18 8L10 18Z"
        />
        <rect x="18" y="1" width="5" height="5" fill="currentColor" />
      </>
    ),
  },
  badge: {
    outline: (
      <>
        <path d="M4.5 3.5H16.5L20.5 7.5V21.5H4.5Z" />
        <path d="M16.5 3.5V7.5H20.5" />
        <path d="M8.5 12.5H16.5 M8.5 16.5H12.5" />
        <rect x="14" y="15" width="4" height="4" fill="currentColor" stroke="none" />
      </>
    ),
    fill: (
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M3 2H16L21 7V22H3ZM7 11H17V13H7ZM7 15H11V17H7ZM14 15H19V20H14Z"
      />
    ),
  },
  agent: {
    outline: (
      <>
        <rect x="4.5" y="8.5" width="15" height="11" />
        <path d="M12.5 8.5V5.5" />
        <rect x="10" y="2" width="4" height="3" fill="currentColor" stroke="none" />
        <rect x="8" y="12" width="3" height="4" fill="currentColor" stroke="none" />
        <rect x="13" y="12" width="3" height="4" fill="currentColor" stroke="none" />
      </>
    ),
    fill: (
      <>
        <path
          fill="currentColor"
          fillRule="evenodd"
          d="M3 7H21V21H3ZM8 12V16H11V12ZM13 12V16H16V12Z"
        />
        <path fill="currentColor" d="M11 7V5H10V2H14V5H13V7Z" />
      </>
    ),
  },
} as const satisfies Record<string, { outline: ReactNode; fill: ReactNode }>;

export type NavIconName = keyof typeof NAV_GLYPHS;
export const NAV_ICON_NAMES = Object.keys(NAV_GLYPHS) as readonly NavIconName[];

/**
 * A topbar destination glyph. Native grid is 24. The rest outline strokes at
 * 1px on half-pixel offsets, so each hairline's ink band spans exactly one
 * device pixel at 24px; the active fill sits on whole numbers, so its edges
 * land exactly on device pixels. Both states are hard without asking the
 * renderer for `crispEdges`.
 *
 * SIZE CONTRACT: render at 24, or at an integer multiple of it (48 for a 2×
 * surface). A fractional scale — 20, 28, 1.3× — puts every edge back between
 * pixels and reintroduces exactly the blur this tier was drawn to kill; the
 * inline `Ik` tier is the right tool at those sizes.
 *
 * `active` picks the state: outline at rest, fill for the current route. The
 * root supplies the stroke for the outline state and withdraws it for the
 * fill state, so the fill silhouettes paint from their own `fill="currentColor"`
 * and never grow an outline. Decorative by contract, like `Ik`: always
 * aria-hidden, the destination name lives on the link's aria-label.
 */
export function IkNav({
  name,
  active = false,
  size = 24,
  className,
}: {
  name: NavIconName;
  active?: boolean;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke={active ? "none" : "currentColor"}
      strokeWidth={active ? undefined : 1}
      strokeLinecap="square"
      strokeLinejoin="miter"
      aria-hidden="true"
      className={className}
      style={{ flex: "none" }}
    >
      {active ? NAV_GLYPHS[name].fill : NAV_GLYPHS[name].outline}
    </svg>
  );
}
