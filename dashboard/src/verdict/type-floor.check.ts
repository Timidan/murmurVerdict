/**
 * The 12px floor, enforced.
 *
 * Owner ruling 2026-08-08: nothing in the cockpit renders under 12px. Until now
 * that was a convention — a sentence in dashboard/DESIGN.md and four rounds of
 * hand sweeping. A convention cannot fail a build, so the next 10px timestamp
 * would have shipped exactly like the last four did.
 *
 * This scans the SAME source set dashboard/src/styles.css declares to Tailwind
 * (`@source "./"` + `../index.html`). That pairing is the whole guarantee: the
 * stylesheet says "these files are the only things that can produce a utility",
 * and this check says "none of those files asks for a size under the floor" —
 * together they mean a sub-floor rule cannot reach the built CSS, whether it is
 * written in a className, an inline style, or a stylesheet.
 *
 * Three rules, all reported with file, line and resolved pixel value:
 *
 *   A. Arbitrary text-size utilities in any scanned file — including inside
 *      comments and prose, because Tailwind compiles a class name wherever it
 *      finds one. Variant prefixes (md:, hover:) are covered; the match is on
 *      the utility itself.
 *   B. React inline font sizes written as a literal (bare number = px in React,
 *      or a quoted px string). Computed expressions are out of reach and are
 *      left alone.
 *   C. Stylesheet `font-size` declarations and font-size custom properties,
 *      resolved from their px and rem literals (rem at the 16px root, which is
 *      what this app ships — it never restyles html { font-size }).
 *
 * Deliberately NOT covered: relative units (em, %, ex, ch). `.am-verdict` in
 * animated-mark.css is 0.62em of a wordmark whose size is set per instance, and
 * `.mmr-shell code` is `max(0.92em, 12px)` — its floor is already in the value.
 * A relative size has no fixed pixel value to check, so guessing one would only
 * add false failures. Values with no absolute literal are skipped for the same
 * reason (`inherit`, `var(...)`, `1em`).
 *
 * Documented in dashboard/DESIGN.md §2.5 ("The floor is enforced").
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** The floor itself. One number; every rule below resolves to pixels first. */
const FLOOR_PX = 12;
const REM_PX = 16;

const dashboardRoot = fileURLToPath(new URL("../../", import.meta.url));
const SRC_ROOT = join(dashboardRoot, "src");
const ENTRY_HTML = join(dashboardRoot, "index.html");
/**
 * The cinematic landing is served from `public/`, so it never enters the
 * Tailwind bundle and was never scanned here — and it had drifted almost
 * entirely under the floor while the cockpit was being swept four times: the
 * nav at 11.5px, section labels at 10.4, the footer at 9.6. It is the first
 * page a visitor sees. The floor is a product ruling, not a bundler artefact,
 * so the check follows the pixels rather than the build graph.
 */
const LANDING_ROOT = join(dashboardRoot, "public", "landing-cinematic");

interface Violation {
  file: string;
  line: number;
  token: string;
  px: number;
  rule: string;
}

const violations: Violation[] = [];

/* ── file set — mirrors `@source "./"`, minus what a bundler never reads ──── */
function walk(dir: string, out: string[]) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
}

const files: string[] = [];
walk(SRC_ROOT, files);
walk(LANDING_ROOT, files);
files.push(ENTRY_HTML);
files.sort();

/** Byte offset → 1-based line number, without splitting the file per match. */
function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** Blank out CSS comments while preserving offsets, so rule C never reads prose
    (compact.css documents "an 11.04px `code`" in a comment — that is a note
    about a rejected value, not a declaration, and must not fail the build). */
function blankComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) =>
    m.replace(/[^\n]/g, " "),
  );
}

/** px value of a `<number><unit>` literal, or null if the unit is not absolute. */
function toPx(value: string, unit: string): number | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (unit === "px") return n;
  if (unit === "rem") return n * REM_PX;
  return null;
}

// Built from parts on purpose: a source scanner must not carry a literal of the
// thing it bans, or Tailwind would compile this file's own regex into a rule
// and the check would ship the violation it exists to prevent.
const ARBITRARY_TEXT = new RegExp(
  "text-" + "\\[" + "(\\d+(?:\\.\\d+)?)(px|rem)" + "\\]",
  "g",
);
const INLINE_FONT_SIZE = /fontSize\s*:\s*(?:(\d+(?:\.\d+)?)\b(?!\s*[*/+-])|["'](\d+(?:\.\d+)?)(px|rem)["'])/g;
const CSS_FONT_SIZE = /(font-size|--[\w-]*font-size[\w-]*|--text-[\w-]+)\s*:\s*([^;{}]+)/g;
const CSS_LENGTH = /(\d+(?:\.\d+)?)(px|rem)\b/g;

for (const file of files) {
  const rel = relative(dashboardRoot, file);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue; // unreadable — nothing a bundler could read either
  }
  if (text.includes("\u0000")) continue; // binary

  // A — arbitrary text-size utilities, anywhere in the file.
  for (const m of text.matchAll(ARBITRARY_TEXT)) {
    const px = toPx(m[1], m[2]);
    if (px !== null && px < FLOOR_PX) {
      violations.push({
        file: rel,
        line: lineAt(text, m.index),
        token: m[0],
        px,
        rule: "arbitrary text-size utility",
      });
    }
  }

  // B — React inline font sizes written as a literal.
  for (const m of text.matchAll(INLINE_FONT_SIZE)) {
    const px = m[1] !== undefined ? Number(m[1]) : toPx(m[2], m[3]);
    if (px !== null && Number.isFinite(px) && px < FLOOR_PX) {
      violations.push({
        file: rel,
        line: lineAt(text, m.index),
        token: m[0].replace(/\s+/g, " "),
        px,
        rule: "inline style font size",
      });
    }
  }

  // C — stylesheet font sizes (declarations + font-size custom properties).
  if (file.endsWith(".css")) {
    const css = blankComments(text);
    for (const decl of css.matchAll(CSS_FONT_SIZE)) {
      for (const len of decl[2].matchAll(CSS_LENGTH)) {
        const px = toPx(len[1], len[2]);
        if (px !== null && px < FLOOR_PX) {
          violations.push({
            file: rel,
            line: lineAt(css, decl.index),
            token: `${decl[1]}: ${decl[2].trim()}`,
            px,
            rule: "stylesheet font-size",
          });
        }
      }
    }
  }
}

if (violations.length > 0) {
  console.error(
    `\ntype-floor.check: ${violations.length} value(s) under the ${FLOOR_PX}px floor.\n` +
      `The cockpit's smallest legal size is ${FLOOR_PX}px (owner ruling 2026-08-08,\n` +
      `dashboard/DESIGN.md §2.5). Quiet the text with ink or tracking, or move it\n` +
      `up a tier — never take it under the floor.\n`,
    // (Wording note: this file is itself a Tailwind source, so a bare utility
    // word inside a sentence compiles to a real rule. An earlier draft of the
    // line above ended on one and minted a stray utility into the built CSS —
    // the same trap the @source scoping closes for docs. Prose inside src/
    // still counts; keep the copy free of standalone utility words.)
  );
  for (const v of violations) {
    console.error(
      `  ${v.file}:${v.line}  ${v.token}  →  ${v.px}px  (${v.rule}, floor ${FLOOR_PX}px)`,
    );
  }
  console.error("");
  process.exit(1);
}

console.log(
  `type-floor.check: ok (${files.length} files scanned, nothing under ${FLOOR_PX}px)`,
);
