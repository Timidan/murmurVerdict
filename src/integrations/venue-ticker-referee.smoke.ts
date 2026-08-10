// ─── Pure-referee boundary smoke ────────────────────────────────────────────
//
// Murmur is a referee: it never authors markets and never decides outcomes.
// Its verdicts come from ONE path — the resolver → resolution lifecycle →
// venue adapter registry. The venue ticker is a display feed reading the same
// venue over a websocket, and the two must not touch.
//
// The failure this prevents is quiet and expensive: someone wires the live
// ticker's cached price into a settlement decision (or the resolver starts
// waiting on the ticker's socket), and murmur silently becomes a price
// oracle. Comments cannot hold that line, so this smoke reads the actual
// import graph in both directions.
//
//   1. no resolution-path module imports the venue ticker
//   2. the venue ticker imports no resolution-path module
//   3. the ticker does not touch the adapter's module-level client
//      singletons, whose caches the resolver depends on

import { strict as assert } from "node:assert";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

process.stdout.write("murmur venue ticker referee-boundary smoke\n");

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const srcRoot = join(repoRoot, "src");

const VENUE_TICKER_FILES = [
  "src/integrations/venue-ticker.ts",
  "src/integrations/venue-ticker-surface.ts",
];

/**
 * Murmur's resolution path. `resolver*` is the tick itself; the lifecycle
 * module is where a call actually becomes terminal and scored.
 */
function isResolutionPathModule(relPath: string): boolean {
  return (
    /^src\/verdict\/resolver[^/]*\.ts$/.test(relPath) ||
    /^src\/verdict\/resolution-lifecycle[^/]*\.ts$/.test(relPath)
  );
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      walk(full, out);
      continue;
    }
    if (entry.endsWith(".ts")) out.push(full);
  }
}

const files: string[] = [];
walk(srcRoot, files);
assert.ok(files.length > 50, "walked the source tree");

/** Every module specifier in a file: static imports, re-exports, dynamic. */
function importSpecifiers(source: string): string[] {
  const out: string[] = [];
  const patterns = [
    /(?:^|\n)\s*(?:import|export)\s[\s\S]*?from\s+["']([^"']+)["']/g,
    /(?:^|\n)\s*import\s+["']([^"']+)["']/g,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) out.push(match[1]!);
  }
  return out;
}

/** Resolve a relative specifier to a repo-relative `.ts` path. */
function resolveLocal(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const abs = resolve(dirname(fromFile), specifier).replace(/\.js$/, ".ts");
  return relative(repoRoot, abs).split("\\").join("/");
}

// ─── 1. Nothing in the resolution path may import the ticker ───────────────

{
  const offenders: string[] = [];
  for (const file of files) {
    const rel = relative(repoRoot, file).split("\\").join("/");
    if (!isResolutionPathModule(rel)) continue;
    const source = readFileSync(file, "utf8");
    for (const specifier of importSpecifiers(source)) {
      const target = resolveLocal(file, specifier);
      if (target !== null && VENUE_TICKER_FILES.includes(target)) {
        offenders.push(`${rel} → ${specifier}`);
      }
      if (specifier.includes("venue-ticker")) {
        offenders.push(`${rel} → ${specifier}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "a resolution-path module imports the venue ticker: murmur's verdict " +
      "would then depend on a display feed",
  );
  // Guard the guard: the matcher must actually recognize the real modules.
  const matched = files
    .map((file) => relative(repoRoot, file).split("\\").join("/"))
    .filter(isResolutionPathModule);
  assert.ok(
    matched.includes("src/verdict/resolver.ts"),
    "the resolution-path matcher must cover src/verdict/resolver.ts",
  );
  assert.ok(
    matched.includes("src/verdict/resolution-lifecycle.ts"),
    "the resolution-path matcher must cover src/verdict/resolution-lifecycle.ts",
  );
  console.log(`  ok  no resolution-path module imports the ticker (${matched.length} checked)`);
}

// ─── 2. The ticker imports no resolution-path module ───────────────────────

{
  const offenders: string[] = [];
  for (const rel of VENUE_TICKER_FILES) {
    const abs = join(repoRoot, rel);
    const source = readFileSync(abs, "utf8");
    for (const specifier of importSpecifiers(source)) {
      const target = resolveLocal(abs, specifier);
      if (target !== null && isResolutionPathModule(target)) {
        offenders.push(`${rel} → ${specifier}`);
      }
      if (/resolver|resolution-lifecycle/.test(specifier)) {
        offenders.push(`${rel} → ${specifier}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "the venue ticker imports a resolution-path module",
  );
  console.log("  ok  the ticker imports no resolution-path module");
}

// ─── 3. The ticker keeps its own clients ───────────────────────────────────

{
  const source = readFileSync(
    join(repoRoot, "src/integrations/venue-ticker.ts"),
    "utf8",
  );
  for (const banned of [
    "setDefaultPolymarketClient",
    "setDefaultPolymarketClobClient",
    "getDefaultPolymarketClobClient",
    "setDefaultPolymarketClock",
  ]) {
    assert.ok(
      !new RegExp(`(?<!\`)\\b${banned}\\s*\\(`).test(source),
      `the ticker must not call ${banned}: those singletons back the ` +
        `resolver's cache, and a display-side poll would evict or poison it`,
    );
  }
  // It must also not reach the adapter barrel, which owns those singletons.
  for (const specifier of importSpecifiers(source)) {
    assert.ok(
      !/polymarket-gamma\/(index|register|discovery|sync)\.js$/.test(specifier),
      `the ticker must import pure leaves, not the adapter barrel (${specifier})`,
    );
  }
  console.log("  ok  the ticker owns its own Gamma/CLOB clients");
}

process.stdout.write("venue ticker referee-boundary smoke OK\n");
