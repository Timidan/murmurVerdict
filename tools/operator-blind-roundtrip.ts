#!/usr/bin/env tsx
/**
 * Operator-blind FHE round-trip — release-gate script.
 *
 * Drives one full sealed-call lifecycle against the live Base Sepolia
 * deployment of MurmurSealedVerdicts AND asserts that the local daemon's
 * stored state + the local dashboard's rendered state stay opaque until
 * publishReveal lands. This is the runtime counterpart to the Lean V1 / V2
 * theorems: V1 + V2 prove the contract can't leak plaintext early; this
 * script proves the rest of the stack can't either.
 *
 * Five phases:
 *   0. pre-flight — env vars present, daemon + dashboard reachable.
 *   1. snapshot 0 — baseline of the daemon DB before any new call.
 *   2. snapshot 1 — submit sealed call, then assert daemon (A1) + DOM (A2)
 *      are opaque pre-reveal.
 *   3. contract steps — wait for reveal window, openReveal, poll cofhejs
 *      threshold network for plaintext + signatures, publishReveal.
 *   4. snapshot 2 — assert daemon + DOM (A3) carry plaintext post-publish.
 *
 * Invocation: `tsx tools/operator-blind-roundtrip.ts`. There is intentionally
 * no `npm run` shortcut (spec §8). Exit 0 on full PASS; non-zero with the
 * offending excerpt printed on any assertion failure.
 *
 * Develop-as-prod: no mocks, no fixtures. If the live RPC, local daemon, or
 * local dashboard isn't available, this script fails fast with a clear
 * diagnostic — it never falls back to a fake.
 *
 * Spec: docs/superpowers/specs/2026-05-19-operator-blind-roundtrip-design.md
 * Sibling smoke (contract steps): src/integrations/murmur-sealed-verdicts.live-smoke.ts
 */

