// Server-side renderers for Murmur's shareable verdict badges.
//
// Two SVG variants:
//   - badge   compact (320x80) — drop into READMEs / Discord profiles / X bios
//   - og      1200x630 social card — Twitter/Discord/Slack link previews
//
// Both consume the same agent + recent-resolved input; layout differs by aspect.
// We hand-write the SVG (no satori dependency) — strict Nothing tokens means
// the layout is two text blocks + one accent line. Doto isn't bundled, so the
// score numerals are rendered in a CSS @import that browsers + most renderers
// (X, Discord, Notion) honour for inline SVG.

import type Database from "better-sqlite3";
import { Resvg } from "@resvg/resvg-js";
import { agentsRepo } from "./repos/agents-repo.js";
import { getLeaderboard } from "./leaderboard.js";

interface BadgeInput {
  agent: {
    display_slug: string;
    display_name: string;
  };
  rank: number | null;
  verdict_score: number | null;
  win_rate: number | null;
  resolved_calls: number;
  pending_calls: number;
}

function loadInput(db: Database.Database, slug: string): BadgeInput | null {
  const agent = agentsRepo.bySlug(db, slug);
  if (!agent) return null;
  const rows = getLeaderboard(db, { limit: 200 });
  const row = rows.find((r) => r.display_slug === slug);
  return {
    agent: { display_slug: agent.display_slug, display_name: agent.display_name },
    rank: row?.rank ?? null,
    verdict_score: row?.verdict_score ?? null,
    win_rate: row?.win_rate ?? null,
    resolved_calls: row?.resolved_calls ?? 0,
    pending_calls: row?.pending_calls ?? 0,
  };
}

/**
 * The share card's palette, taken from the dashboard's own dark theme
 * (dashboard/src/styles.css `@theme`) rather than approximated.
 *
 * Every value here had drifted. The canvas was pure `#000000`, which the app
 * moved off in 2026-05-31 because brand red vibrates on it; `inkDisabled` was
 * `#666666`, which fails AA as real text; and the red was `#D71921` — a THIRD
 * red, belonging neither to the approved logo mark (`#FD3C3C`) nor to the UI
 * event accent (`#C87367`). A share card is the most-forwarded surface the
 * product has, so it is the last place that should be quoting a palette
 * nobody else uses.
 */
const TOKENS = {
  bg: "#0A0A0A",
  surface: "#161616",
  border: "#262626",
  borderVis: "#363636",
  ink: "#FFFFFF",
  inkPrimary: "#E8E8E8",
  inkSecondary: "#999999",
  inkDisabled: "#8A8A8A",
  /** The single chromatic UI event accent — a losing score, and nothing else. */
  accent: "#C87367",
  /** The approved logo-dot red. Never follows the UI palette. */
  brandMark: "#FD3C3C",
} as const;

// SVG embeds the @import inside <style>, which is parsed as XML — every '&'
// must be escaped or the document fails strict XML parsers (rsvg, sharp,
// most server-side renderers). Browsers tolerate it; SVG/XML doesn't.
/**
 * Font stacks with a REACHABLE fallback at every step.
 *
 * The brand faces are fetched by `@import` and exist only where a browser can
 * load them — never on the server that rasterises the .png variants. The old
 * stacks ended at the bare generics `sans-serif` / `monospace`, which resvg
 * resolves through whatever the host's fontconfig says, and on a box with no
 * generic aliases configured that lands on a serif: the shipped card rendered
 * the agent's name in Liberation Serif, on a page whose whole identity is two
 * grotesques and a dot-matrix face. Naming the fonts that a Linux host
 * actually has, before the generic, keeps the card in the right register even
 * when nothing brand-specific is installed.
 *
 * Full fidelity needs the real faces embedded via resvg's `fontFiles` — a
 * separate call, because it means shipping font binaries in the repo.
 */
const SANS_STACK =
  "'Space Grotesk', 'DejaVu Sans', 'Liberation Sans', Arial, sans-serif";
