import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  ICON_NAMES,
  Ik,
  IkNav,
  NAV_ICON_NAMES,
  NAV_STREAMLINE_ICON_NAMES,
  STREAMLINE_ICON_NAMES,
} from "./icons.js";

// Every glyph renders as a currentColor svg on its origin's grid (16 hand-drawn, 24 Streamline).
assert.equal(ICON_NAMES.length, 45);
assert.equal(
  STREAMLINE_ICON_NAMES.length,
  16,
  "16 of 45 inline concepts sourced from Streamline Sharp (2026-08-10 pass); the 8 tab-* rail glyphs are hand-drawn in the same grammar",
);

// The summary grid is icon-only, so pin all ten scoring glyphs by exact name.
for (const name of [
  "outcome-win",
  "outcome-loss",
  "outcome-void",
  "outcome-failed",
  "outcome-other",
  "avg-score",
  "win-rate",
  "win-streak",
  "all-calls",
  "chain",
] as const) {
  assert.ok(ICON_NAMES.includes(name), `${name}: agent-scoring glyph present`);
}
for (const name of ICON_NAMES) {
  const html = renderToStaticMarkup(createElement(Ik, { name }));
  const sourced = (STREAMLINE_ICON_NAMES as readonly string[]).includes(name);

  assert.ok(html.startsWith("<svg"), `${name}: renders an svg`);
  assert.ok(
    html.includes(sourced ? 'viewBox="0 0 24 24"' : 'viewBox="0 0 16 16"'),
    `${name}: ${sourced ? "24" : "16"}-grid`,
  );
  assert.ok(html.includes('aria-hidden="true"'), `${name}: aria-hidden`);
  assert.ok(html.includes('stroke="currentColor"'), `${name}: currentColor`);
  assert.ok(!html.includes("stroke=\"#"), `${name}: no hardcoded stroke color`);
  assert.ok(!/fill="#/.test(html), `${name}: no hardcoded fill color`);

  if (sourced) {
    // Streamline: 1.5px on 24 (same weight as 1px on 16); vector exports skip the grid guards.
    assert.ok(html.includes('stroke-width="1.5"'), `${name}: streamline weight`);
    continue;
  }

  // Half-grid guard: every hand-drawn coordinate is a multiple of 0.5.
  for (const [, attr, val] of html.matchAll(/\s(d|x|y|width|height)="([^"]*)"/g)) {
    for (const n of val.match(/-?\d+(?:\.\d+)?/g) ?? []) {
      assert.ok(
        Number.isInteger(Number(n) * 2),
        `${name}: ${attr} off half-grid ${n}`,
      );
    }
  }
  // Filled cells sit on whole pixels. Match the opening tag's `>`, not `/>`:
  // renderToStaticMarkup never self-closes.
  for (const el of html.matchAll(/<rect\b[^>]*fill="currentColor"[^>]*>/g)) {
    for (const [, attr, v] of el[0].matchAll(/\s(x|y|width|height)="(-?\d+(?:\.\d+)?)"/g)) {
      assert.ok(
        Number.isInteger(Number(v)),
        `${name}: fill ${attr} non-integer ${v}`,
      );
    }
  }
}

// Size flows to width/height: 16 by default, 32 the only other value (typed).
const atDefault = renderToStaticMarkup(createElement(Ik, { name: "seal" }));
assert.ok(
  atDefault.includes('width="16"') && atDefault.includes('height="16"'),
  "inline: defaults to 16",
);
const at32 = renderToStaticMarkup(createElement(Ik, { name: "seal", size: 32 }));
assert.ok(
  at32.includes('width="32"') && at32.includes('height="32"'),
  "inline: size flows at 32",
);

// Integer sizes land on device pixels, so no `shape-rendering` is needed.
assert.ok(!atDefault.includes("shape-rendering"), "inline: no shape-rendering");
assert.ok(!at32.includes("shape-rendering"), "inline @32: no shape-rendering");

// The two brand-class glyphs exist by exact name.
assert.ok(ICON_NAMES.includes("x402") && ICON_NAMES.includes("mcp"));

// The four credential-lifecycle glyphs exist by exact name.
for (const name of ["rotate", "kill-switch", "attest", "link"] as const) {
  assert.ok(ICON_NAMES.includes(name), `${name}: gap glyph present`);
}

// ---------------------------------------------------------------------------
// NAV tier — 24-grid, hairline rest / solid active, two states per concept.
// ---------------------------------------------------------------------------

