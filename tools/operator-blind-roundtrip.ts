#!/usr/bin/env tsx
/**
 * Operator-blind FHE round-trip release gate: runs one sealed call on live Arbitrum Sepolia and asserts
 * the daemon API response and dashboard DOM stay opaque until publishReveal lands.
 * Checks HTTP and DOM only, not stored state; the verdict is sealed in this process and the daemon only ever relays ciphertext.
 * Run `tsx tools/operator-blind-roundtrip.ts` after tools/seed-operator-blind-fixtures.ts. No mocks.
 */

import "dotenv/config";
import { mkdirSync } from "node:fs";
import { dirname, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  http,
  getAddress,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { deriveAddressFromKey } from "../src/integrations/derived-addresses.js";
import {
  AGENT_GATEWAY_PATH,
  buildAgentSealedCallBody,
} from "../src/integrations/agent-side-cofhe-sealer-support.js";
import type { GatewaySealedCallBody } from "../src/integrations/fhenix-gateway-schemas.js";
import { fetchMeta, sealVerdict } from "./agent-side-cofhe-sealer.js";
import { arbitrumSepolia } from "viem/chains";

import { createCofheClient, createCofheConfig } from "@cofhe/sdk/node";
import { arbSepolia as cofheArbitrumSepolia } from "@cofhe/sdk/chains";
import { ACPUtils } from "@cofhe/sdk/acps";
import type { ACP } from "@cofhe/sdk/acps";

import { loadDeployment } from "../src/integrations/deployments.js";
import {
  OPERATOR_BLIND_DEFAULT_MARKET_ID as DEFAULT_OPERATOR_BLIND_MARKET_ID,
  OPERATOR_BLIND_FHENIX_REVEALED_SUBOBJECT_KEY as FHENIX_REVEALED_SUBOBJECT_KEY,
  OPERATOR_BLIND_FHENIX_SEALED_HANDLE_KEYS as FHENIX_SEALED_HANDLE_KEYS,
  OPERATOR_BLIND_ROUNDTRIP_CHAIN_ID as CHAIN_ID,
  OperatorBlindRoundtripError,
  assertOperatorBlindDashboardPostRevealText,
  assertOperatorBlindDashboardPreRevealText,
  assertOperatorBlindRevealSnapshotPlaintext,
  assertOperatorBlindSealedSnapshotOpaque,
  makeOperatorBlindClientNonce,
  operatorBlindClientOrderId,
  operatorBlindSentinelTextForms as sentinelTextForms,
  startOperatorBlindRoundtrip,
} from "../src/verdict/operator-blind-roundtrip-surface.js";

// Chromium is installed separately: `npx playwright install chromium`.
import { chromium, type Browser, type Page } from "playwright";

// ── pinned constants ──────────────────────────────────────────────────────
const POLL_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 5_000;
const GATEWAY_ACCEPT_TIMEOUT_MS = 5 * 60 * 1000;
const THRESHOLD_NETWORK_URL = "https://testnet-cofhe-tn.fhenix.zone";
const INDEXER_LAG_BUDGET_MS = 60 * 1000;
const INDEXER_POLL_INTERVAL_MS = 3_000;
const SNAPSHOT_GRACE_MS = 10_000;

// ── ANSI helpers (same palette as tools/verify/verify-deploy.ts) ─────────
const ANSI = {
  green: "\x1b[32m",
  red: "\x1b[31m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  reset: "\x1b[0m",
};
const log = (s: string) => console.log(`[operator-blind] ${s}`);
const ok = (s: string) => log(`${ANSI.green}ok${ANSI.reset}    ${s}`);
const fail = (s: string) => log(`${ANSI.red}FAIL${ANSI.reset}  ${s}`);

function printHelp(): void {
  console.log(
    [
      "operator-blind-roundtrip",
      "",
      "Runs the live operator-blind FHE round-trip release gate.",
      "",
      "Required env:",
      "  ARBITRUM_RPC_URL",
      "  FHENIX_GATEWAY_RELAYER_PRIVATE_KEY",
      "  OPERATOR_BLIND_RUNTIME_KEY",
      "  DAEMON_URL",
      "  DASHBOARD_URL",
      "",
      "Optional env:",
      "  OPERATOR_BLIND_MARKET_ID",
    ].join("\n"),
  );
}

// ── failure helper. Prints the offending excerpt + exits 1. No retries. ──
function die(label: string, detail: string, excerpt?: unknown): never {
  fail(`${label}: ${detail}`);
  if (excerpt !== undefined) {
    const rendered =
      typeof excerpt === "string"
        ? excerpt
        : JSON.stringify(excerpt, null, 2);
    const truncated = rendered.length > 4000 ? rendered.slice(0, 4000) + "\n…[truncated]" : rendered;
    console.log(`${ANSI.dim}excerpt:${ANSI.reset}\n${truncated}`);
  }
  process.exit(1);
}

function fromSurface<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof OperatorBlindRoundtripError) {
      die(err.phase, err.detail, err.excerpt);
    }
    throw err;
  }
}