const MONO_STACK =
  "'Space Mono', 'DejaVu Sans Mono', 'Liberation Mono', 'Courier New', monospace";
const DOTO_STACK = `'Doto', ${MONO_STACK}`;

const FONT_IMPORT = `@import url('https://fonts.googleapis.com/css2?family=Doto:wght@400;700&amp;family=Space+Grotesk:wght@500;700&amp;family=Space+Mono:wght@400;700&amp;display=swap');`;

/**
 * Compact embed badge — 320x80. SVG output. Always returns a valid badge,
 * even when the slug is unknown (renders an error pill rather than 404).
 */
export function renderBadgeSvg(db: Database.Database, slug: string): { svg: string; etag: string } {
  const input = loadInput(db, slug);
  if (!input) {
    return wrap(missingBadge(slug));
  }
  const verdict = formatVerdict(input.verdict_score);
  const positive = (input.verdict_score ?? 0) >= 0;
  // Plain count, never zero-padded: `01` reads as an identifier rather than
  // as first place (COPY.md §2.5). `resolved` is a retired word for `scored`.
  const rankLabel = input.rank ? `RANK ${input.rank}` : "UNRANKED";
  const winLabel =
    input.win_rate === null
      ? "—"
      : `${Math.round(input.win_rate * 100)}% win · ${input.resolved_calls} scored`;
  const live = input.pending_calls > 0;
  // Doto is a dot-matrix face with no em-dash glyph, so a null score rendered
  // as a tofu box at display size. The placeholder takes the mono class.
  const scoreClass = input.verdict_score === null ? "mono" : "doto";

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="80" viewBox="0 0 320 80" role="img" aria-label="Murmur Verdict badge for ${escape(input.agent.display_name)}">
  <defs>
    <style>${FONT_IMPORT}
      .doto { font-family: ${DOTO_STACK}; font-weight: 700; }
      .grotesk { font-family: ${SANS_STACK}; font-weight: 500; }
      .mono { font-family: ${MONO_STACK}; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; }
      .live { animation: pulse 1.6s ease-out infinite; }
      @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }
      /* This badge is embedded in other people's pages, where a reader's
         motion preference is the only signal we get. Honour it. */
      @media (prefers-reduced-motion: reduce) { .live { animation: none; } }
    </style>
  </defs>
  <rect width="320" height="80" fill="${TOKENS.bg}" />
  <rect x="0.5" y="0.5" width="319" height="79" fill="none" stroke="${TOKENS.border}" />
  <!-- 12px is the floor everywhere a reader reads, and an embed badge is
       rendered at its intrinsic 320x80 on somebody else's page — so 9px here
       was 9px on screen, on the one surface murmur puts in front of strangers.
       All three chrome labels sit ON the floor; none of them needed the space
       it bought. -->
  <text x="20" y="22" class="mono" font-size="12" fill="${TOKENS.inkSecondary}">MURMUR.VERDICT</text>
  <text x="20" y="50" class="grotesk" font-size="18" fill="${TOKENS.ink}">${escape(truncate(input.agent.display_name, 16))}</text>
  <text x="20" y="68" class="mono" font-size="12" fill="${TOKENS.inkDisabled}">${rankLabel}</text>
  <!-- 28, not 40, and the name truncates at 16 rather than 20. The score is
       six characters now that it is spelled the way the app spells it, and at
       40px in a 320px badge it ran back to x=170 and printed straight through
       the agent's name. Both sides gave ground: the readout is still the
       loudest thing here by a factor of 1.5 over the name. -->
  <text x="300" y="50" text-anchor="end" class="${scoreClass}" font-size="28" fill="${positive ? TOKENS.ink : TOKENS.accent}">${verdict}</text>
  <text x="300" y="68" text-anchor="end" class="mono" font-size="12" fill="${TOKENS.inkSecondary}">${escape(winLabel)}</text>
  ${live ? `<rect x="304" y="14" width="6" height="6" fill="${TOKENS.accent}" class="live" />` : ""}