import "dotenv/config";
import { strict as assert } from "node:assert";
import { mkdirSync } from "node:fs";
import { dirname, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import {
  createPublicClient,
  createWalletClient,
  http,
  getAddress,
  parseAbi,
  toHex,
  keccak256,
  encodePacked,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

// ── cofhejs is loaded the same way the sibling live-smoke loads it.
//    cofhejs/node.mjs has broken dynamic requires in ESM context, so we
//    require the CJS dist via an absolute path. See the live-smoke header
//    for the full rationale.
const _require = createRequire(import.meta.url);
const _cofhejsCjsPath = pathResolve(
  dirname(fileURLToPath(import.meta.url)),
  "../node_modules/cofhejs/dist/node.js",
);
const {
  cofhejs,
  Encryptable,
} = _require(_cofhejsCjsPath) as typeof import("cofhejs/node");
type Permission = import("cofhejs/node").Permission;

// ── deployments loader — same module the live-smoke uses.
import { loadDeployment } from "../src/integrations/deployments.js";

// ── playwright is a dev dep; chromium browser is installed separately via
//    `npx playwright install chromium`. The script gives a clear hint if it
//    isn't installed.
import { chromium, type Browser, type Page } from "playwright";

// ── pinned constants ──────────────────────────────────────────────────────
const CHAIN_ID = 84532;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 5_000;
const THRESHOLD_NETWORK_URL = "https://testnet-cofhe-tn.fhenix.zone";
const REVEAL_WINDOW_SEC = 90;
const INDEXER_LAG_BUDGET_MS = 60 * 1000;
const INDEXER_POLL_INTERVAL_MS = 3_000;
const SNAPSHOT_GRACE_MS = 10_000;

// Daemon API names pinned from spec §13 (2026-05-19). The script asserts on
// these EXACT names; if the daemon's projection has drifted, A3 fails with a
// "missing key" diagnostic rather than silently passing.
const FHENIX_SEALED_HANDLE_KEYS = {
  binaryIndexCtHash: "binary_index_ct_hash",
  confidenceCtHash: "confidence_ct_hash",
} as const;
const FHENIX_REVEALED_SUBOBJECT_KEY = "revealed_verdict";
const FHENIX_REVEALED_PLAINTEXT_KEYS = {
  binaryIndex: "binary_index",
  confidenceBps: "confidence_bps",
} as const;

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

// ── env-var pre-flight. All four are required; missing means abort. ──────
interface PreflightEnv {
  baseRpcUrl: string;
  relayerKey: Hex;
  daemonUrl: string;
  dashboardUrl: string;
  agentAddress: Address;
}

function preflightEnv(): PreflightEnv {
  const baseRpcUrl = (process.env.BASE_RPC_URL ?? "").trim();
  if (!baseRpcUrl) die("pre-flight", "BASE_RPC_URL is required");
  const relayerKeyRaw = (process.env.FHENIX_GATEWAY_RELAYER_PRIVATE_KEY ?? "").trim();
  if (!relayerKeyRaw) die("pre-flight", "FHENIX_GATEWAY_RELAYER_PRIVATE_KEY is required");
  if (!/^0x[0-9a-fA-F]{64}$/.test(relayerKeyRaw)) {
    die("pre-flight", "FHENIX_GATEWAY_RELAYER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex");
  }
  const daemonUrl = (process.env.DAEMON_URL ?? "").trim().replace(/\/$/, "");
  if (!daemonUrl) die("pre-flight", "DAEMON_URL is required (e.g. http://localhost:8080)");
  const dashboardUrl = (process.env.DASHBOARD_URL ?? "").trim().replace(/\/$/, "");
  if (!dashboardUrl) die("pre-flight", "DASHBOARD_URL is required (e.g. http://localhost:5173)");

  const relayerKey = relayerKeyRaw as Hex;
  // Default the agent address to the relayer's own EOA; AGENT_ADDRESS env
  // can override for the case where the operator wants to test a different
  // agent identity. Self-call is fine here — this script is testing the
  // privacy invariant, not auth boundaries.
  const account = privateKeyToAccount(relayerKey);
  const agentRaw = (process.env.AGENT_ADDRESS ?? account.address).trim();
  let agentAddress: Address;
  try {
    agentAddress = getAddress(agentRaw);
  } catch {
    die("pre-flight", `AGENT_ADDRESS "${agentRaw}" is not a valid checksummed address`);
  }

  return { baseRpcUrl, relayerKey, daemonUrl, dashboardUrl, agentAddress };
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

// ── deep numeric walk. Recursively visits every numeric leaf (number or
//    numeric-coercible string of digits) and returns the first JSON-pointer
//    path where it matches the sentinel. null = no match.
//    Catches the case where the daemon stores plaintext as a number, not a
//    string — JSON.stringify(resp).includes("7531") would catch that too,
//    but a numeric leaf 7531 vs string "7531" cross-check makes the privacy
//    assertion strict.
function findNumericLeaf(value: unknown, sentinel: number, path: string = "$"): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    return value === sentinel ? path : null;
  }
  if (typeof value === "bigint") {
    return value === BigInt(sentinel) ? path : null;
  }
  if (typeof value === "string") {
    // Catch numeric-as-string ("7531"). Don't match against the sentinel
    // appearing inside an opaque hex ctHash — those are scanned separately
    // via the JSON.stringify substring check below.
    if (/^\d+$/.test(value) && Number(value) === sentinel) {
      return path;
    }
    return null;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findNumericLeaf(value[i], sentinel, `${path}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const hit = findNumericLeaf(v, sentinel, `${path}.${k}`);
      if (hit) return hit;
    }
  }
  return null;
}

// ── randomized confidence sentinel in [5100, 9500] (contract valid band) ─
function randomSentinel(): number {
  const lo = 5100;
  const hi = 9500;
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

// ── minimal contract ABI (subset of live-smoke's) ─────────────────────────
const ABI = parseAbi([
  "function registerFixedRevealMarket(bytes32 marketId, uint64 revealAfter, bool active)",
  "function submitSealedFor(address agent, bytes32 marketId, (uint256 ctHash, uint8 securityZone, uint8 utype, bytes signature) binaryIndexInput, (uint256 ctHash, uint8 securityZone, uint8 utype, bytes signature) confidenceInput, bytes32 clientNonce) returns (bytes32 callId)",
  "function openReveal(bytes32 callId)",
  "function publishReveal(bytes32 callId, uint8 binaryIndex, uint16 confidenceBps, bytes binaryIndexSignature, bytes confidenceSignature)",
  "function getCall(bytes32 callId) view returns (address agent, bytes32 marketId, uint64 acceptedAt, bytes32 binaryIndexCtHash, bytes32 confidenceCtHash, uint8 revealedBinaryIndex, uint16 revealedConfidenceBps, uint8 state)",
  "function callRevealOpenAt(bytes32 callId) view returns (uint64)",
  "event SealedCallSubmitted(bytes32 indexed callId, address indexed agent, bytes32 indexed marketId, uint64 acceptedAt, uint64 revealOpenAt, bytes32 binaryIndexCtHash, bytes32 confidenceCtHash, bytes32 clientNonce)",
]);

// ── threshold network direct /decrypt call (same shape as live-smoke). The
//    cofhejs.decrypt() helper discards the signature; publishReveal needs
//    it, so we call the endpoint directly.
async function fetchDecryptWithSignature(
  ctHashBigint: bigint,
  permission: Permission,
): Promise<{ decrypted: bigint; signature: Hex }> {
  const ct_tempkey = ctHashBigint.toString(16).padStart(64, "0");
  const body = JSON.stringify({
    ct_tempkey,
    host_chain_id: CHAIN_ID,
    permit: permission,
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
  permission: Permission,
): Promise<{ decrypted: bigint; signature: Hex }> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    try {
      const result = await fetchDecryptWithSignature(ctHashBigint, permission);
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

// ── daemon indexer poll. Waits until the call shows up with both ctHashes
//    populated, OR fails the run with an indexer-lag diagnostic (NOT a
//    privacy pass). Bounded at INDEXER_LAG_BUDGET_MS so we never silently
//    retry past the budget.
async function waitForIndexedSealedCall(
  daemonUrl: string,
  callId: Hex,
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

// ── daemon indexer poll for the post-publish state. Waits until the
//    revealed_verdict sub-object appears with the spec-pinned field names.
//    Same bounded-retry posture as waitForIndexedSealedCall.
async function waitForIndexedReveal(
  daemonUrl: string,
  callId: Hex,
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
  const startMs = Date.now();

  // 0. pre-flight
  const env = preflightEnv();
  const runId = `ob-${Date.now()}-${randomSentinel()}`;
  const sentinelConfidence = randomSentinel();
  const sentinelBinaryIndex = 0;
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
  const publicClient = createPublicClient({ chain: baseSepolia, transport: http(env.baseRpcUrl) });
  const walletClient = createWalletClient({
    account,
    chain: baseSepolia,
    transport: http(env.baseRpcUrl),
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

  // ensure the screenshots dir exists (gitkeep is committed but the runner
  // might be using a fresh worktree without the dir materialized)
  const screenshotDir = pathResolve(
    dirname(fileURLToPath(import.meta.url)),
    "operator-blind/screenshots",
  );
  mkdirSync(screenshotDir, { recursive: true });

  try {
    // 1. snapshot 0 — baseline. Nothing strictly required to assert here;
    //    we just record that the daemon is alive enough to read calls and
    //    that no prior call carries our runId nonce (defense in depth).
    //    The spec calls for /api/calls?recent=20 but that route is the v0
    //    name and not actually present on the daemon (the recent feed
    //    lives at /v1/feed/today). Per "develop-as-prod, no mocks", we
    //    probe what's actually there — /v1/feed/today.
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

    // 2. contract steps 1-3 — register market, encrypt inputs, submit sealed call.
    //    Implemented inline because the live-smoke's main() isn't exported.
    const marketId = keccak256(
      encodePacked(["string", "uint64"], [`${runId}-market`, BigInt(Date.now())]),
    );
    const revealAfter = BigInt(Math.floor(Date.now() / 1000) + REVEAL_WINDOW_SEC);
    log(`registerFixedRevealMarket marketId=${marketId} revealAfter=${revealAfter}`);
    const registerTx = await walletClient.writeContract({
      address: contractAddress,
      abi: ABI,
      functionName: "registerFixedRevealMarket",
      args: [marketId, revealAfter, true],
    });
    await publicClient.waitForTransactionReceipt({ hash: registerTx });
    ok(`market registered (tx=${registerTx})`);

    log(`initializing cofhejs (environment=TESTNET, chain=${CHAIN_ID})`);
    const initResult = await cofhejs.initializeWithViem({
      viemClient: publicClient as never,
      viemWalletClient: walletClient as never,
      environment: "TESTNET",
      generatePermit: true,
    });
    if (!initResult.success) {
      throw new Error(`cofhejs init failed: ${initResult.error?.message}`);
    }
    let permResult = cofhejs.getPermission();
    if (!permResult.success) {
      const createResult = await cofhejs.createPermit({ type: "self", issuer: account.address });
      if (!createResult.success) {
        throw new Error(`createPermit failed: ${createResult.error?.message}`);
      }
      permResult = cofhejs.getPermission();
      if (!permResult.success) {
        throw new Error(`getPermission failed: ${permResult.error?.message}`);
      }
    }
    const permission: Permission = permResult.data!;

    log(`encrypting inputs (binaryIndex=${sentinelBinaryIndex}, confidenceBps=${sentinelConfidence})`);
    const encryptResult = await cofhejs.encrypt([
      Encryptable.uint8(BigInt(sentinelBinaryIndex)),
      Encryptable.uint16(BigInt(sentinelConfidence)),
    ]);
    if (!encryptResult.success) {
      throw new Error(`cofhejs.encrypt failed: ${encryptResult.error?.message}`);
    }
    const [binEnc, confEnc] = encryptResult.data;
    log(`encrypted: bin.ctHash=${binEnc.ctHash} conf.ctHash=${confEnc.ctHash}`);

    const clientNonce = keccak256(toHex(`${runId}-nonce-${Math.random()}`));
    log(`submitSealedFor agent=${env.agentAddress} marketId=${marketId} nonce=${clientNonce}`);
    const submitTx = await walletClient.writeContract({
      address: contractAddress,
      abi: ABI,
      functionName: "submitSealedFor",
      args: [
        env.agentAddress,
        marketId,
        {
          ctHash: binEnc.ctHash,
          securityZone: binEnc.securityZone,
          utype: binEnc.utype,
          signature: binEnc.signature as Hex,
        },
        {
          ctHash: confEnc.ctHash,
          securityZone: confEnc.securityZone,
          utype: confEnc.utype,
          signature: confEnc.signature as Hex,
        },
        clientNonce,
      ],
    });
    const submitReceipt = await publicClient.waitForTransactionReceipt({ hash: submitTx });

    const sealedCallTopic = keccak256(
      toHex(
        "SealedCallSubmitted(bytes32,address,bytes32,uint64,uint64,bytes32,bytes32,bytes32)",
      ),
    );
    const submittedLog = submitReceipt.logs.find(
      (l) =>
        l.address.toLowerCase() === contractAddress.toLowerCase() &&
        l.topics[0] === sealedCallTopic,
    );
    assert.ok(submittedLog, "SealedCallSubmitted log not found in submit receipt");
    const callId = submittedLog!.topics[1] as Hex;
    ok(`sealed call submitted (callId=${callId}, tx=${submitTx})`);

    // 3. snapshot 1 — give the daemon ~10s + bounded poll for indexer lag.
    log(`waiting ${SNAPSHOT_GRACE_MS / 1000}s + indexer poll for daemon to index SealedCallSubmitted…`);
    await new Promise((r) => setTimeout(r, SNAPSHOT_GRACE_MS));
    const sealedSnapshot = await waitForIndexedSealedCall(env.daemonUrl, callId);

    // ── A1 — daemon opaque pre-reveal
    const fhenixPre = sealedSnapshot["fhenix"] as Record<string, unknown> | undefined;
    if (!fhenixPre || typeof fhenixPre !== "object") {
      die("A1", "daemon response missing top-level 'fhenix' sub-object", sealedSnapshot);
    }
    const binHandle = fhenixPre[FHENIX_SEALED_HANDLE_KEYS.binaryIndexCtHash];
    const confHandle = fhenixPre[FHENIX_SEALED_HANDLE_KEYS.confidenceCtHash];
    if (typeof binHandle !== "string" || !binHandle.startsWith("0x")) {
      die(
        "A1",
        `fhenix.${FHENIX_SEALED_HANDLE_KEYS.binaryIndexCtHash} missing or not a 0x-prefixed handle`,
        fhenixPre,
      );
    }
    if (typeof confHandle !== "string" || !confHandle.startsWith("0x")) {
      die(
        "A1",
        `fhenix.${FHENIX_SEALED_HANDLE_KEYS.confidenceCtHash} missing or not a 0x-prefixed handle`,
        fhenixPre,
      );
    }
    if (fhenixPre[FHENIX_REVEALED_SUBOBJECT_KEY] !== undefined && fhenixPre[FHENIX_REVEALED_SUBOBJECT_KEY] !== null) {
      die(
        "A1",
        `fhenix.${FHENIX_REVEALED_SUBOBJECT_KEY} populated pre-reveal — operator-blind invariant broken`,
        fhenixPre[FHENIX_REVEALED_SUBOBJECT_KEY],
      );
    }
    const preStringified = JSON.stringify(sealedSnapshot);
    if (preStringified.includes(`${sentinelConfidence}`)) {
      // Could be a coincidental substring in an opaque hex handle. Disambiguate
      // by scrubbing the two known ctHash hex strings and re-checking.
      const scrubbed = preStringified
        .replaceAll(binHandle, "")
        .replaceAll(confHandle, "");
      if (scrubbed.includes(`${sentinelConfidence}`)) {
        die(
          "A1",
          `JSON.stringify(daemon response) contains confidence sentinel ${sentinelConfidence} outside the opaque ctHash handles`,
          preStringified,
        );
      }
    }
    const numericHit = findNumericLeaf(sealedSnapshot, sentinelConfidence);
    if (numericHit) {
      die(
        "A1",
        `deep numeric walk found confidence sentinel ${sentinelConfidence} at JSON path ${numericHit}`,
        sealedSnapshot,
      );
    }
    ok(`A1: daemon opaque pre-reveal (ctHash handles present, no plaintext, no sentinel match)`);

    // ── A2 — dashboard masked pre-reveal
    const preUrl = `${env.dashboardUrl}/#/calls/${callId}`;
    log(`playwright goto ${preUrl}`);
    const prePage: Page = await browser.newPage();
    try {
      await prePage.goto(preUrl, { waitUntil: "networkidle", timeout: 60_000 });
      // Wait for the CallPage to render past the [loading…] placeholder.
      // The sealed affordance is rendered as the literal text "sealed"
      // inside the submission panel's confidence row (see
      // dashboard/src/verdict/pages/CallPage.tsx) plus the privacy chip
      // "fhenix sealed". We wait for either to appear before reading the
      // innerText.
      await prePage.waitForFunction(
        () => {
          const t = document.body?.innerText ?? "";
          return t.includes("sealed") || t.includes("fhenix sealed");
        },
        undefined,
        { timeout: 30_000 },
      );
      const preInnerText = await prePage.evaluate(() => document.body?.innerText ?? "");
      const sealedAffordancePresent =
        preInnerText.includes("sealed") || preInnerText.includes("operator-blind");
      if (!sealedAffordancePresent) {
        die(
          "A2",
          `dashboard call page is missing the sealed affordance (neither "sealed" nor "operator-blind" found in innerText)`,
          preInnerText.slice(0, 2000),
        );
      }
      if (preInnerText.includes(`${sentinelConfidence}`)) {
        const idx = preInnerText.indexOf(`${sentinelConfidence}`);
        const excerpt = preInnerText.slice(Math.max(0, idx - 200), idx + 200);
        die("A2", `dashboard DOM innerText contains confidence sentinel ${sentinelConfidence}`, excerpt);
      }
      const prePath = pathResolve(screenshotDir, `pre-${runId}.png`);
      await prePage.screenshot({ path: prePath, fullPage: true });
      ok(`A2: dashboard masked pre-reveal (sealed affordance present, no sentinel). screenshot=${prePath}`);
    } finally {
      await prePage.close();
    }

    // 4. contract steps 4-7 — wait for reveal window, openReveal, poll
    //    threshold network, publishReveal.
    const revealOpenAt = await publicClient.readContract({
      address: contractAddress,
      abi: ABI,
      functionName: "callRevealOpenAt",
      args: [callId],
    });
    const maxWaitMs = 15 * 60 * 1000;
    const waitDeadline = Date.now() + maxWaitMs;
    log(`waiting for reveal window (revealOpenAt=${revealOpenAt})`);
    while (Math.floor(Date.now() / 1000) < Number(revealOpenAt)) {
      if (Date.now() > waitDeadline) throw new Error("timed out waiting for reveal window");
      const remaining = Number(revealOpenAt) - Math.floor(Date.now() / 1000);
      log(`${remaining}s until reveal window opens…`);
      await new Promise((r) => setTimeout(r, 5_000));
    }

    log(`openReveal callId=${callId}`);
    const openTx = await walletClient.writeContract({
      address: contractAddress,
      abi: ABI,
      functionName: "openReveal",
      args: [callId],
    });
    await publicClient.waitForTransactionReceipt({ hash: openTx });
    ok(`reveal opened (tx=${openTx})`);

    const callData = await publicClient.readContract({
      address: contractAddress,
      abi: ABI,
      functionName: "getCall",
      args: [callId],
    });
    const binaryIndexCtHash = callData[3];
    const confidenceCtHash = callData[4];
    const binCtHashBigint = BigInt(binaryIndexCtHash);
    const confCtHashBigint = BigInt(confidenceCtHash);

    log(`polling threshold network for decrypts (timeout=${POLL_TIMEOUT_MS / 1000}s)`);
    const binDecrypt = await pollDecrypt("binaryIndex decrypt", binCtHashBigint, permission);
    const confDecrypt = await pollDecrypt("confidenceBps decrypt", confCtHashBigint, permission);
    if (Number(binDecrypt.decrypted) !== sentinelBinaryIndex) {
      die(
        "decrypt",
        `binaryIndex plaintext mismatch — expected ${sentinelBinaryIndex} got ${binDecrypt.decrypted}`,
      );
    }
    if (Number(confDecrypt.decrypted) !== sentinelConfidence) {
      die(
        "decrypt",
        `confidenceBps plaintext mismatch — expected ${sentinelConfidence} got ${confDecrypt.decrypted}`,
      );
    }
    log(`decrypted ok: binaryIndex=${binDecrypt.decrypted} confidenceBps=${confDecrypt.decrypted}`);

    log(`publishReveal callId=${callId}`);
    const publishTx = await walletClient.writeContract({
      address: contractAddress,
      abi: ABI,
      functionName: "publishReveal",
      args: [
        callId,
        Number(binDecrypt.decrypted),
        Number(confDecrypt.decrypted),
        binDecrypt.signature,
        confDecrypt.signature,
      ],
    });
    await publicClient.waitForTransactionReceipt({ hash: publishTx });
    ok(`verdict revealed (tx=${publishTx})`);

    // 5. snapshot 2 — A3, daemon + DOM carry plaintext post-publish.
    log(`waiting ${SNAPSHOT_GRACE_MS / 1000}s + indexer poll for daemon to index VerdictRevealed…`);
    await new Promise((r) => setTimeout(r, SNAPSHOT_GRACE_MS));
    const revealedSnapshot = await waitForIndexedReveal(env.daemonUrl, callId);

    const fhenixPost = revealedSnapshot["fhenix"] as Record<string, unknown> | undefined;
    if (!fhenixPost) {
      die("A3", `daemon post-publish response missing 'fhenix' sub-object`, revealedSnapshot);
    }
    const revealedVerdict = fhenixPost[FHENIX_REVEALED_SUBOBJECT_KEY] as
      | Record<string, unknown>
      | undefined;
    if (!revealedVerdict || typeof revealedVerdict !== "object") {
      die(
        "A3",
        `daemon never returned a populated fhenix.${FHENIX_REVEALED_SUBOBJECT_KEY} sub-object after publishReveal landed at tx ${publishTx}`,
        fhenixPost,
      );
    }
    const revealedBin = revealedVerdict[FHENIX_REVEALED_PLAINTEXT_KEYS.binaryIndex];
    const revealedConf = revealedVerdict[FHENIX_REVEALED_PLAINTEXT_KEYS.confidenceBps];
    if (revealedBin !== sentinelBinaryIndex) {
      die(
        "A3",
        `expected fhenix.${FHENIX_REVEALED_SUBOBJECT_KEY}.${FHENIX_REVEALED_PLAINTEXT_KEYS.binaryIndex}=${sentinelBinaryIndex}, got ${JSON.stringify(revealedBin)} (keys present: [${Object.keys(revealedVerdict).join(", ")}])`,
        revealedVerdict,
      );
    }
    if (revealedConf !== sentinelConfidence) {
      die(
        "A3",
        `expected fhenix.${FHENIX_REVEALED_SUBOBJECT_KEY}.${FHENIX_REVEALED_PLAINTEXT_KEYS.confidenceBps}=${sentinelConfidence}, got ${JSON.stringify(revealedConf)} (keys present: [${Object.keys(revealedVerdict).join(", ")}])`,
        revealedVerdict,
      );
    }
    ok(`A3 (daemon): fhenix.${FHENIX_REVEALED_SUBOBJECT_KEY} populated with both spec-pinned plaintext fields`);

    // ── A3 — dashboard side. Reload the page (the SPA refreshes its data
    //    via the same /v1/calls fetch) and assert the sentinel is now in
    //    the rendered text.
    const postUrl = `${env.dashboardUrl}/#/calls/${callId}`;
    log(`playwright goto ${postUrl} (post-publish render)`);
    const postPage: Page = await browser.newPage();
    try {
      await postPage.goto(postUrl, { waitUntil: "networkidle", timeout: 60_000 });
      // Give the SPA up to 20s to flip from sealed → revealed render. We
      // poll for the sentinel substring rather than a fixed timeout so
      // slow indexers don't false-fail.
      await postPage.waitForFunction(
        (sentinelStr) => (document.body?.innerText ?? "").includes(sentinelStr),
        `${sentinelConfidence}`,
        { timeout: 30_000 },
      ).catch(() => {
        /* fall through — innerText snapshot below produces the diagnostic */
      });
      const postInnerText = await postPage.evaluate(() => document.body?.innerText ?? "");
      if (!postInnerText.includes(`${sentinelConfidence}`)) {
        die(
          "A3",
          `dashboard DOM never surfaced confidence sentinel ${sentinelConfidence} post-publish (innerText excerpt below)`,
          postInnerText.slice(0, 2000),
        );
      }
      const postPath = pathResolve(screenshotDir, `post-${runId}.png`);
      await postPage.screenshot({ path: postPath, fullPage: true });
      ok(`A3 (dashboard): DOM carries confidence sentinel ${sentinelConfidence}. screenshot=${postPath}`);
    } finally {
      await postPage.close();
    }

    const elapsedSec = ((Date.now() - startMs) / 1000).toFixed(1);
    console.log("");
    console.log(`${ANSI.green}${ANSI.bold}[operator-blind] PASS${ANSI.reset} runId=${runId} callId=${callId} elapsed=${elapsedSec}s`);
    console.log(`${ANSI.dim}  txs: register=${registerTx} submit=${submitTx} open=${openTx} publish=${publishTx}${ANSI.reset}`);
  } finally {
    await browser.close().catch(() => undefined);
  }
}

main().catch((err) => {
  console.error(`${ANSI.red}[operator-blind] FAILED:${ANSI.reset}`, err);
  process.exit(1);
});
