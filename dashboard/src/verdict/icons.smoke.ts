import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ICON_NAMES, Ik, IkNav, NAV_ICON_NAMES } from "./icons.js";

// Every glyph renders as a self-contained 16-grid currentColor svg.
assert.equal(ICON_NAMES.length, 27); // 28 − reputation (deleted: 0 call sites, drawing pass 2026-08-07)
for (const name of ICON_NAMES) {
  const html = renderToStaticMarkup(createElement(Ik, { name }));
  assert.ok(html.startsWith("<svg"), `${name}: renders an svg`);
  assert.ok(html.includes('viewBox="0 0 16 16"'), `${name}: 16-grid`);
  assert.ok(html.includes('aria-hidden="true"'), `${name}: aria-hidden`);
  assert.ok(html.includes('stroke="currentColor"'), `${name}: currentColor`);
  assert.ok(!html.includes("stroke=\"#"), `${name}: no hardcoded stroke color`);
  assert.ok(!/fill="#/.test(html), `${name}: no hardcoded fill color`);

  // Half-grid guard — the inline tier's committed geometry gate (mirrors the
  // nav tier's integer guard below). The grammar puts 1px H/V strokes on .5
  // offsets and fills on integers, so every legal coordinate is a multiple of
  // 0.5; anything else is drift (a 4.7 typo fails here, not in review).
  for (const [, attr, val] of html.matchAll(/\s(d|x|y|width|height)="([^"]*)"/g)) {
    for (const n of val.match(/-?\d+(?:\.\d+)?/g) ?? []) {
      assert.ok(
        Number.isInteger(Number(n) * 2),
        `${name}: ${attr} off half-grid ${n}`,
      );
    }
  }
  // Filled cells sit on whole pixels — a .5-coordinate fill renders soft.
  // The pattern must close on the opening tag's `>`, NOT on `/>`:
  // renderToStaticMarkup emits `<rect …></rect>` and never self-closes, so the
  // `\/>` this once carried matched nothing and the assertion below never ran
  // at all (dead from the day it was written until 2026-08-08). Same trap
  // applies to the nav-tier copy of this loop further down.
  for (const el of html.matchAll(/<rect\b[^>]*fill="currentColor"[^>]*>/g)) {
    for (const [, attr, v] of el[0].matchAll(/\s(x|y|width|height)="(-?\d+(?:\.\d+)?)"/g)) {
      assert.ok(
        Number.isInteger(Number(v)),
        `${name}: fill ${attr} non-integer ${v}`,
      );
    }
  }
}

// Size prop flows to width/height. The contract is 16 or 32 — 16 is the
// default, 32 the only other legal value, and the prop's literal type makes a
// fractional size (the old 12/13/14/15) a compile error rather than a review
// note. Nothing else may be asserted here: a runtime check for 12 would only
// pass by lying about the type.
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

// At 16 and 32 every edge already lands on a device pixel, so the glyph is hard
// without asking the renderer to snap it. `shape-rendering` is gone with the
// `crisp` prop it existed to carry (it papered over the fractional sizes the
// type now forbids) — its return would mean the size contract slipped.
assert.ok(!atDefault.includes("shape-rendering"), "inline: no shape-rendering");
assert.ok(!at32.includes("shape-rendering"), "inline @32: no shape-rendering");

// The two brand-class glyphs exist by exact name.
assert.ok(ICON_NAMES.includes("x402") && ICON_NAMES.includes("mcp"));

// The four gap glyphs exist by exact name — these back the credential-lifecycle
// slots (rotate / kill switch / re-attest / linked logins), so a rename here
// silently blanks those affordances rather than failing the build.
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

/** The root <svg …> tag alone — attributes on the glyph nodes don't count. */
const rootTag = (html: string) => html.slice(0, html.indexOf(">") + 1);

for (const name of NAV_ICON_NAMES) {
  const rest = renderToStaticMarkup(createElement(IkNav, { name }));
  const current = renderToStaticMarkup(createElement(IkNav, { name, active: true }));

  for (const [state, html] of [["rest", rest], ["active", current]] as const) {
    assert.ok(html.startsWith("<svg"), `${name}/${state}: renders an svg`);
    assert.ok(html.includes('viewBox="0 0 24 24"'), `${name}/${state}: 24-grid`);
    assert.ok(html.includes('aria-hidden="true"'), `${name}/${state}: aria-hidden`);
    assert.ok(!/(?:stroke|fill)="#/.test(html), `${name}/${state}: no hardcoded color`);

    // The tier's committed geometry gate — a flipped digit or a resized rect
    // fails here, not in a scratchpad script. Rest outlines stroke at 1px, so
    // their geometry sits on the half-grid (.5 offsets put a 1px ink band on
    // exactly one device pixel at 24); active silhouettes fill whole pixels.
    // Off-grid either way is drift.
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

  // Rest-state filled detail cells (live square, seal, the agent's head and
  // eyes) sit on whole pixels like every other fill — a .5-coordinate fill
  // renders soft. The half-grid pass above admits them; this pins them down.
  // Closes on `>`, not `/>` — see the inline tier's note on the same trap.
  for (const el of rest.matchAll(/<rect\b[^>]*fill="currentColor"[^>]*>/g)) {
    for (const [, attr, v] of el[0].matchAll(/\s(x|y|width|height)="(-?\d+(?:\.\d+)?)"/g)) {
      assert.ok(
        Number.isInteger(Number(v)),
        `${name}/rest: fill ${attr} non-integer ${v}`,
      );
    }
  }

  // Two fills hoist their source root's `fill="currentColor"` onto a <g>. That
  // wrapper is inheritance-only, so a node added OUTSIDE it would inherit the
  // root's `fill="none"` and paint nothing — while the whole-markup check below
  // still passes on the <g> alone. Require every ungrouped node to paint itself.
  for (const el of current.replace(/<g\b[^>]*>[\s\S]*?<\/g>/g, "").matchAll(/<(path|rect|circle|polygon)\b[^>]*>/g)) {
    assert.ok(
      el[0].includes('fill="currentColor"'),
      `${name}/active: ungrouped <${el[1]}> paints nothing`,
    );
  }

  // Rest: the root strokes the outline at the tier's native weight (hairline,
  // owner's thickness ruling 2026-08-07), and never fills — a root fill would
  // flood every closed outline path solid.
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
  `icons.smoke: ok (${ICON_NAMES.length} inline glyphs, ${NAV_ICON_NAMES.length} nav glyphs)`,
);