</svg>`;

  return wrap(svg);
}

/**
 * 1200x630 OG / social card. Same vocabulary as the badge, scaled for
 * Twitter / Discord / Slack link unfurls. Static — no animation.
 */
export function renderOgSvg(db: Database.Database, slug: string): { svg: string; etag: string } {
  const input = loadInput(db, slug);
  if (!input) {
    return wrap(missingOg(slug));
  }
  const verdict = formatVerdict(input.verdict_score);
  const positive = (input.verdict_score ?? 0) >= 0;
  const rankLabel = input.rank ? `RANK ${input.rank}` : "UNRANKED";
  const winLabel =
    input.win_rate === null
      ? "—"
      : `${Math.round(input.win_rate * 100)}% WIN`;
  // Doto is a dot-matrix face with no em-dash glyph, so a null score rendered
  // as a tofu box at display size. The placeholder takes the mono class.
  const scoreClass = input.verdict_score === null ? "mono" : "doto";

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-label="Murmur Verdict score card for ${escape(input.agent.display_name)}">
  <defs>
    <style>${FONT_IMPORT}
      .doto { font-family: ${DOTO_STACK}; font-weight: 700; letter-spacing: -0.04em; }
      .grotesk { font-family: ${SANS_STACK}; font-weight: 500; }
      .mono { font-family: ${MONO_STACK}; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; }
    </style>
  </defs>
  <rect width="1200" height="630" fill="${TOKENS.bg}" />
  <line x1="56" y1="56" x2="1144" y2="56" stroke="${TOKENS.border}" stroke-width="1" />
  <line x1="56" y1="574" x2="1144" y2="574" stroke="${TOKENS.border}" stroke-width="1" />

  <!-- top eyebrow -->
  <text x="56" y="36" class="mono" font-size="14" fill="${TOKENS.inkSecondary}">MURMUR.VERDICT</text>
  <text x="1144" y="36" text-anchor="end" class="mono" font-size="14" fill="${TOKENS.inkDisabled}">RESOLVED BY THE VENUE</text>

  <!-- headline -->
  <!-- "30D" was false: murmur has never had a rolling 30-day board, and
       COPY.md §4 lists the scoring window as all time. -->
  <text x="56" y="148" class="mono" font-size="20" fill="${TOKENS.inkSecondary}">SCORE · ALL TIME</text>

  <!-- Score readout. 180, not 240: the value is six characters now that it
       is spelled the way the app spells it, and at 240 a mono "+0.502" runs
       864px of the 1088px between the rules. -->
  <text x="56" y="360" class="${scoreClass}" font-size="180" fill="${positive ? TOKENS.ink : TOKENS.accent}">${verdict}</text>

  <!-- agent name -->
  <text x="56" y="450" class="grotesk" font-size="56" fill="${TOKENS.ink}">${escape(truncate(input.agent.display_name, 28))}</text>
  <text x="56" y="498" class="mono" font-size="20" fill="${TOKENS.inkSecondary}">@${escape(input.agent.display_slug)}</text>

  <!-- right strip: rank + stats -->
  <!-- Rank in display ink, not red. A rank is not an urgent event, and the
       palette reserves the accent for one ("if nothing is urgent, no red on
       screen"). Red on this card now means exactly one thing: a losing score. -->
  <text x="1144" y="450" text-anchor="end" class="mono" font-size="40" fill="${TOKENS.ink}">${rankLabel}</text>
  <text x="1144" y="498" text-anchor="end" class="mono" font-size="20" fill="${TOKENS.inkSecondary}">${escape(winLabel)} · ${input.resolved_calls} SCORED</text>

  <!-- footer -->
  <text x="56" y="600" class="mono" font-size="14" fill="${TOKENS.inkDisabled}">PUBLIC REFEREE FOR AUTONOMOUS MARKET AGENTS</text>
  <text x="1144" y="600" text-anchor="end" class="mono" font-size="14" fill="${TOKENS.inkDisabled}">${input.pending_calls > 0 ? `${input.pending_calls} LIVE` : "—"}</text>
</svg>`;
  return wrap(svg);
}

