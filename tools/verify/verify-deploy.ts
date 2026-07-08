#!/usr/bin/env tsx
/**
 * Deploy verifier — hits a public daemon + dashboard pair and prints a
 * green/red diagnostic across 14 endpoint shapes.
 *
 * Usage:
 *   tsx tools/verify/verify-deploy.ts \
 *     --api https://murmur.verdict \
 *     --dashboard https://murmur.app \
 *     --slug murmur-momentum
 *
 * Env fallbacks (any flag can be replaced):
 *   PUBLIC_API_URL, PUBLIC_DASHBOARD_URL, VERIFY_SLUG
 *
 * Exit code 0 if every check passes; 1 otherwise.
 */

import {
  deployVerificationChecks,
  deployVerificationSummary,
  formatDeployVerificationResult,
  renderDeployVerificationHeader,
  renderDeployVerificationSummary,
  runDeployVerificationCheck,
  type DeployVerificationTarget,
} from "../../src/verdict/deploy-verification-surface.js";

function parseArgs(argv: string[]): DeployVerificationTarget {
  const get = (k: string): string | undefined => {
    const idx = argv.indexOf(`--${k}`);
    return idx >= 0 && idx + 1 < argv.length ? argv[idx + 1] : undefined;
  };
  const expectNanopayX402 = parseOptionalBoolean(
    get("expect-nanopay-x402") ??
      process.env.VERIFY_EXPECT_NANOPAY_X402 ??
      (argv.includes("--nanopay-x402") ? "true" : undefined),
  );
  return {
    api: (get("api") ?? process.env.PUBLIC_API_URL ?? "http://localhost:8080")
      .replace(/\/$/, ""),
    dashboard: (
      get("dashboard") ??
      process.env.PUBLIC_DASHBOARD_URL ??
      "http://127.0.0.1:5176"
    ).replace(/\/$/, ""),
    expectNanopayX402,
    nanopayPipelineId: get("nanopay-pipeline-id") ??
      process.env.VERIFY_NANOPAY_PIPELINE_ID,
    slug: get("slug") ?? process.env.VERIFY_SLUG ?? "murmur-momentum",
  };
}

function printHelp(): void {
  console.log(
    [
      "verify-deploy",
      "",
      "Checks the public Murmur daemon and dashboard deployment shape.",
      "",
      "Usage:",
      "  tsx tools/verify/verify-deploy.ts --api URL --dashboard URL --slug SLUG",
      "  tsx tools/verify/verify-deploy.ts --expect-nanopay-x402 true --nanopay-pipeline-id 0x...",
      "",
      "Env fallbacks:",
      "  PUBLIC_API_URL",
      "  PUBLIC_DASHBOARD_URL",
      "  VERIFY_SLUG",
      "  VERIFY_EXPECT_NANOPAY_X402",
      "  VERIFY_NANOPAY_PIPELINE_ID",
    ].join("\n"),
  );
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`invalid boolean: ${value}`);
}

async function main(): Promise<void> {
  if (process.argv.includes("-h") || process.argv.includes("--help")) {
    printHelp();
    return;
  }

  const args = parseArgs(process.argv.slice(2));
  console.log(renderDeployVerificationHeader(args));

  const checks = deployVerificationChecks(args);
  const results = [];
  for (const c of checks) {
    const r = await runDeployVerificationCheck({ check: c });
    results.push(r);
    console.log(formatDeployVerificationResult(r));
  }

  console.log(renderDeployVerificationSummary(results));
  process.exit(deployVerificationSummary(results).failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
