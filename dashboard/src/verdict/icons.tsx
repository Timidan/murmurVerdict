/* @jsxRuntime automatic */
/* @jsxImportSource react */
/* ^ Required: the smoke runs under `tsx`, which resolves the repo-root tsconfig
   (no "jsx" set) and would emit React.createElement into a file that never
   imports React. No-op for Vite and tsc. */

/**
 * The murmur glyph set — inline, currentColor. Hand-drawn glyphs use a
 * square-cap grammar on a 16 grid; the ones listed in STREAMLINE_ICON_NAMES
 * are Streamline "Sharp Line" geometry (CC BY 4.0, attribution in
 * THIRD_PARTY_NOTICES.md). One silhouette per concept.
 *
 * Decorative by contract: always aria-hidden, always beside visible text.
 * The icon-only topbar nav is the one exception — it labels via aria-label
 * and a hover tip.
 *
 * Do not reshape `live-dot`: compact.css targets its two chevron <path>s and
 * core <rect> positionally (:first-of-type/:nth-of-type) to drive the
 * transmission pulse, the app's only ambient animation.
 */

// Type-only, so the module still has no value import of React.
import type { ReactNode } from "react";

const GLYPHS = {
  /* ── Agent-settings rail ────────────────────────────────────────────────
     Purpose-drawn so the rail reads by shape alone. Namespaced `tab-` because
     every semantically-obvious mark (agent, seal, controller-wallet) is already
     spoken for elsewhere, and the unused pool is outcome glyphs that mean call
     results, not settings. Streamline Sharp: square caps, miter joins. */
  "tab-payout": (
    // Money out to your address. 16-grid, half-grid coords: hand-drawn tier.
    <>
      <path d="M8 1.5V9.5" />
      <path d="M5 6.5L8 9.5L11 6.5" />
      <path d="M1.5 11.5V14.5H14.5V11.5" />
    </>
  ),
  "tab-pricing": (
    <>
      <path d="M8.5 1.5H14.5V7.5L7.5 14.5L1.5 8.5L8.5 1.5Z" />
      <circle cx="11.5" cy="4.5" r="1" />
    </>
  ),
  "tab-earnings": (
    <>
      <path d="M1.5 13.5H14.5" />
      <path d="M2.5 10.5L6.5 6.5L8.5 8.5L13.5 3.5" />
      <path d="M10.5 3.5H13.5V6.5" />
    </>
  ),
  "tab-reveals": (
    // Angular eye — the Sharp grammar has no soft lens curve.
    <>
      <path d="M1.5 8L4.5 4.5H11.5L14.5 8L11.5 11.5H4.5L1.5 8Z" />
      <circle cx="8" cy="8" r="2" />
    </>
  ),
  "tab-wallet": (
    <>
      <path d="M1.5 4.5H14.5V13.5H1.5V4.5Z" />
      <path d="M1.5 4.5L10.5 2.5V4.5" />
      <path d="M14.5 7.5H11.5V10.5H14.5" />
    </>
  ),
  "tab-runtime": (
    // Terminal: the running program the key authorizes.
    <>
      <path d="M1.5 2.5H14.5V13.5H1.5V2.5Z" />
      <path d="M1.5 5.5H14.5" />
      <path d="M4 8L6 10L4 12" />
      <path d="M7.5 12H11.5" />
    </>
  ),
  "tab-apikeys": (
    <>
      <circle cx="5" cy="8" r="2.5" />
      <path d="M7.5 8H14.5" />
      <path d="M12 8V10.5" />
      <path d="M14 8V10" />
    </>
  ),
  "tab-profile": (
    <>
      <path d="M1.5 3.5H14.5V12.5H1.5V3.5Z" />
      <circle cx="5.5" cy="7" r="1.5" />
      <path d="M3 11.5C3 9.5 4 8.5 5.5 8.5C7 8.5 8 9.5 8 11.5" />
      <path d="M10.5 6.5H13" />
      <path d="M10.5 9.5H12.5" />
    </>
  ),
  agent: (
    <>
      <path d="M2 7h20v15H2V7Z" />
      <path d="M2 16.5h3.5l2 2h9l2 -2H22" />
      <path d="M12 7V1" />
      <path d="M8 11v2.5" />
      <path d="M16 11v2.5" />
    </>
  ),
  "controller-wallet": (
    <>
      <path d="M22 22H2v-3C2 13.4772 6.47715 9 12 9c5.5228 0 10 4.4772 10 10v3Z" />
      <path d="M2.36865 9c2.60573 -2.18461 5.96487 -3.5 9.63125 -3.5 3.6664 0 7.0255 1.31539 9.6312 3.5" />
      <path d="M9 1.5v1c0 1.65685 1.3431 3 3 3s3 -1.34315 3 -3v-1" />
    </>
  ),
  attest: (
    <>
      <path d="m14 19 9 0" />
      <path d="M4 8V5.5C4 3.567 5.567 2 7.5 2S11 3.567 11 5.5v12c0 2.4853 -2.01472 4.5 -4.5 4.5H6c-2.20914 0 -4 -1.7909 -4 -4 0 -3.785 4.77544 -5.9782 8.6779 -7.0817 2.7521 -0.7782 5.2259 1.1005 5.7868 3.905L16.5 15h1l0.4348 -0.8695C18.894 12.2119 20.855 11 23 11" />
    </>
  ),
  "runtime-key": (
    <>
      <path d="M6 12h5v5l-3.5 3.5 -5 -5L6 12Z" />
      <path d="m11 12 8 -8 3.5 3.5" />
      <path d="m16 7 3.5 3.5" />
      <path d="m12.8301 5.5459 -0.7071 -0.70711c-2.73371 -2.73367 -7.16587 -2.73367 -9.89954 0l-0.7071 0.70711" />
      <path d="m10.7088 7.66699 -0.5657 -0.56568c-1.64022 -1.64021 -4.29952 -1.6402 -5.93972 0l-0.56568 0.56568" />
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
    <>
      <path d="m2 8 20 -6" />
      <path d="M10 17H2v1.5s1.5 2 4 2 4 -2 4 -2V17Z" />
      <path d="M12 5V1.5" />
      <path d="M22 13h-8v1.5s1.5 2 4 2 4 -2 4 -2V13Z" />
      <path d="M2 17v-0.656L6 7" />
      <path d="m6 7 4 9.344V17" />
      <path d="M14 13v-0.656L18 3" />
      <path d="m18 3 4 9.344V13" />
    </>
  ),
  resolve: (
    <>
      <path d="M1 12h11" />
      <path d="M23 3h-7c-2.2091 0 -4 1.79086 -4 4v10c0 2.2091 1.7909 4 4 4h7" />
    </>
  ),
  dispute: (
    // Head-to-head, not parallel lanes: ⇄ reads as swap in a product that moves money.
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
    <>
      <path d="M22 3H2v18h20V3Z" />
      <path d="M22 7H2" />
      <path d="m15.5 11 3 3 -3 3" />
      <path d="m8.5 11 -3 3 3 3" />
      <path d="m13.5 10 -3 8" />
    </>
  ),
  "skill-file": (
    <>
      <path d="M5.5 7H15" />
      <path d="M5.5 11H12" />
      <path d="M16 21a4 4 0 1 0 0 -8 4 4 0 0 0 0 8Z" />
      <path d="m21.5 22.5 -2.671 -2.672" />
      <path d="M20 11.643V2H2v20h8.875" />
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
    <>
      <path d="M19.153 9.153a7.153 7.153 0 1 1 -14.306 0 7.153 7.153 0 0 1 14.306 0Z" />
      <path d="m11.952 5.437 1.267 2.171 2.17 0.543 -1.447 1.628 0.362 2.533 -2.352 -1.085L9.6 12.311l0.362 -2.533L8.515 8.15l2.17 -0.543 1.267 -2.171Z" />
      <path d="m5.9 12.89 -3.23 5.594 3.716 -0.985 1.005 3.71 2.944 -5.098" />
      <path d="m18.1 12.89 3.23 5.594 -3.716 -0.984 -1.005 3.71 -2.944 -5.1" />
    </>
  ),
  "self-host": (
    <>
      <path d="m22 2 0 8 -20 0 0 -8z" />
      <path d="m2 10 0 8 20 0 0 -8z" />
      <path d="M11.9995 18v4" />
      <path d="M16 22H8" />
      <path d="M5.99951 6h2.50031" />
      <path d="M5.99951 14h2.50031" />
      <path d="M11 6h6.9999" />
      <path d="M11 14h6.9994" />
    </>
  ),
  settings: (
    <>
      <path d="m12 1 0 6.5" />
      <path d="m12 16.5 0 6.5" />
      <path d="M10 12a2 2 0 1 0 4 0 2 2 0 1 0 -4 0" />
      <path d="M20 8.5 20 23" />
      <path d="M18 4a2 2 0 1 0 4 0 2 2 0 1 0 -4 0" />
      <path d="m4 1 0 14.5" />
      <path d="M2 20a2 2 0 1 0 4 0 2 2 0 1 0 -4 0" />
    </>
  ),
  revoke: (
    <>
      <path d="M3 6.53562 3 19.1998h12.5889m3.6111 0H21v-14.4H4.8" />
      <path d="M20.9999 8.40039h-12.6" />
      <path d="M3 12h5.43083M21 12h-9" />
      <path d="M16.0225 16h2.9774" />
      <path d="m1 1 22 22" />
    </>
  ),
  rotate: (
    <>
      <path d="M19.5 1.5v4h-4" />
      <path d="M19.5 5.38544C17.6676 3.30939 14.9867 2 12 2 6.47715 2 2 6.47715 2 12c0 3.8338 2.15744 7.1637 5.32448 8.8419" />
      <path d="M9.35645 21.6469c0.84205 0.2302 1.72845 0.3531 2.64345 0.3531 1.3009 0 2.5437 -0.2484 3.6837 -0.7003" />
      <path d="M17.2703 20.5c1.3747 -0.8542 2.527 -2.0327 3.3499 -3.4285" />
      <path d="M21.9999 12c0 1.1773 -0.2034 2.307 -0.577 3.356" />
    </>
  ),
  "kill-switch": (
    <>
      <path d="M2 12a10 10 0 1 0 20 0 10 10 0 1 0 -20 0" />
      <path d="M14.6278 7.729c1.4319 0.88284 2.3864 2.4656 2.3864 4.2712 0 2.7693 -2.245 5.0142 -5.0142 5.0142 -2.76924 0 -5.01416 -2.2449 -5.01416 -5.0142 0 -1.8056 0.95443 -3.38836 2.38631 -4.2712" />
      <path d="M12 5.05371v3.99317" />
    </>
  ),
  "live-dot": (
    <>
      {/* Two paths, not one subpath pair: identical coordinates to the former
          combined `M… M…` d, split so the live-transmission animation can
          drive the inbound and outbound chevrons on their own keyframes
          (compact.css `.ck-live-tx`, matched by :first-of-type/:nth-of-type).
          Order is load-bearing — in first, out second. This is why live-dot
          stayed hand-drawn in the 2026-08-10 Streamline pass even though a
          close match (rss-symbol) exists: swapping the geometry would
          silently detune or break the app's one ambient animation. */}
      <path d="M4.5 4.5L2.5 8L4.5 11.5" />
      <path d="M11.5 4.5L13.5 8L11.5 11.5" />
      {/* 4×4 core: the semantic payload must survive at 16 — documented
          exception to the 2×2 fill cap */}
      <rect x="6" y="6" width="4" height="4" fill="currentColor" stroke="none" />
    </>
  ),
  // Agent scoring vocabulary — the agent page's summary grid shows these
  // unlabelled, so each has to read unmistakably at 16.
  "outcome-win": (
    // The tick `confirm-live` carries, un-boxed — a win is not a confirmation.
    <path d="M3.5 8.5L6.5 11.5L12.5 4.5" />
  ),
  "outcome-loss": (
    // Scored loss. `outcome-failed` below is the un-scored case.
    <>
      <path d="M4.5 4.5L11.5 11.5" />
      <path d="M11.5 4.5L4.5 11.5" />
    </>
  ),
  "outcome-void": (
    // The set's one curve: a hollow square would collide with `seal`/`copy`.
    <path d="M4.5 8a3.5 3.5 0 1 0 7 0 3.5 3.5 0 1 0 -7 0" />
  ),
  "outcome-failed": (
    // Never admitted (rejected, or the reveal was missed) — not `outcome-void`.
    <>
      <path d="M4.5 8a3.5 3.5 0 1 0 7 0 3.5 3.5 0 1 0 -7 0" />
      <path d="M5.5 5.5L10.5 10.5" />
    </>
  ),
  "outcome-other": (
    // Everything carrying no verdict of its own: sent, checked, under dispute.
    <>
      <rect x="2" y="7" width="2" height="2" fill="currentColor" stroke="none" />
      <rect x="7" y="7" width="2" height="2" fill="currentColor" stroke="none" />
      <rect x="12" y="7" width="2" height="2" fill="currentColor" stroke="none" />
    </>
  ),
  "avg-score": (
    // The bounds are load-bearing: without them the mark reads as a plus sign.
    <>
      <path d="M2.5 8.5H13.5" />
      <path d="M2.5 6.5V10.5" />
      <path d="M13.5 6.5V10.5" />
      <path d="M8.5 3.5V13.5" />
    </>
  ),
  "win-rate": (
    // Square counters, not rings — a 3px ring at 1px stroke is a blob at 16px.
    <>
      <rect x="2.5" y="2.5" width="4" height="4" />
      <path d="M13.5 2.5L2.5 13.5" />
      <rect x="9.5" y="9.5" width="4" height="4" />
    </>
  ),
  "win-streak": (
    // Same chevron as `live-dot`, but all-forward and hollow to stay distinct.
    <>
      <path d="M2.5 4.5L5.5 8L2.5 11.5" />
      <path d="M6.5 4.5L9.5 8L6.5 11.5" />
      <path d="M10.5 4.5L13.5 8L10.5 11.5" />
    </>
  ),
  "all-calls": (
    // The denominator: every call the agent has made. Not `feed`, not `leaderboard`.
    <>
      <path d="M2.5 4.5V11.5" />
      <path d="M6.5 4.5V11.5" />
      <path d="M10.5 4.5V11.5" />
      <path d="M14.5 4.5V11.5" />
      {/* The closing stroke leaves from under the first upright and lands over
          the last, the way the fifth mark is actually drawn. 4-unit spacing,
          not 3: at 3 the uprights fused into hatching at 16px. */}
      <path d="M2.5 12.5L14.5 3.5" />
    </>
  ),
  chain: (
    // Blocks, not loops — `link` already owns the chain-link silhouette.
    <>
      <rect x="1.5" y="6.5" width="4" height="4" />
      <path d="M5.5 8.5H10.5" />
      <rect x="10.5" y="6.5" width="4" height="4" />
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
      <path d="m16 8 -8 8" />
      <path d="M10.5 7.5 16 2l6 6 -5.5 5.5" />
      <path d="M13.5 16.5 8 22l-6 -6 5.5 -5.5" />
    </>
  ),
  "external-link": (
    <>
      <path d="M12 5H2v17h17V12" />
      <path d="M10 14 22 2" />
      <path d="M14 2h8v8" />
    </>
  ),
} as const;

