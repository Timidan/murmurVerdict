/**
 * Enforces the 12px type floor: nothing in the cockpit renders under 12px.
 *
 * Scans the same sources Tailwind reads (`@source "./"` + `../index.html`), plus
 * the public cinematic landing, so no sub-floor size can reach the built CSS:
 *   A. Arbitrary text-size utilities anywhere, comments included (Tailwind
 *      compiles a class name wherever it appears).
 *   B. Literal React inline font sizes (bare number = px, or a quoted px/rem).
 *   C. Stylesheet `font-size` and font-size custom properties (rem at 16px).
 * Relative units (em, %, ex, ch) and values with no absolute literal are skipped.
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
/** The cinematic landing lives in `public/`, outside the Tailwind bundle; the floor still applies. */
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

/** Blank out CSS comments, preserving offsets, so rule C never reads prose. */
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

// Built from parts: a literal here would make Tailwind compile the banned utility.
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
    // This file is a Tailwind source: keep standalone utility words out of this message.
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
