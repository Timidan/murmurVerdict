#!/usr/bin/env node
// Fail fast when a git submodule is declared but not populated.
//
// `forge-std` is a submodule, and `verify:readiness` runs Forge. A plain
// `git clone` — or a CI checkout without `submodules: recursive` — leaves the
// directory empty, and Forge then fails with an import error that looks like a
// broken test rather than a checkout problem. A populated developer machine
// passes the same gate, so the difference only ever shows up in CI.
//
// This turns that into one sentence naming the fix.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = process.cwd();
const gitmodules = join(repoRoot, ".gitmodules");

if (!existsSync(gitmodules)) process.exit(0);

const paths = readFileSync(gitmodules, "utf8")
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line.startsWith("path"))
  .map((line) => line.slice(line.indexOf("=") + 1).trim())
  .filter(Boolean);

const empty = paths.filter((p) => {
  const full = join(repoRoot, p);
  if (!existsSync(full)) return true;
  try {
    return readdirSync(full).length === 0;
  } catch {
    return true;
  }
});

if (empty.length > 0) {
  console.error(
    `\n  !! ${empty.length} git submodule(s) are declared but not populated:\n` +
      empty.map((p) => `       - ${p}`).join("\n") +
      `\n\n     Run:  git submodule update --init --recursive\n`,
  );
  process.exit(1);
}