export type IconName = keyof typeof GLYPHS;
export const ICON_NAMES = Object.keys(GLYPHS) as readonly IconName[];

/**
 * Streamline-sourced geometry (CC BY 4.0). These sit on a 24 grid at 1.5px
 * stroke, the same relative weight as the hand-drawn set's 16/1px, so both
 * origins read as one family. They are vector exports, so the pixel-snap
 * argument on `Ik` does not apply to them.
 */
export const STREAMLINE_ICON_NAMES: readonly IconName[] = [
  "agent",
  "controller-wallet",
  "attest",
  "runtime-key",
  "verdict",
  "resolve",
  "api",
  "skill-file",
  "badge",
  "self-host",
  "settings",
  "revoke",
  "rotate",
  "kill-switch",
  "link",
  "external-link",
];

/**
 * An inline glyph.
 *
 * SIZE CONTRACT: 16 or 32, enforced by the type. Hand-drawn glyphs sit on a
 * 16 grid at half-integer coordinates, so only an integer scale lands every
 * edge on a device pixel — 24 is worse than 12, not a safe middle. When 16 is
 * too big for the row, the answer is no glyph, not a smaller one. `IkNav` is
 * the right tool at 24/48.
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
  const sourced = (STREAMLINE_ICON_NAMES as readonly string[]).includes(name);
  return (
    <svg
      viewBox={sourced ? "0 0 24 24" : "0 0 16 16"}
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={sourced ? 1.5 : 1}
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

/**
 * Nav tier — the six topbar destinations, redrawn on a 24 grid because the
 * inline set only reaches 24/48 by fractional scaling.
 *
 * Two states per concept: `outline` at rest, `fill` when the route is
 * current. The fill is a separate silhouette carrying real mass, not a
 * filled-in outline — against the hairline rest state, that weight is the
 * whole active signal. Streamline geometry is rendered at this tier's 1px
 * stroke, not Streamline's native 1.5, so all six hold one weight in the row.
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
    // fill hoisted onto <g> so the rect geometry stays verbatim (as in `x402`).
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
    // Streamline "star-badge" — same silhouette as the inline `badge`.
    outline: (
      <>
        <path d="M19.153 9.153a7.153 7.153 0 1 1 -14.306 0 7.153 7.153 0 0 1 14.306 0Z" />
        <path d="m11.952 5.437 1.267 2.171 2.17 0.543 -1.447 1.628 0.362 2.533 -2.352 -1.085L9.6 12.311l0.362 -2.533L8.515 8.15l2.17 -0.543 1.267 -2.171Z" />
        <path d="m5.9 12.89 -3.23 5.594 3.716 -0.985 1.005 3.71 2.944 -5.098" />
        <path d="m18.1 12.89 3.23 5.594 -3.716 -0.984 -1.005 3.71 -2.944 -5.1" />
      </>
    ),
    fill: (
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M19.313 8.39a7.312 7.312 0 1 1 -14.625 0 7.312 7.312 0 0 1 14.625 0ZM11.95 4.593l1.295 2.22 2.22 0.554 -1.48 1.665 0.37 2.59 -2.405 -1.11 -2.404 1.11 0.37 -2.59 -1.48 -1.665 2.22 -0.555 1.294 -2.22ZM1.12 19.672l3.624 -6.278a8.813 8.813 0 0 0 5.888 3.704l-3.493 6.049 -1.282 -4.731L1.12 19.67Zm15.74 3.475 -3.492 -6.05a8.812 8.812 0 0 0 5.888 -3.703l3.624 6.277 -4.738 -1.255 -1.281 4.73Z"
      />
    ),
  },
  agent: {
    // Streamline "cyborg" — same silhouette as the inline `agent`.
    outline: (
      <>
        <path d="M2 7h20v15H2V7Z" />
        <path d="M2 16.5h3.5l2 2h9l2 -2H22" />
        <path d="M12 7V1" />
        <path d="M8 11v2.5" />
        <path d="M16 11v2.5" />
      </>
    ),
    fill: (
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M13 1v5h10v10h-4.9142l-0.2929 0.2929L16.0858 18H7.91421l-1.7071 -1.7071L5.91421 16H1V6h10V1h2ZM1 18v5h22v-5h-4.0858l-1.7071 1.7071 -0.2929 0.2929H7.08579l-0.2929 -0.2929L5.08579 18H1Zm5.5 -5v-3h2v3h-2Zm9 -3v3h2v-3h-2Z"
      />
    ),
  },
} as const satisfies Record<string, { outline: ReactNode; fill: ReactNode }>;

export type NavIconName = keyof typeof NAV_GLYPHS;
export const NAV_ICON_NAMES = Object.keys(NAV_GLYPHS) as readonly NavIconName[];

/** The two nav destinations sourced from Streamline (see STREAMLINE_ICON_NAMES). */
export const NAV_STREAMLINE_ICON_NAMES: readonly NavIconName[] = ["agent", "badge"];