// Exactly six destinations, by exact name: the topbar keys NAV_ICONS on the
// route, so a rename here type-errors the topbar rather than blanking a link.
assert.equal(NAV_ICON_NAMES.length, 6, "nav: six destinations");
assert.deepEqual(
  [...NAV_ICON_NAMES].sort(),
  ["agent", "badge", "confirm-live", "feed", "leaderboard", "market"],
  "nav: the exact six",
);
assert.deepEqual(
  [...NAV_STREAMLINE_ICON_NAMES].sort(),
  ["agent", "badge"],
  "nav: exactly two destinations sourced from Streamline Sharp",
);

/** The root <svg …> tag alone — attributes on the glyph nodes don't count. */
const rootTag = (html: string) => html.slice(0, html.indexOf(">") + 1);

for (const name of NAV_ICON_NAMES) {
  const rest = renderToStaticMarkup(createElement(IkNav, { name }));
  const current = renderToStaticMarkup(createElement(IkNav, { name, active: true }));
  const sourced = (NAV_STREAMLINE_ICON_NAMES as readonly string[]).includes(name);

  for (const [state, html] of [["rest", rest], ["active", current]] as const) {
    assert.ok(html.startsWith("<svg"), `${name}/${state}: renders an svg`);
    assert.ok(html.includes('viewBox="0 0 24 24"'), `${name}/${state}: 24-grid`);
    assert.ok(html.includes('aria-hidden="true"'), `${name}/${state}: aria-hidden`);
    assert.ok(!/(?:stroke|fill)="#/.test(html), `${name}/${state}: no hardcoded color`);

    if (sourced) {
      // agent/badge are Streamline vector geometry: skip the pixel-snap gate.
      continue;
    }

    // Geometry gate: rest outlines on the half-grid, active silhouettes on whole pixels.
    for (const [, attr, val] of html.matchAll(/\s(d|x|y|width|height)="([^"]*)"/g)) {
      for (const n of val.match(/-?\d+(?:\.\d+)?/g) ?? []) {
        assert.ok(
          state === "active"
            ? Number.isInteger(Number(n))
            : Number.isInteger(Number(n) * 2),
          `${name}/${state}: ${attr} off grid ${n}`,
        );
      }
    }
  }

  // Rest-state filled cells sit on whole pixels (match `>`, not `/>`, as above).
  for (const el of rest.matchAll(/<rect\b[^>]*fill="currentColor"[^>]*>/g)) {
    for (const [, attr, v] of el[0].matchAll(/\s(x|y|width|height)="(-?\d+(?:\.\d+)?)"/g)) {
      assert.ok(
        Number.isInteger(Number(v)),
        `${name}/rest: fill ${attr} non-integer ${v}`,
      );
    }
  }

  // Every node outside a fill <g> must paint itself, or it inherits `fill="none"`.
  for (const el of current.replace(/<g\b[^>]*>[\s\S]*?<\/g>/g, "").matchAll(/<(path|rect|circle|polygon)\b[^>]*>/g)) {
    assert.ok(
      el[0].includes('fill="currentColor"'),
      `${name}/active: ungrouped <${el[1]}> paints nothing`,
    );
  }

  // Rest: the root strokes a 1px hairline and never fills (a root fill floods closed paths).
  assert.ok(rootTag(rest).includes('stroke-width="1"'), `${name}/rest: hairline root`);
  assert.ok(rootTag(rest).includes('stroke="currentColor"'), `${name}/rest: stroked`);
  assert.ok(
    !rootTag(rest).includes('fill="currentColor"'),
    `${name}/rest: root does not fill`,
  );

  // Active: the root withdraws the stroke and the silhouettes paint themselves,
  // so the fill state can never grow an outline around it.
  assert.ok(rootTag(current).includes('stroke="none"'), `${name}/active: unstroked root`);
  assert.ok(
    !rootTag(current).includes("stroke-width"),
    `${name}/active: no stroke weight`,
  );
  assert.ok(
    current.includes('fill="currentColor"'),
    `${name}/active: fills from the nodes`,
  );
}

// Size flows to width/height; 24 is the default and 48 the only other sanctioned
// size (integer multiples only — see the IkNav size contract).
const navDefault = renderToStaticMarkup(createElement(IkNav, { name: "market" }));
assert.ok(
  navDefault.includes('width="24"') && navDefault.includes('height="24"'),
  "nav: defaults to 24",
);
const nav48 = renderToStaticMarkup(
  createElement(IkNav, { name: "market", size: 48, active: true }),
);
assert.ok(
  nav48.includes('width="48"') && nav48.includes('height="48"'),
  "nav: size flows at 48",
);

console.log(
  `icons.smoke: ok (${ICON_NAMES.length} inline glyphs [${STREAMLINE_ICON_NAMES.length} streamline], ${NAV_ICON_NAMES.length} nav glyphs [${NAV_STREAMLINE_ICON_NAMES.length} streamline])`,
);
