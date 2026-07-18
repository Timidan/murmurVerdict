#!/usr/bin/env node
// Discovery-based smoke runner.
//
// The `.smoke.ts` naming convention IS the test interface, but the hand-
// maintained `&&` chain in package.json ran only ~16 of ~140 smokes — every
// new smoke silently defaulted to "not in CI". This runner globs every
// `*.smoke.ts` under src/ and dashboard/src/ (excluding `*.live-smoke.ts`,
// which hit the network) and runs each sequentially via tsx, so adding a smoke
// is one file with zero package.json edits.
//
// Usage:
//   node tools/run-smokes.mjs            # run all discovered smokes
//   node tools/run-smokes.mjs --list     # just print what would run
//   node tools/run-smokes.mjs <substr>   # only smokes whose path contains substr

import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";

const ROOTS = ["src", "dashboard/src"];
const repoRoot = process.cwd();

// Smokes that already fail on `master` HEAD, independent of any current work —
// surfaced (not caused) when this discovery runner first turned them all on.
// They are reported LOUDLY but do not fail the run, so `smoke:all` still acts
// as a regression gate for everything else. Fix + remove entries over time.
const KNOWN_PREEXISTING = new Map([
  [
    "src/daemon/index.smoke.ts",
    "asserts zero startup warnings, but the daemon correctly warns when PRIVY_APP_ID/SECRET are unset",
  ],
  [
    "src/daemon/daemon-runtime-adapters.smoke.ts",
    "asserts liveCanaries.hasEnabledChecks() === false with empty env, but the polymarket canary defaults ON",
  ],
  [
    "src/verdict/leaderboard.smoke.ts",
    "global-board raw-vs-lb sort assertion (line 84) fails on HEAD",
  ],
]);

function walk(dir, out) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      walk(full, out);
    } else if (
      entry.endsWith(".smoke.ts") &&
      !entry.endsWith(".live-smoke.ts")
    ) {
      out.push(full);
    }
  }
}

const args = process.argv.slice(2);
const listOnly = args.includes("--list");
const filter = args.find((a) => !a.startsWith("--"));

const files = [];
for (const root of ROOTS) {
  try {
    walk(join(repoRoot, root), files);
  } catch {
    // root may not exist in some checkouts; skip.
  }
}
files.sort();
const selected = filter
  ? files.filter((f) => relative(repoRoot, f).includes(filter))
  : files;

if (listOnly) {
  for (const f of selected) console.log(relative(repoRoot, f));
  console.log(`\n${selected.length} smoke file(s).`);
  process.exit(0);
}

console.log(`Running ${selected.length} smoke file(s)…\n`);
const failures = [];
const knownFailed = [];
let passed = 0;
for (const f of selected) {
  const rel = relative(repoRoot, f);
  const started = process.hrtime.bigint();
  const res = spawnSync("npx", ["tsx", f], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 120_000,
  });
  const ms = Number((process.hrtime.bigint() - started) / 1_000_000n);
  if (res.status === 0) {
    passed += 1;
    console.log(`  ok   ${rel} (${ms}ms)`);
  } else if (KNOWN_PREEXISTING.has(rel)) {
    knownFailed.push(rel);
    console.log(`  known-preexisting FAIL ${rel} (${ms}ms)`);
  } else {
    failures.push({ rel, status: res.status, tail: tail(res) });
    console.log(`  FAIL ${rel} (${ms}ms, exit ${res.status})`);
  }
}

console.log(
  `\n${passed}/${selected.length} passed` +
    (knownFailed.length ? `, ${knownFailed.length} known-preexisting` : "") +
    (failures.length ? `, ${failures.length} NEW failures` : "") +
    ".",
);
if (knownFailed.length) {
  console.log("\nKnown pre-existing failures (tracked, not gating):");
  for (const rel of knownFailed) {
    console.log(`  · ${rel} — ${KNOWN_PREEXISTING.get(rel)}`);
  }
}
if (failures.length) {
  console.log(`\n${failures.length} NEW FAILURE(S):`);
  for (const fail of failures) {
    console.log(`\n── ${fail.rel} (exit ${fail.status}) ──`);
    console.log(fail.tail);
  }
  process.exit(1);
}

function tail(res) {
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`.trimEnd().split("\n");
  return out.slice(-12).join("\n");
}
