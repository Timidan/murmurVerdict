#!/usr/bin/env node
// Fails fast when a git submodule is declared but empty (e.g. a CI checkout without
// `submodules: recursive`), instead of Forge failing later with a misleading import error.

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
