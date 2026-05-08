#!/usr/bin/env tsx
/**
 * Chainlink Base feed probe — validates the markets registry seed addresses
 * point at real AggregatorV3Interface contracts on Base mainnet and that
 * each feed describes the asset the registry claims it does.
 *
 * Mirrors the read-path in src/integrations/oracles/chainlink-evm.ts:
 *   - decimals()
 *   - latestRoundData()  → (roundId, answer, startedAt, updatedAt, answeredInRound)
 *   - rejects answer <= 0  (matches adapter's positivity check)
 *   - rejects updatedAt == 0 (matches adapter's missing_field check)
 *
 * Plus probes description() for asset-mismatch detection (the adapter does
 * not call description(); we use it here as the registry-vs-feed sanity gate).
 *
 * Usage:
 *   BASE_MAINNET_RPC_URL=https://... tsx tools/wiring/chainlink-probe.ts
 *
 * If BASE_MAINNET_RPC_URL is unset we fall back to https://mainnet.base.org
 * (Coinbase public node). Document which endpoint was used; rate limits and
 * eth_call quirks differ across providers.
 *
 * Exit codes: 0 if all 3 feeds returned sensible data and asset descriptions
 * line up with the registry seed; 1 otherwise.
 */

import { createPublicClient, http } from "viem";
import { base } from "viem/chains";

interface SeededFeed {
  oracle_id: string;
  address: `0x${string}`;
  expected_asset: string; // canonical asset id, e.g. "ETH/USD"
  expected_descriptions: RegExp[]; // one of these must match description()
  status: "listed" | "draft" | "frozen" | "retired";
}

const SEEDED_FEEDS: SeededFeed[] = [
  {
    oracle_id: "chainlink-base-eth-usd",
    address: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70",
    expected_asset: "ETH/USD",
    expected_descriptions: [/ETH\s*\/\s*USD/i],
    status: "listed",
  },
  {
    oracle_id: "chainlink-base-btc-usd",
    address: "0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F",
    expected_asset: "BTC/USD",
    expected_descriptions: [/BTC\s*\/\s*USD/i, /WBTC\s*\/\s*USD/i],
    status: "draft",
  },
  {
    oracle_id: "chainlink-base-sol-usd",
    address: "0x975043adBb80fc32276CbF9Bbcfd4A601a12462D",
    expected_asset: "SOL/USD",
    expected_descriptions: [/SOL\s*\/\s*USD/i],
    status: "draft",
  },
];

