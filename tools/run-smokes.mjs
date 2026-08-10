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
import { execFileSync, spawnSync } from "node:child_process";

const ROOTS = ["src", "dashboard/src"];
const repoRoot = process.cwd();

// Smokes that already fail on `master` HEAD, independent of any current work —
// surfaced (not caused) when this discovery runner first turned them all on.
// They are reported LOUDLY but do not fail the run, so `smoke:all` still acts
// as a regression gate for everything else. Fix + remove entries over time.
//
// STRICT MODE: set SMOKE_STRICT=1 to make these fail too. `verify:readiness`
// does this, because a release gate that reports success while known files fail
// is fail-open — and worse, a NEW regression inside an allowlisted file is
// masked entirely.
// Tracked-vs-on-disk corpus check.
//
// `verify:readiness` gates releases on this suite, so any test file that is not
// tracked simply does not exist on a clean checkout or in CI — a green run
// locally would then mean nothing there. (`.gitignore` used to exclude
// `**/*.smoke.ts` wholesale; that policy was reversed for exactly this reason.)
//
// Reported loudly on every run, and fatal under SMOKE_STRICT so a release gate
// cannot pass while its own corpus is unreproducible.
function reportUntrackedSmokes(files, repoRoot) {
  let tracked = new Set();
  try {
    const out = execFileSync("git", ["ls-files", "*.smoke.ts", "*.check.ts"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    tracked = new Set(out.split("\n").filter(Boolean));
  } catch (err) {
    // Fail CLOSED under strict mode. A missing git binary or a source bundle
    // without history is precisely when the corpus is least verifiable, so
    // silently skipping the check there defeats its purpose.
    if (process.env.SMOKE_STRICT === "1") {
      console.error(
        `\n  !! cannot verify the test corpus against git (${
          err instanceof Error ? err.message : String(err)
        }). Under SMOKE_STRICT this is fatal: reproducibility is unproven.\n`,
      );
      process.exit(1);
    }
    return null;
  }
  // `files` are absolute paths; git reports repo-relative ones.
  const untracked = files.filter((f) => !tracked.has(relative(repoRoot, f)));
  if (untracked.length === 0) return null;
  console.warn(
    `\n  !! ${untracked.length} of ${files.length} smokes are NOT tracked by git.\n` +
      `     A clean checkout runs ${files.length - untracked.length}. ` +
      `Either track them or stop gating releases on this suite.\n` +
      untracked.slice(0, 5).map((f) => `       - ${relative(repoRoot, f)}`).join("\n") +
      (untracked.length > 5 ? `\n       ... and ${untracked.length - 5} more` : "") +
      "\n",
  );
  return untracked.length;
}

const KNOWN_PREEXISTING = new Map([
  [
    "src/daemon/index.smoke.ts",
    "asserts zero startup warnings, but the daemon correctly warns when PRIVY_APP_ID/SECRET are unset",
  ],
  [
    "src/daemon/daemon-runtime-adapters.smoke.ts",
    "asserts liveCanaries.hasEnabledChecks() === false with empty env, but the polymarket canary defaults ON",
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
      // `.check.ts` files are the same kind of gate as smokes and were only
      // wired through hand-listed npm scripts, so `smoke:all` never ran them
      // and the release gate silently skipped them.
      (entry.endsWith(".smoke.ts") || entry.endsWith(".check.ts")) &&
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
  } else if (KNOWN_PREEXISTING.has(rel) && process.env.SMOKE_STRICT !== "1") {
    knownFailed.push(rel);
    console.log(`  known-preexisting FAIL ${rel} (${ms}ms)`);
  } else {
    failures.push({ rel, status: res.status, tail: tail(res) });
    console.log(`  FAIL ${rel} (${ms}ms, exit ${res.status})`);
  }
}

const untrackedCount = reportUntrackedSmokes(selected, process.cwd());

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
if (untrackedCount && process.env.SMOKE_STRICT === "1") {
  console.error(
    `\nFAIL: ${untrackedCount} smoke(s) are untracked, so this result is not ` +
      `reproducible from a clean checkout. Track them or drop the release ` +
      `gate's dependency on them.`,
  );
  process.exit(1);
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