// ── env-var pre-flight; any missing required var aborts. ──────
interface PreflightEnv {
  arbitrumRpcUrl: string;
  relayerKey: Hex;
  runtimeKey: string;
  daemonUrl: string;
  dashboardUrl: string;
  agentAddress: Address;
  marketId: Hex;
  marketProtocol: string;
}

function preflightEnv(): PreflightEnv {
  const arbitrumRpcUrl = (process.env.ARBITRUM_RPC_URL ?? "").trim();
  if (!arbitrumRpcUrl) die("pre-flight", "ARBITRUM_RPC_URL is required");
  const relayerKeyRaw = (process.env.FHENIX_GATEWAY_RELAYER_PRIVATE_KEY ?? "").trim();
  if (!relayerKeyRaw) die("pre-flight", "FHENIX_GATEWAY_RELAYER_PRIVATE_KEY is required");
  if (!/^0x[0-9a-fA-F]{64}$/.test(relayerKeyRaw)) {
    die("pre-flight", "FHENIX_GATEWAY_RELAYER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex");
  }
  const runtimeKey = (process.env.OPERATOR_BLIND_RUNTIME_KEY ?? "").trim();
  if (!runtimeKey) {
    die(
      "pre-flight",
      "OPERATOR_BLIND_RUNTIME_KEY is required; run tools/seed-operator-blind-fixtures.ts and export the printed runtime_key_secret",
    );
  }
  const daemonUrl = (process.env.DAEMON_URL ?? "").trim().replace(/\/$/, "");
  if (!daemonUrl) die("pre-flight", "DAEMON_URL is required (e.g. http://localhost:8080)");
  const dashboardUrl = (process.env.DASHBOARD_URL ?? "").trim().replace(/\/$/, "");
  if (!dashboardUrl) die("pre-flight", "DASHBOARD_URL is required (e.g. http://localhost:5173)");

  const relayerKey = relayerKeyRaw as Hex;
  // Derived from the relayer key; AGENT_ADDRESS is optional and, if set, must agree.
  const agentRaw = deriveAddressFromKey({
    privateKey: relayerKeyRaw,
    configured: process.env.AGENT_ADDRESS,
    configuredName: "AGENT_ADDRESS",
    keyName: "FHENIX_GATEWAY_RELAYER_PRIVATE_KEY",
  });
  let agentAddress: Address;
  try {
    agentAddress = getAddress(agentRaw);
  } catch {
    die("pre-flight", `AGENT_ADDRESS "${agentRaw}" is not a valid checksummed address`);
  }
  const marketRaw = (process.env.OPERATOR_BLIND_MARKET_ID ?? DEFAULT_OPERATOR_BLIND_MARKET_ID).trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(marketRaw)) {
    die("pre-flight", "OPERATOR_BLIND_MARKET_ID must be a 0x-prefixed bytes32 market id");
  }
  const marketId = marketRaw.toLowerCase() as Hex;
  // marketRef.protocol must match the daemon market's adapter_id; default is the seeded fixture's.
  const marketProtocol =
    (process.env.OPERATOR_BLIND_MARKET_PROTOCOL ?? "polymarket-gamma").trim();

  return { arbitrumRpcUrl, relayerKey, runtimeKey, daemonUrl, dashboardUrl, agentAddress, marketId, marketProtocol };
}

async function probeUrl(label: string, url: string, expectStatuses: number[] = [200]): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url, { method: "GET" });
  } catch (err) {
    die("pre-flight", `${label} unreachable at ${url} (${(err as Error).message})`);
  }
  if (!expectStatuses.includes(res.status)) {
    die(
      "pre-flight",
      `${label} at ${url} returned status ${res.status}; expected one of [${expectStatuses.join(", ")}]`,
    );
  }
}