/**
 * A topbar destination glyph. Both states are hard without `crispEdges`: the
 * outline strokes at 1px on half-pixel offsets, the fill sits on whole numbers.
 *
 * SIZE CONTRACT: 24, or an integer multiple (48 for 2×). A fractional scale
 * puts every edge back between pixels; use `Ik` at those sizes instead.
 *
 * The root supplies the stroke for `outline` and withdraws it for `fill`, so
 * fill silhouettes paint from their own fill and never grow an outline.
 * Decorative by contract — the destination name lives on the link's aria-label.
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

/* ------------------------------------------------------------------------- *
 * HERO tier — stat-tile and panel leads (owner ruling 2026-08-12: heroes are
 * real marks, never the 16px garnish scaled up). 24×24, stroke 1.5, square
 * caps — the Streamline Sharp grammar the sourced inline set already speaks,
 * drawn with more mass because a hero IS the tile's subject, not garnish.
 * Renders at 16, 20 or 24; fractional scales are the old grey-soup failure.
 * The 48 hero is gone: at 48 against a 24px value the mark was twice the
 * height of the number it annotates (owner flag, 2026-08-27).
 * ------------------------------------------------------------------------- */

const HERO_GLYPHS = {
  "outcome-win": <path d="M4 13.5 9.5 19 20 5.5" />,
  "outcome-loss": <path d="M5.5 5.5 18.5 18.5 M18.5 5.5 5.5 18.5" />,
  "win-rate": (
    <>
      <path d="M18.5 5 5.5 19" />
      <rect x="4.5" y="4.5" width="5" height="5" />
      <rect x="14.5" y="14.5" width="5" height="5" />
    </>
  ),
  "avg-score": (
    <>
      <path d="M3.5 17a8.5 8.5 0 0 1 17 0" />
      <path d="M12 17l5-7" />
      <rect x="10.75" y="15.75" width="2.5" height="2.5" fill="currentColor" stroke="none" />
    </>
  ),
  "win-streak": <path d="M5 12.5 12 5.5 19 12.5 M5 19 12 12 19 19" />,
  "all-calls": <path d="M4 6.5h16 M4 12h16 M4 17.5h9" />,
  "outcome-void": (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M6.7 17.3 17.3 6.7" />
    </>
  ),
  "outcome-failed": (
    <>
      <path d="M12 4 21.5 19.5H2.5Z" />
      <path d="M12 10v4" />
      <rect x="11.1" y="16" width="1.8" height="1.8" fill="currentColor" stroke="none" />
    </>
  ),
  "outcome-other": (
    <>
      <rect x="4.5" y="10.75" width="2.5" height="2.5" fill="currentColor" stroke="none" />
      <rect x="10.75" y="10.75" width="2.5" height="2.5" fill="currentColor" stroke="none" />
      <rect x="17" y="10.75" width="2.5" height="2.5" fill="currentColor" stroke="none" />
    </>
  ),
  chain: (
    <>
      <path d="M10 7l2.2-2.2a4.1 4.1 0 0 1 5.8 5.8L15.8 12.8" />
      <path d="M14 17l-2.2 2.2a4.1 4.1 0 0 1-5.8-5.8L8.2 11.2" />
      <path d="M9.5 14.5 14.5 9.5" />
    </>
  ),
} as const;