/**
 * Server-side rasterisation of either SVG. Used by the .png variants of
 * the badge / OG endpoints so X / Discord / Slack can render the social
 * card inline (those clients don't accept SVG OG).
 *
 * resvg is pure WASM — no system dep. The brand faces are never installed on
 * the server, so the card falls back through the stacks at the top of this
 * file. `defaultFontFamily` is the last resort for text whose whole stack
 * misses, and it used to be "monospace" — which on a host with no generic
 * aliases resolved to a serif, so the agent's name shipped in Liberation Serif.
 * Naming a concrete family that Linux hosts carry keeps the fallback honest.
 * Embedding the real faces via `fontFiles` is what would make it exact.
 */
export function rasterize(svg: string, width?: number): { png: Buffer; etag: string } {
  const resvg = new Resvg(svg, {
    fitTo: width ? { mode: "width", value: width } : { mode: "original" },
    background: TOKENS.bg,
    font: {
      loadSystemFonts: true,
      defaultFontFamily: "DejaVu Sans",
      sansSerifFamily: "DejaVu Sans",
      monospaceFamily: "DejaVu Sans Mono",
    },
  });
  const buf = resvg.render().asPng();
  return { png: buf, etag: `W/"${hashOf(svg)}-${buf.byteLength}"` };
}

// ─── helpers ────────────────────────────────────────────────────────────────

function wrap(svg: string): { svg: string; etag: string } {
  return { svg, etag: `W/"${hashOf(svg)}"` };
}

function missingBadge(slug: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="80" viewBox="0 0 320 80" role="img">
  <rect width="320" height="80" fill="${TOKENS.bg}" />
  <rect x="0.5" y="0.5" width="319" height="79" fill="none" stroke="${TOKENS.accent}" />
  <text x="20" y="36" font-family="ui-monospace, monospace" font-size="12" fill="${TOKENS.inkSecondary}">MURMUR.VERDICT</text>
  <text x="20" y="58" font-family="ui-monospace, monospace" font-size="13" fill="${TOKENS.accent}">[ NOT FOUND ] @${escape(truncate(slug, 24))}</text>
</svg>`;
}

function missingOg(slug: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img">
  <rect width="1200" height="630" fill="${TOKENS.bg}" />
  <text x="600" y="320" text-anchor="middle" font-family="ui-monospace, monospace" font-size="32" fill="${TOKENS.accent}">[ AGENT NOT FOUND ]</text>
  <text x="600" y="360" text-anchor="middle" font-family="ui-monospace, monospace" font-size="18" fill="${TOKENS.inkSecondary}">@${escape(slug)}</text>
</svg>`;
}

/**
 * The score, spelled the way every murmur surface spells it: an explicit sign
 * and three decimals.
 *
 * This card used to publish `Math.round(score * 1000)` — the same number as
 * "+502" where the leaderboard, the agent page and the call page all say
 * "+0.502". A reader who shares their card and then opens their profile saw
 * two different numbers for one score. Zero takes no sign, for the same reason
 * it takes none in the app: it is neither.
 *
 * Kept in step with dashboard/src/verdict/lib/score-format.ts by hand — the
 * daemon cannot import from the dashboard bundle. Change one, change both.
 */
function formatVerdict(s: number | null): string {
  if (s === null) return "—";
  const rounded = Number(s.toFixed(3));
  const sign = rounded === 0 ? "" : rounded > 0 ? "+" : "−";
  return `${sign}${Math.abs(s).toFixed(3)}`;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function hashOf(s: string): string {
  // Cheap, stable enough for ETag — FNV-1a 32-bit.
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return h.toString(16);
}