// ── minimal contract ABI (subset of live-smoke's) ─────────────────────────
const ABI = parseAbi([
  "function openReveal(bytes32 callId)",
  "function publishReveal(bytes32 callId, uint8 binaryIndex, uint16 confidenceBps, bytes binaryIndexSignature, bytes confidenceSignature)",
  "function getCall(bytes32 callId) view returns (address agent, bytes32 marketId, uint64 acceptedAt, bytes32 binaryIndexCtHash, bytes32 confidenceCtHash, uint8 revealedBinaryIndex, uint16 revealedConfidenceBps, uint8 state)",
  "function callPublicRevealAt(bytes32 callId) view returns (uint64)",
  // Read to wait for the submission window in main().
  "function markets(bytes32 marketId) view returns (uint64 armCloseAt, uint64 submissionOpenAt, uint64 earlyAccessCutoffAt, uint64 submissionCloseAt, uint64 resolutionAt, uint64 publicRevealAt, bool active)",
]);

// Unused (main uses decryptForTx). Direct threshold /decrypt call that keeps the signature.
// The `permit` field is unverified against the 0.7 threshold network.
async function fetchDecryptWithSignature(
  ctHashBigint: bigint,
  acp: ACP,
): Promise<{ decrypted: bigint; signature: Hex }> {
  const ct_tempkey = ctHashBigint.toString(16).padStart(64, "0");
  // Threshold network expects the ACP's public projection.
  const permissionPayload = ACPUtils.getPublic(acp, true);
  const body = JSON.stringify({
    ct_tempkey,
    host_chain_id: CHAIN_ID,
    permit: permissionPayload,
  });
  const res = await fetch(`${THRESHOLD_NETWORK_URL}/decrypt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  const data = (await res.json()) as {
    decrypted?: number[];
    signature?: string;
    encryption_type?: number;
    error_message?: string;
  };
  if (data.error_message) throw new Error(`threshold /decrypt error: ${data.error_message}`);
  if (!data.decrypted || !data.signature) {
    throw new Error(`threshold /decrypt missing fields: ${JSON.stringify(data)}`);
  }
  const decrypted = BigInt("0x" + Buffer.from(data.decrypted).toString("hex") || "0");
  const signature = data.signature.startsWith("0x")
    ? (data.signature as Hex)
    : (`0x${data.signature}` as Hex);
  return { decrypted, signature };
}

async function pollDecrypt(
  label: string,
  ctHashBigint: bigint,
  acp: ACP,
): Promise<{ decrypted: bigint; signature: Hex }> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    try {
      const result = await fetchDecryptWithSignature(ctHashBigint, acp);
      if (result.signature && result.signature !== "0x" && result.signature.length > 4) {
        log(`${label} decrypted after ${attempt} poll(s)`);
        return result;
      }
      log(`polling ${label} (attempt=${attempt}, no signature yet)…`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`polling ${label} (attempt=${attempt}, ${msg})…`);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`timed out polling ${label} after ${attempt} attempts`);
}

interface GatewayCallResponse {
  attempt_id: string;
  status: string;
  tx_hash: string | null;
  call_id: string | null;
  next_attempt_at: string;
  idempotent_hit: boolean;
}

async function postGatewayCall(
  gatewayUrl: string,
  runtimeKey: string,
  body: GatewaySealedCallBody,
): Promise<GatewayCallResponse> {
  const res = await fetch(gatewayUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Murmur-Runtime-Key": runtimeKey,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    die("gateway-submit", `daemon returned non-JSON status ${res.status}`, text);
  }
  if (res.status !== 200 && res.status !== 202) {
    die("gateway-submit", `POST ${gatewayUrl} returned ${res.status}`, json);
  }
  const out = json as Partial<GatewayCallResponse>;
  if (
    typeof out.attempt_id !== "string" ||
    typeof out.status !== "string" ||
    !("call_id" in out)
  ) {
    die("gateway-submit", "response shape did not match GatewaySubmitResult", json);
  }
  return {
    attempt_id: out.attempt_id,
    status: out.status,
    tx_hash: typeof out.tx_hash === "string" ? out.tx_hash : null,
    call_id: typeof out.call_id === "string" ? out.call_id : null,
    next_attempt_at: typeof out.next_attempt_at === "string" ? out.next_attempt_at : "",
    idempotent_hit: out.idempotent_hit === true,
  };
}

async function submitGatewayCallAndWaitForAccepted(
  gatewayUrl: string,
  runtimeKey: string,
  body: GatewaySealedCallBody,
): Promise<GatewayCallResponse & { call_id: string }> {
  const deadline = Date.now() + GATEWAY_ACCEPT_TIMEOUT_MS;
  let attempt = 0;
  let last: GatewayCallResponse | null = null;
  while (Date.now() < deadline) {
    attempt++;
    last = await postGatewayCall(gatewayUrl, runtimeKey, body);
    if (last.call_id && last.status === "accepted") {
      log(`gateway accepted after ${attempt} poll(s): call_id=${last.call_id}`);
      return { ...last, call_id: last.call_id };
    }
    if (last.status === "failed_terminal") {
      die("gateway-submit", "gateway attempt failed terminally", last);
    }
    log(`waiting for gateway acceptance (attempt=${attempt}, status=${last.status}, tx=${last.tx_hash ?? "n/a"})…`);
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  die(
    "gateway-submit",
    `timed out waiting for accepted/call_id after ${GATEWAY_ACCEPT_TIMEOUT_MS / 1000}s`,
    last ?? undefined,
  );
}

// Waits for the call with both ctHashes indexed; a timeout is an indexer-lag failure, not a privacy pass.
async function waitForIndexedSealedCall(
  daemonUrl: string,
  callId: string,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + INDEXER_LAG_BUDGET_MS;
  let lastStatus: number | null = null;
  let lastBody: string | null = null;
  while (Date.now() < deadline) {
    let res: Response;
    try {
      res = await fetch(`${daemonUrl}/v1/calls/${encodeURIComponent(callId)}`);
    } catch (err) {
      lastBody = (err as Error).message;
      await new Promise((r) => setTimeout(r, INDEXER_POLL_INTERVAL_MS));
      continue;
    }
    lastStatus = res.status;
    if (res.status === 200) {
      const json = (await res.json()) as Record<string, unknown>;
      const fhenix = (json["fhenix"] ?? null) as Record<string, unknown> | null;
      if (
        fhenix &&
        typeof fhenix[FHENIX_SEALED_HANDLE_KEYS.binaryIndexCtHash] === "string" &&
        typeof fhenix[FHENIX_SEALED_HANDLE_KEYS.confidenceCtHash] === "string"
      ) {
        return json;
      }
      lastBody = JSON.stringify(json).slice(0, 2000);
    } else if (res.status !== 404) {
      lastBody = await res.text().catch(() => "<read-failed>");
    }
    await new Promise((r) => setTimeout(r, INDEXER_POLL_INTERVAL_MS));
  }
  die(
    "indexer-lag",
    `daemon ${daemonUrl}/v1/calls/${callId} never produced both sealed ctHash fields within ${
      INDEXER_LAG_BUDGET_MS / 1000
    }s (last status=${lastStatus ?? "n/a"})`,
    lastBody ?? undefined,
  );
}

// Waits for the revealed sub-object after publish; same bound as waitForIndexedSealedCall.
async function waitForIndexedReveal(
  daemonUrl: string,
  callId: string,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + INDEXER_LAG_BUDGET_MS;
  let lastBody: string | null = null;
  while (Date.now() < deadline) {
    let res: Response;
    try {
      res = await fetch(`${daemonUrl}/v1/calls/${encodeURIComponent(callId)}`);
    } catch (err) {
      lastBody = (err as Error).message;
      await new Promise((r) => setTimeout(r, INDEXER_POLL_INTERVAL_MS));
      continue;
    }
    if (res.status === 200) {
      const json = (await res.json()) as Record<string, unknown>;
      const fhenix = (json["fhenix"] ?? null) as Record<string, unknown> | null;
      const revealed = fhenix
        ? (fhenix[FHENIX_REVEALED_SUBOBJECT_KEY] as Record<string, unknown> | undefined)
        : undefined;
      if (revealed && typeof revealed === "object") {
        return json;
      }
      lastBody = JSON.stringify(json).slice(0, 2000);
    } else {
      lastBody = await res.text().catch(() => "<read-failed>");
    }
    await new Promise((r) => setTimeout(r, INDEXER_POLL_INTERVAL_MS));
  }
  die(
    "indexer-lag",
    `daemon never surfaced fhenix.${FHENIX_REVEALED_SUBOBJECT_KEY} after publishReveal landed within ${
      INDEXER_LAG_BUDGET_MS / 1000
    }s`,
    lastBody ?? undefined,
  );
}

// ── main ──────────────────────────────────────────────────────────────────
async function main() {
  if (process.argv.includes("-h") || process.argv.includes("--help")) {
    printHelp();
    return;
  }

  // 0. pre-flight
  const env = preflightEnv();
  const run = fromSurface(() =>
    startOperatorBlindRoundtrip({ nowMs: () => Date.now() }),
  );
  const startMs = run.startedAtMs;
  const runId = run.runId;
  const sentinelConfidence = run.sentinelConfidence;
  const sentinelBinaryIndex = run.sentinelBinaryIndex;
  log(`runId=${runId} sentinelConfidence=${sentinelConfidence} sentinelBinaryIndex=${sentinelBinaryIndex}`);

  log(`probing DAEMON_URL=${env.daemonUrl}/v1/health`);
  await probeUrl("DAEMON_URL", `${env.daemonUrl}/v1/health`);
  log(`probing DASHBOARD_URL=${env.dashboardUrl}/`);
  await probeUrl("DASHBOARD_URL", `${env.dashboardUrl}/`);
  ok("pre-flight: env + daemon + dashboard reachable");

  // ── deployment manifest lookup
  const sealedDeploy = loadDeployment(CHAIN_ID, "MurmurSealedVerdicts");
  if (!sealedDeploy) {
    die(
      "pre-flight",
      `MurmurSealedVerdicts not in data/deployments.json for chain ${CHAIN_ID}; run sync-deployments first`,
    );
  }
  const contractAddress = getAddress(sealedDeploy.address);
  log(`MurmurSealedVerdicts @ ${contractAddress}`);

  // ── viem clients
  const account = privateKeyToAccount(env.relayerKey);
  const publicClient = createPublicClient({ chain: arbitrumSepolia, transport: http(env.arbitrumRpcUrl) });
  const walletClient = createWalletClient({
    account,
    chain: arbitrumSepolia,
    transport: http(env.arbitrumRpcUrl),
  });

  // ── playwright browser
  let browser: Browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    die(
      "pre-flight",
      `playwright chromium failed to launch: ${(err as Error).message}. Did you run \`npx playwright install chromium\`?`,
    );
  }
  log("playwright chromium launched");

  // A fresh worktree may lack the screenshots dir.
  const screenshotDir = pathResolve(
    dirname(fileURLToPath(import.meta.url)),
    "operator-blind/screenshots",
  );
  mkdirSync(screenshotDir, { recursive: true });

  try {
    // 1. snapshot 0: the feed is readable and no call carries our runId yet.
    let baseline: Response;
    try {
      baseline = await fetch(`${env.daemonUrl}/v1/feed/today`);
    } catch (err) {
      die("snapshot-0", `daemon /v1/feed/today probe failed: ${(err as Error).message}`);
    }
    if (baseline.status !== 200) {
      die(
        "snapshot-0",
        `daemon /v1/feed/today returned ${baseline.status}; expected 200`,
        await baseline.text().catch(() => "<unreadable>"),
      );
    }
    const baselineText = await baseline.text();
    if (baselineText.includes(runId)) {
      die("snapshot-0", `runId ${runId} already appears in /v1/feed/today before submit`, baselineText);
    }
    ok("snapshot-0: baseline taken (daemon reachable, runId not present yet)");

    // 2. Gateway submit: this process seals the verdict; the daemon's broadcaster
    // sends submitSealedFor and never sees the sentinel values.
    const marketId = env.marketId;
    log(`using seeded gateway marketId=${marketId} agentAddress=${env.agentAddress}`);
    log(`initializing @cofhe/sdk client (chain=${CHAIN_ID})`);
    const cofheConfig = createCofheConfig({
      environment: "node",
      supportedChains: [cofheArbitrumSepolia],
    });
    const cofheClient = createCofheClient(cofheConfig);
    await cofheClient.connect(publicClient as never, walletClient as never);
    const selfAcp = await cofheClient.acp.createSelf({
      type: "self",
      issuer: account.address,
    });

    const clientNonce = makeOperatorBlindClientNonce({ runId });
    // Bind the proof to Murmur's PUBLISHED relayer and contract, read from
    // /v1/meta, exactly as an outside agent would.
    const sealTargets = await fetchMeta(env.daemonUrl);
    const sealedSentinel = await sealVerdict({
      binaryIndex: sentinelBinaryIndex,
      confidenceBps: sentinelConfidence,
      chainId: sealTargets.chainId,
      relayerAddress: sealTargets.relayerAddress,
      contractAddress: sealTargets.contractAddress,
      confidenceBounds: sealTargets.confidenceBounds,
      rpcUrl: env.arbitrumRpcUrl,
    });
    const gatewayBody: GatewaySealedCallBody = {
      ...buildAgentSealedCallBody({
        binaryInput: sealedSentinel.binary_index_input,
        confidenceInput: sealedSentinel.confidence_input,
        configVersion: 1,
        marketSourceId: marketId,
        clientNonce,
        clientOrderId: operatorBlindClientOrderId(runId, clientNonce),
        strategyTag: "release-gate",
      }),
      // The fixture market's protocol is configurable; keep the env value.
      marketRef: { protocol: env.marketProtocol, sourceId: marketId, configVersion: 1 },
    };
    const gatewayUrl = `${env.daemonUrl}${AGENT_GATEWAY_PATH}`;

    // Wait for the submission window: the contract reverts before submissionOpenAt and after submissionCloseAt.
    // Poll the schedule first; a lagging RPC replica can return an all-zero tuple right after seeding.
    const SCHEDULE_TIMEOUT_MS = 60_000;
    const scheduleDeadline = Date.now() + SCHEDULE_TIMEOUT_MS;
    let marketSchedule: readonly [bigint, bigint, bigint, bigint, bigint, bigint, boolean];
    for (;;) {
      marketSchedule = (await publicClient.readContract({
        address: contractAddress,
        abi: ABI,
        functionName: "markets",
        args: [marketId as Hex],
      })) as readonly [bigint, bigint, bigint, bigint, bigint, bigint, boolean];
      // publicRevealAt is nonzero for every registered market, so zero means not visible yet.
      if (marketSchedule[5] !== 0n) break;
      if (Date.now() > scheduleDeadline) {
        die(
          "gateway-submit",
          `market ${marketId} still reads as unregistered ${
            SCHEDULE_TIMEOUT_MS / 1000
          }s after seeding — re-run tools/seed-operator-blind-fixtures.ts`,
        );
      }
      log("market not visible on this RPC replica yet; retrying…");
      await new Promise((r) => setTimeout(r, 3_000));
    }
    const submissionOpenAt = Number(marketSchedule[1]);
    const submissionCloseAt = Number(marketSchedule[3]);
    while (Math.floor(Date.now() / 1000) < submissionOpenAt) {
      const wait = submissionOpenAt - Math.floor(Date.now() / 1000);
      log(`waiting ${wait}s for the submission window to open…`);
      await new Promise((r) => setTimeout(r, Math.min(5_000, wait * 1000)));
    }
    if (Math.floor(Date.now() / 1000) >= submissionCloseAt) {
      die(
        "gateway-submit",
        `the fixture market's submission window closed at ${submissionCloseAt} ` +
          `(now ${Math.floor(Date.now() / 1000)}). Re-run ` +
          `tools/seed-operator-blind-fixtures.ts immediately before this script.`,
      );
    }
    log(`POST ${AGENT_GATEWAY_PATH} marketId=${marketId} nonce=${clientNonce}`);
    const accepted = await submitGatewayCallAndWaitForAccepted(
      gatewayUrl,
      env.runtimeKey,
      gatewayBody,
    );
    const callId = accepted.call_id;
    ok(`gateway sealed call accepted (callId=${callId}, tx=${accepted.tx_hash ?? "pending"})`);

    // 3. snapshot 1 — give the daemon ~10s + bounded poll for indexer lag.
    log(`waiting ${SNAPSHOT_GRACE_MS / 1000}s + indexer poll for daemon call projection…`);
    await new Promise((r) => setTimeout(r, SNAPSHOT_GRACE_MS));
    const sealedSnapshot = await waitForIndexedSealedCall(env.daemonUrl, callId);

    // ── A1 — daemon opaque pre-reveal
    const { onchainCallId } = fromSurface(() =>
      assertOperatorBlindSealedSnapshotOpaque({
        snapshot: sealedSnapshot,
        sentinelConfidence,
      }),
    );
    ok(`A1: daemon opaque pre-reveal (ctHash handles present, no plaintext, no sentinel match)`);

    // ── A2 — dashboard masked pre-reveal
    const preUrl = `${env.dashboardUrl}/#/calls/${callId}`;
    log(`playwright goto ${preUrl}`);
    const prePage: Page = await browser.newPage();
    try {
      await prePage.goto(preUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
      // Wait for the sealed affordance (CallPage.tsx renders "sealed") before reading innerText.
      await prePage.waitForFunction(
        () => {
          const t = document.body?.innerText ?? "";
          return t.includes("sealed") || t.includes("fhenix sealed");
        },
        undefined,
        { timeout: 30_000 },
      );
      const preInnerText = await prePage.evaluate(() => document.body?.innerText ?? "");
      fromSurface(() =>
        assertOperatorBlindDashboardPreRevealText({
          innerText: preInnerText,
          sentinelConfidence,
        }),
      );
      const prePath = pathResolve(screenshotDir, `pre-${runId}.png`);
      await prePage.screenshot({ path: prePath, fullPage: true });
      ok(`A2: dashboard masked pre-reveal (sealed affordance present, no sentinel). screenshot=${prePath}`);
    } finally {
      await prePage.close();
    }

    // 4. contract steps: wait for reveal window, openReveal, decrypt, publishReveal.
    const revealOpenAt = await publicClient.readContract({
      address: contractAddress,
      abi: ABI,
      functionName: "callPublicRevealAt",
      args: [onchainCallId],
    } as never) as bigint;
    const maxWaitMs = 15 * 60 * 1000;
    const waitDeadline = Date.now() + maxWaitMs;
    log(`waiting for reveal window (revealOpenAt=${revealOpenAt})`);
    while (Math.floor(Date.now() / 1000) < Number(revealOpenAt)) {
      if (Date.now() > waitDeadline) throw new Error("timed out waiting for reveal window");
      const remaining = Number(revealOpenAt) - Math.floor(Date.now() / 1000);
      log(`${remaining}s until reveal window opens…`);
      await new Promise((r) => setTimeout(r, 5_000));
    }

    log(`openReveal onchainCallId=${onchainCallId}`);
    const openTx = await walletClient.writeContract({
      address: contractAddress,
      abi: ABI,
      functionName: "openReveal",
      args: [onchainCallId],
    } as never) as Hex;
    await publicClient.waitForTransactionReceipt({ hash: openTx });
    ok(`reveal opened (tx=${openTx})`);

    const callData = await publicClient.readContract({
      address: contractAddress,
      abi: ABI,
      functionName: "getCall",
      args: [onchainCallId],
    } as never) as readonly [Address, Hex, bigint, Hex, Hex, number, number, number];
    const binaryIndexCtHash = callData[3];
    const confidenceCtHash = callData[4];
    const binCtHashBigint = BigInt(binaryIndexCtHash);
    const confCtHashBigint = BigInt(confidenceCtHash);

    // Threshold network needs ~5-30s to observe openReveal's FHE.allowPublic; retry at a fixed interval.
    const decryptWithRetry = async (label: string, ctHash: bigint) => {
      const deadline = Date.now() + POLL_TIMEOUT_MS;
      let attempt = 0;
      while (Date.now() < deadline) {
        attempt++;
        try {
          return await cofheClient
            .decryptForTx(ctHash)
            .withACP(selfAcp as never)
            .execute();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (Date.now() + POLL_INTERVAL_MS > deadline) {
            throw new Error(`${label} timed out after ${attempt} attempt(s): ${msg}`);
          }
          log(`${label} attempt=${attempt} retrying after ${POLL_INTERVAL_MS / 1000}s (${msg})…`);
          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        }
      }
      throw new Error(`${label} timed out (no attempts succeeded)`);
    };

    log(`decryptForTx binaryIndex (ctHash=${binCtHashBigint})`);
    const binDecrypt = await decryptWithRetry("binaryIndex decryptForTx", binCtHashBigint);
    log(`decryptForTx confidenceBps (ctHash=${confCtHashBigint})`);
    const confDecrypt = await decryptWithRetry("confidenceBps decryptForTx", confCtHashBigint);
    if (Number(binDecrypt.decryptedValue) !== sentinelBinaryIndex) {
      die(
        "decrypt",
        `binaryIndex plaintext mismatch — expected ${sentinelBinaryIndex} got ${binDecrypt.decryptedValue}`,
      );
    }
    if (Number(confDecrypt.decryptedValue) !== sentinelConfidence) {
      die(
        "decrypt",
        `confidenceBps plaintext mismatch — expected ${sentinelConfidence} got ${confDecrypt.decryptedValue}`,
      );
    }
    log(`decrypted ok: binaryIndex=${binDecrypt.decryptedValue} confidenceBps=${confDecrypt.decryptedValue}`);

    log(`publishReveal onchainCallId=${onchainCallId}`);
    const publishTx = await walletClient.writeContract({
      address: contractAddress,
      abi: ABI,
      functionName: "publishReveal",
      args: [
        onchainCallId,
        Number(binDecrypt.decryptedValue),
        Number(confDecrypt.decryptedValue),
        binDecrypt.signature,
        confDecrypt.signature,
      ],
    } as never) as Hex;
    await publicClient.waitForTransactionReceipt({ hash: publishTx });
    ok(`verdict revealed (tx=${publishTx})`);

    // 5. snapshot 2 — A3, daemon + DOM carry plaintext post-publish.
    log(`waiting ${SNAPSHOT_GRACE_MS / 1000}s + indexer poll for daemon to index VerdictRevealed…`);
    await new Promise((r) => setTimeout(r, SNAPSHOT_GRACE_MS));
    const revealedSnapshot = await waitForIndexedReveal(env.daemonUrl, callId);

    fromSurface(() =>
      assertOperatorBlindRevealSnapshotPlaintext({
        snapshot: revealedSnapshot,
        sentinelBinaryIndex,
        sentinelConfidence,
        publishTx,
      }),
    );
    ok(`A3 (daemon): fhenix.${FHENIX_REVEALED_SUBOBJECT_KEY} populated with both spec-pinned plaintext fields`);

    // ── A3 dashboard: load the page fresh and assert the sentinel renders.
    const postUrl = `${env.dashboardUrl}/#/calls/${callId}`;
    log(`playwright goto ${postUrl} (post-publish render)`);
    const postPage: Page = await browser.newPage();
    try {
      await postPage.goto(postUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
      // Accept any sentinel form (raw "7531" or percent "75.31%") so either render passes.
      const postForms = sentinelTextForms(sentinelConfidence);
      await postPage.waitForFunction(
        (forms) => {
          const t = document.body?.innerText ?? "";
          return forms.some((f) => t.includes(f));
        },
        postForms,
        { timeout: 30_000 },
      ).catch(() => {
        /* fall through — innerText snapshot below produces the diagnostic */
      });
      const postInnerText = await postPage.evaluate(() => document.body?.innerText ?? "");
      const { hitForm: postHitForm, forms: postHitForms } = fromSurface(() =>
        assertOperatorBlindDashboardPostRevealText({
          innerText: postInnerText,
          sentinelConfidence,
        }),
      );
      const postPath = pathResolve(screenshotDir, `post-${runId}.png`);
      await postPage.screenshot({ path: postPath, fullPage: true });
      ok(`A3 (dashboard): DOM carries confidence sentinel "${postHitForm}" (scanned raw=${postHitForms[0]}, percent=${postHitForms[1]}). screenshot=${postPath}`);
    } finally {
      await postPage.close();
    }

    const elapsedSec = ((Date.now() - startMs) / 1000).toFixed(1);
    console.log("");
    console.log(`${ANSI.green}${ANSI.bold}[operator-blind] PASS${ANSI.reset} runId=${runId} callId=${callId} onchainCallId=${onchainCallId} elapsed=${elapsedSec}s`);
    console.log(`${ANSI.dim}  txs: gateway_submit=${accepted.tx_hash ?? "n/a"} open=${openTx} publish=${publishTx}${ANSI.reset}`);
  } finally {
    await browser.close().catch(() => undefined);
  }
}

main().catch((err) => {
  console.error(`${ANSI.red}[operator-blind] FAILED:${ANSI.reset}`, err);
  process.exit(1);
});