export type HeroIconName = keyof typeof HERO_GLYPHS;
export const HERO_ICON_NAMES = Object.keys(HERO_GLYPHS) as readonly HeroIconName[];

/** Decorative by contract, like `Ik`: aria-hidden, named by adjacent text. */
export function IkHero({
  name,
  size = 20,
  className,
}: {
  name: HeroIconName;
  size?: 16 | 20 | 24;
  className?: string;
}) {
  // Stroke tracks the box. A flat 1.5 was 9% of a 16px glyph and filled the
  // Sharp Line counters in.
  const strokeWidth = size <= 16 ? 1 : size <= 20 ? 1.25 : 1.5;
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="square"
      strokeLinejoin="miter"
      aria-hidden="true"
      className={className}
      style={{ flex: "none" }}
    >
      {HERO_GLYPHS[name]}
    </svg>
  );
}

/* ------------------------------------------------------------------------- *
 * BRAND marks — third-party services show their REAL logo (owner ruling
 * 2026-08-12), the way asset chips already show real venue artwork. Google's
 * G keeps its own colors: a brand mark is the one place the monochrome rule
 * yields, because a recolored logo is not the logo. Non-brand identities
 * (email, wallet) stay currentColor house glyphs.
 * ------------------------------------------------------------------------- */

const BRAND_MARKS = {
  // Official Google G, standard four-color geometry.
  google: (
    <>
      <path
        fill="#4285F4"
        stroke="none"
        d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47a5.53 5.53 0 0 1-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82z"
      />
      <path
        fill="#34A853"
        stroke="none"
        d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09A11.99 11.99 0 0 0 12 24z"
      />
      <path
        fill="#FBBC05"
        stroke="none"
        d="M5.27 14.29A7.2 7.2 0 0 1 4.89 12c0-.8.14-1.57.38-2.29V6.62H1.29a12 12 0 0 0 0 10.76l3.98-3.09z"
      />
      <path
        fill="#EA4335"
        stroke="none"
        d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.69 1.29 6.62l3.98 3.09C6.22 6.86 8.87 4.75 12 4.75z"
      />
    </>
  ),
  // Circle's USDC mark in its own brand blue. A price is denominated in a real
  // asset, so it gets the real logo for the same reason Google's G does.
  usdc: (
    <>
      <circle cx="12" cy="12" r="12" fill="#2775CA" stroke="none" />
      <path
        fill="#FFFFFF"
        stroke="none"
        d="M15.3 13.9c0-1.75-1.05-2.35-3.15-2.6-1.5-.2-1.8-.6-1.8-1.3s.5-1.15 1.5-1.15c.9 0 1.4.3 1.65.98a.38.38 0 0 0 .35.24h.8a.34.34 0 0 0 .35-.35v-.05a2.5 2.5 0 0 0-2.25-2.05V6.5a.38.38 0 0 0-.35-.35h-.75a.38.38 0 0 0-.35.35v1.1c-1.5.2-2.45 1.2-2.45 2.45 0 1.65 1 2.3 3.1 2.55 1.4.25 1.85.55 1.85 1.35s-.7 1.35-1.65 1.35c-1.3 0-1.75-.55-1.9-1.3a.36.36 0 0 0-.35-.28h-.85a.34.34 0 0 0-.35.35v.05c.2 1.25 1 2.15 2.65 2.4v1.13c0 .19.16.35.35.35h.75a.38.38 0 0 0 .35-.35v-1.13c1.5-.25 2.5-1.3 2.5-2.63z"
      />
      <path
        fill="#FFFFFF"
        stroke="none"
        d="M9.65 19.15A7.51 7.51 0 0 1 12 4.65a.4.4 0 0 0 .3-.4v-.6a.35.35 0 0 0-.3-.38h-.1a9 9 0 0 0 0 17.45h.1a.35.35 0 0 0 .3-.38v-.6a.4.4 0 0 0-.3-.4 7.4 7.4 0 0 1-2.35-.19zm4.8-15.88h-.1a.35.35 0 0 0-.3.39v.6c0 .19.13.35.3.4a7.51 7.51 0 0 1 0 14.5.4.4 0 0 0-.3.4v.6c0 .21.14.38.3.38h.1a9 9 0 0 0 0-17.27z"
      />
    </>
  ),
  email: (
    <>
      <rect x="3" y="5.5" width="18" height="13" />
      <path d="M3.5 6.5 12 13l8.5-6.5" />
    </>
  ),
  wallet: (
    <>
      <path d="M3.5 6.5h17v12h-17z" />
      <path d="M20.5 10.5h-5v4h5" />
      <rect x="17" y="11.75" width="1.5" height="1.5" fill="currentColor" stroke="none" />
    </>
  ),
} as const;

export type BrandMarkName = keyof typeof BRAND_MARKS;

/** aria-hidden like every glyph here: the identity text beside the mark (or
 *  an sr-only span at the call site) carries the accessible name. */
export function IkBrand({
  name,
  size = 20,
  className,
}: {
  name: BrandMarkName;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="square"
      strokeLinejoin="miter"
      aria-hidden="true"
      className={className}
      style={{ flex: "none" }}
    >
      {BRAND_MARKS[name]}
    </svg>
  );
}