const AGGREGATOR_V3_ABI = [
  {
    inputs: [],
    name: "latestRoundData",
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "decimals",
    outputs: [{ name: "", type: "uint8" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "description",
    outputs: [{ name: "", type: "string" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "version",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const PUBLIC_BASE_FALLBACK = "https://mainnet.base.org";

const ANSI = {
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  reset: "\x1b[0m",
};

interface FeedReport {
  oracle_id: string;
  address: `0x${string}`;
  ok: boolean;
  warnings: string[];
  errors: string[];
  decimals?: number;
  description?: string;
  latestRound?: {
    roundId: string;
    answer: string; // raw int256 as string
    price: string; // formatted decimal
    updatedAt: number; // unix seconds
    staleness_sec: number;
  };
  matches_expected_asset?: boolean;
  registry_status: SeededFeed["status"];
  expected_asset: string;
}

async function probeOne(
  client: ReturnType<typeof createPublicClient>,
  feed: SeededFeed,
  nowSec: number,
): Promise<FeedReport> {
  const report: FeedReport = {
    oracle_id: feed.oracle_id,
    address: feed.address,
    ok: false,
    warnings: [],
    errors: [],
    registry_status: feed.status,
    expected_asset: feed.expected_asset,
  };

  // 1. decimals()
  let decimals: number;
  try {
    const d = (await client.readContract({
      address: feed.address,
      abi: AGGREGATOR_V3_ABI,
      functionName: "decimals",
    })) as number;
    decimals = Number(d);
    report.decimals = decimals;
    if (decimals !== 8) {
      report.warnings.push(
        `decimals=${decimals} (Chainlink USD pairs are conventionally 8; non-8 means downstream formatting may surprise integrators)`,
      );
    }
  } catch (err) {
    report.errors.push(`decimals() reverted: ${errMsg(err)}`);
    return report;
  }

  // 2. description()
  try {
    const desc = (await client.readContract({
      address: feed.address,
      abi: AGGREGATOR_V3_ABI,
      functionName: "description",
    })) as string;
    report.description = desc;
    const matches = feed.expected_descriptions.some((rx) => rx.test(desc));
    report.matches_expected_asset = matches;
    if (!matches) {
      report.errors.push(
        `description="${desc}" does NOT match expected asset ${feed.expected_asset} ` +
          `(patterns: ${feed.expected_descriptions.map((r) => r.source).join(", ")})`,
      );
    }
  } catch (err) {
    report.errors.push(`description() reverted: ${errMsg(err)}`);
    // continue — description failure is informational but feed may still be sane
  }

  // 3. latestRoundData() — match adapter's exact validation
  try {
    const result = (await client.readContract({
      address: feed.address,
      abi: AGGREGATOR_V3_ABI,
      functionName: "latestRoundData",
    })) as readonly [bigint, bigint, bigint, bigint, bigint];
    const [roundId, answer, , updatedAt] = result;

    if (answer <= 0n) {
      report.errors.push(
        `latestRoundData.answer=${answer} (adapter rejects answer<=0 as missing_field)`,
      );
      return report;
    }
    if (updatedAt === 0n) {
      report.errors.push(
        `latestRoundData.updatedAt=0 (adapter rejects this as missing_field)`,
      );
      return report;
    }

    const updatedSec = Number(updatedAt);
    const staleness = Math.max(0, nowSec - updatedSec);
    report.latestRound = {
      roundId: `0x${roundId.toString(16)}`,
      answer: answer.toString(),
      price: formatFixed(answer, decimals),
      updatedAt: updatedSec,
      staleness_sec: staleness,
    };

    // Operator advisory thresholds (the adapter itself trusts T0Policy
    // staleness windows; here we just yell if a feed is wildly stale).
    if (staleness > 24 * 3600) {
      report.errors.push(
        `staleness=${staleness}s (>24h — feed appears abandoned or RPC clock is wrong)`,
      );
      return report;
    }
    if (staleness > 3600) {
      report.warnings.push(
        `staleness=${staleness}s (>1h — verify against asset's deviation threshold; Chainlink Base USD heartbeats are typically 24h-86400s but movement triggers faster updates)`,
      );
    }
  } catch (err) {
    report.errors.push(`latestRoundData() reverted: ${errMsg(err)}`);
    return report;
  }

  report.ok = report.errors.length === 0;
  return report;
}

function formatFixed(value: bigint, decimals: number): string {
  const neg = value < 0n;
  const abs = neg ? -value : value;
  const s = abs.toString().padStart(decimals + 1, "0");
  const cut = s.length - decimals;
  const intPart = s.slice(0, cut);
  const fracPart = s.slice(cut).replace(/0+$/, "");
  const out = fracPart.length > 0 ? `${intPart}.${fracPart}` : intPart;
  return neg ? `-${out}` : out;
}

function errMsg(err: unknown): string {
  if (err instanceof Error) {
    // viem error objects have a `shortMessage` we'd prefer when present
    const sm = (err as { shortMessage?: string }).shortMessage;
    return sm ?? err.message;
  }
  return String(err);
}

function fmtUnix(sec: number): string {
  return new Date(sec * 1000).toISOString().replace(/\.\d+Z$/, "Z");
}

function printReport(rpcUrl: string, reports: FeedReport[]): void {
  const out: string[] = [];
  out.push("");
  out.push(`${ANSI.bold}Chainlink Base feed probe${ANSI.reset}`);
  out.push(`${ANSI.dim}RPC:${ANSI.reset} ${rpcUrl}`);
  out.push(`${ANSI.dim}Probed at:${ANSI.reset} ${new Date().toISOString()}`);
  out.push("");

  for (const r of reports) {
    const tag = r.ok
      ? `${ANSI.green}PASS${ANSI.reset}`
      : `${ANSI.red}FAIL${ANSI.reset}`;
    out.push(`${tag}  ${ANSI.bold}${r.oracle_id}${ANSI.reset}  ${r.address}`);
    out.push(
      `      registry_status=${r.registry_status}  expected_asset=${r.expected_asset}`,
    );
    if (r.description !== undefined) {
      const matchTag =
        r.matches_expected_asset === true
          ? `${ANSI.green}MATCHES_EXPECTED_ASSET=yes${ANSI.reset}`
          : r.matches_expected_asset === false
            ? `${ANSI.red}MATCHES_EXPECTED_ASSET=no${ANSI.reset}`
            : `${ANSI.yellow}MATCHES_EXPECTED_ASSET=?${ANSI.reset}`;
      out.push(`      description="${r.description}"  ${matchTag}`);
    }
    if (r.decimals !== undefined) {
      out.push(`      decimals=${r.decimals}`);
    }
    if (r.latestRound) {
      const lr = r.latestRound;
      out.push(
        `      price=${lr.price}  staleness=${lr.staleness_sec}s  updatedAt=${fmtUnix(lr.updatedAt)}  roundId=${lr.roundId}`,
      );
    }
    for (const w of r.warnings) {
      out.push(`      ${ANSI.yellow}warn:${ANSI.reset} ${w}`);
    }
    for (const e of r.errors) {
      out.push(`      ${ANSI.red}err:${ANSI.reset}  ${e}`);
    }
    out.push("");
  }

  const passes = reports.filter((r) => r.ok).length;
  const total = reports.length;
  const sumColor =
    passes === total ? ANSI.green : passes === 0 ? ANSI.red : ANSI.yellow;
  out.push(
    `${sumColor}${passes}/${total} feeds passed${ANSI.reset}`,
  );
  out.push("");
  process.stdout.write(out.join("\n"));
}

async function probeOracleClientPath(rpcUrl: string): Promise<void> {
  // Read-only smoke through the actual resolver code path. Imports the same
  // OracleClient the resolver uses; calls getLatestPrice exactly as the live
  // resolver tick does (modulo DB writes).
  const { OracleClient } = await import("../../src/integrations/oracle.js");
  const client = new OracleClient({
    baseRpcUrl: rpcUrl,
    chainlinkEthUsdAddress:
      "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70",
  });

  process.stdout.write(
    `${ANSI.bold}OracleClient.getLatestPrice("chainlink:base:ETH-USD") smoke${ANSI.reset}\n`,
  );
  try {
    const obs = await client.getLatestPrice("chainlink:base:ETH-USD");
    process.stdout.write(
      `${ANSI.green}  OK${ANSI.reset}  price=${obs.price} feed_ts=${obs.feed_timestamp} age=${obs.source_age_seconds}s source_id=${obs.source_id}\n\n`,
    );
  } catch (err) {
    process.stdout.write(
      `${ANSI.red}  FAIL${ANSI.reset}  ${errMsg(err)}\n\n`,
    );
    throw err;
  }
}

async function main(): Promise<void> {
  const envRpc = process.env.BASE_MAINNET_RPC_URL?.trim();
  const rpcUrl = envRpc && envRpc.length > 0 ? envRpc : PUBLIC_BASE_FALLBACK;
  if (!envRpc) {
    process.stdout.write(
      `${ANSI.dim}BASE_MAINNET_RPC_URL unset; using public Coinbase node ${PUBLIC_BASE_FALLBACK}${ANSI.reset}\n`,
    );
  }

  const client = createPublicClient({
    chain: base,
    transport: http(rpcUrl, { timeout: 10_000 }),
  });

  const nowSec = Math.floor(Date.now() / 1000);
  const reports: FeedReport[] = [];
  for (const feed of SEEDED_FEEDS) {
    // sequential; rate-limited public RPCs hate parallel multicalls
    const r = await probeOne(client, feed, nowSec);
    reports.push(r);
  }

  printReport(rpcUrl, reports);

  // Step 4: smoke the actual OracleClient — the resolver's read path.
  try {
    await probeOracleClientPath(rpcUrl);
  } catch {
    // already logged; downgrade to soft-fail since direct probes are the
    // primary gate. main() exit code below uses direct probes.
  }

  const allOk = reports.every((r) => r.ok);
  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`probe crashed: ${errMsg(err)}\n`);
  if (err instanceof Error && err.stack) {
    process.stderr.write(err.stack + "\n");
  }
  process.exit(1);
});
