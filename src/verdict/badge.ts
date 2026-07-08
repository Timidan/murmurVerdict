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

const TOKENS = {
  bg: "#000000",
  surface: "#111111",
  border: "#222222",
  borderVis: "#333333",
  ink: "#FFFFFF",
  inkPrimary: "#E8E8E8",
  inkSecondary: "#999999",
  inkDisabled: "#666666",
  accent: "#D71921",
} as const;

// SVG embeds the @import inside <style>, which is parsed as XML — every '&'
// must be escaped or the document fails strict XML parsers (rsvg, sharp,
// most server-side renderers). Browsers tolerate it; SVG/XML doesn't.
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
  const rankLabel = input.rank ? `RANK ${String(input.rank).padStart(2, "0")}` : "UNRANKED";
  const winLabel =
    input.win_rate === null
      ? "—"
      : `${Math.round(input.win_rate * 100)}% win · ${input.resolved_calls} resolved`;
  const live = input.pending_calls > 0;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="80" viewBox="0 0 320 80" role="img" aria-label="Murmur Verdict badge for ${escape(input.agent.display_name)}">
  <defs>
    <style>${FONT_IMPORT}
      .doto { font-family: 'Doto', monospace; font-weight: 700; }
      .grotesk { font-family: 'Space Grotesk', sans-serif; font-weight: 500; }
      .mono { font-family: 'Space Mono', monospace; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; }
      .live { animation: pulse 1.6s ease-out infinite; }
      @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }
    </style>
  </defs>
  <rect width="320" height="80" fill="${TOKENS.bg}" />
  <rect x="0.5" y="0.5" width="319" height="79" fill="none" stroke="${TOKENS.border}" />
  <text x="20" y="22" class="mono" font-size="9" fill="${TOKENS.inkSecondary}">MURMUR.VERDICT</text>
  <text x="20" y="50" class="grotesk" font-size="18" fill="${TOKENS.ink}">${escape(truncate(input.agent.display_name, 20))}</text>
  <text x="20" y="68" class="mono" font-size="9" fill="${TOKENS.inkDisabled}">${rankLabel}</text>
  <text x="300" y="50" text-anchor="end" class="doto" font-size="40" fill="${positive ? TOKENS.ink : TOKENS.accent}">${verdict}</text>
  <text x="300" y="68" text-anchor="end" class="mono" font-size="9" fill="${TOKENS.inkSecondary}">${escape(winLabel)}</text>
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
  const rankLabel = input.rank ? `RANK ${String(input.rank).padStart(2, "0")}` : "UNRANKED";
  const winLabel =
    input.win_rate === null
      ? "—"
      : `${Math.round(input.win_rate * 100)}% WIN`;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-label="Murmur Verdict score card for ${escape(input.agent.display_name)}">
  <defs>
    <style>${FONT_IMPORT}
      .doto { font-family: 'Doto', monospace; font-weight: 700; letter-spacing: -0.04em; }
      .grotesk { font-family: 'Space Grotesk', sans-serif; font-weight: 500; }
      .mono { font-family: 'Space Mono', monospace; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; }
    </style>
  </defs>
  <rect width="1200" height="630" fill="${TOKENS.bg}" />
  <line x1="56" y1="56" x2="1144" y2="56" stroke="${TOKENS.border}" stroke-width="1" />
  <line x1="56" y1="574" x2="1144" y2="574" stroke="${TOKENS.border}" stroke-width="1" />

  <!-- top eyebrow -->
  <text x="56" y="36" class="mono" font-size="14" fill="${TOKENS.inkSecondary}">MURMUR.VERDICT</text>
  <text x="1144" y="36" text-anchor="end" class="mono" font-size="14" fill="${TOKENS.inkDisabled}">CHAINLINK + PYTH</text>

  <!-- headline -->
  <text x="56" y="148" class="mono" font-size="20" fill="${TOKENS.inkSecondary}">VERDICT SCORE · 30D</text>

  <!-- score readout (Doto) -->
  <text x="56" y="370" class="doto" font-size="240" fill="${positive ? TOKENS.ink : TOKENS.accent}">${verdict}</text>

  <!-- agent name -->
  <text x="56" y="450" class="grotesk" font-size="56" fill="${TOKENS.ink}">${escape(truncate(input.agent.display_name, 28))}</text>
  <text x="56" y="498" class="mono" font-size="20" fill="${TOKENS.inkSecondary}">@${escape(input.agent.display_slug)}</text>

  <!-- right strip: rank + stats -->
  <text x="1144" y="450" text-anchor="end" class="mono" font-size="40" fill="${TOKENS.accent}">${rankLabel}</text>
  <text x="1144" y="498" text-anchor="end" class="mono" font-size="20" fill="${TOKENS.inkSecondary}">${escape(winLabel)} · ${input.resolved_calls} RESOLVED</text>

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
 * resvg is pure WASM — no system dep. Doto / Space Grotesk / Space Mono
 * fall back to system mono/sans; the look isn't pixel-identical to the
 * SVG but reads correctly. Embed Doto via fontFiles when we want full
 * fidelity.
 */
export function rasterize(svg: string, width?: number): { png: Buffer; etag: string } {
  const resvg = new Resvg(svg, {
    fitTo: width ? { mode: "width", value: width } : { mode: "original" },
    background: "#000000",
    font: { loadSystemFonts: true, defaultFontFamily: "monospace" },
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
  <text x="20" y="36" font-family="ui-monospace, monospace" font-size="11" fill="${TOKENS.inkSecondary}">MURMUR.VERDICT</text>
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

function formatVerdict(s: number | null): string {
  if (s === null) return "——";
  const sign = s >= 0 ? "+" : "−";
  return `${sign}${Math.round(Math.abs(s) * 1000)}`;
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
