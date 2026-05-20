// dashboard/src/verdict/components/MobileNavDrawer.smoke.tsx
//
// Run: TSX_TSCONFIG_PATH=dashboard/tsconfig.json tsx \
//        dashboard/src/verdict/components/MobileNavDrawer.smoke.tsx
//
// The TSX_TSCONFIG_PATH is required because the dashboard uses
// `jsx: "react-jsx"` (automatic runtime); the repo root tsconfig
// doesn't, and `tsx` resolves config from cwd by default.
//
// Bare-minimum smoke check that <MobileNavDrawer /> renders the
// contract the spec locks in (docs/superpowers/specs/2026-05-20-
// mobile-hamburger-nav-design.md):
//   1. Trigger has `md:hidden` so it doesn't render at ≥768px.
//   2. Trigger exposes aria-expanded=false initially + aria-label "open menu".
//   3. Sheet has role="dialog" with aria-modal="false".
//   4. All five spec rows render: leaderboard, today, recruiters,
//      install (#/launch), account.
//   5. `aria-hidden` on the sheet is true at initial closed state.
//
// Matches the sibling smoke pattern in
// dashboard/src/verdict/ui/theme.smoke.ts (CLI script via tsx).

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MobileNavDrawer } from "./MobileNavDrawer.js";

const html = renderToStaticMarkup(createElement(MobileNavDrawer));

const cases: Array<[boolean, string]> = [
  [html.includes("md:hidden"), "wrapper carries md:hidden so trigger hides at ≥768px"],
  [html.includes('aria-expanded="false"'), "trigger initial aria-expanded=false"],
  [html.includes('aria-label="open menu"'), "trigger initial aria-label=open menu"],
  [html.includes('role="dialog"'), "sheet has role=dialog"],
  [html.includes('aria-modal="false"'), "sheet has aria-modal=false (no focus trap)"],
  [html.includes('aria-hidden="true"'), "sheet is aria-hidden=true at closed state"],
  [html.includes('href="#/leaderboard"'), "row: leaderboard → #/leaderboard"],
  [html.includes('href="#/today"'), "row: today → #/today"],
  [html.includes('href="#/recruiters"'), "row: recruiters → #/recruiters"],
  [html.includes('href="#/launch"'), "row: install button → #/launch"],
  [html.includes('href="#/account"'), "row: account → #/account (dumb deep-link)"],
  [html.includes("INSTALL"), "install row renders the outlined INSTALL button"],
  [html.includes("<svg"), "hand-rolled inline SVG glyph is present (no icon library)"],
];

let failed = 0;
for (const [ok, label] of cases) {
  if (!ok) {
    console.error(`FAIL  ${label}`);
    failed++;
  } else {
    console.log(`PASS  ${label}`);
  }
}
if (failed) {
  console.error(`\n${failed} failure(s).`);
  process.exit(1);
}
console.log(`\nAll ${cases.length} drawer-contract cases passed.`);
