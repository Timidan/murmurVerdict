/**
 * tools/auto-bettor.ts — autonomous prediction agent that exercises the full
 * murmur sealed-call lifecycle against discovery-registered Polymarket 5-minute
 * markets, to accumulate a real leaderboard track record.
 *
 * It plays the role an external agent would: for each freshly-registered
 * `listed` polymarket-gamma market it hasn't bet on yet, it submits a sealed
 * call through the Gateway (plaintext in, daemon seals + relays), then at the
 * market's reveal window it drives openReveal → threshold decrypt →
 * publishReveal. The daemon watcher ingests the reveal and the resolver scores
 * it via the CLOB fallback.
 *
 * Key separation (avoids nonce contention during an unattended grind):
 *   - The DAEMON signs submitSealedFor (Gateway) + registerFixedRevealMarket
 *     (discovery) with the owner/relayer key, nonce-coordinated in-process.
 *   - THIS tool signs openReveal + publishReveal with a SEPARATE funded EOA
 *     (BETTOR_REVEAL_KEY). openReveal/publishReveal have no access control, so a
 *     distinct key is sufficient and keeps the two writers off each other's
 *     nonce.
 *
 * Gated behind MURMUR_ALLOW_FIXTURE_SEED=true (mints runtime keys into the DB).
 *
 * Env:
 *   FHENIX_RPC_URL              archive+tx RPC (Alchemy)
 *   BETTOR_REVEAL_KEY           0x-private-key of the funded reveal EOA
 *   AGENT_ADDRESS               controller wallet of the betting agent
 *   BETTOR_AGENT_SLUG           agent slug (default operator-blind-test)
 *   BETTOR_TARGET               stop when agent has this many resolved calls (default 20)
 *   BETTOR_MIN_LEAD_SEC         only bet markets ending >= now+this (default 150)
 *   BETTOR_MAX_LEAD_SEC         only bet markets ending <= now+this (default 1500)
 *   DAEMON_URL                  default http://localhost:8080
 */
import "dotenv/config";
import { randomBytes, randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { createCofheClient, createCofheConfig } from "@cofhe/sdk/node";
import { baseSepolia as cofheBaseSepolia } from "@cofhe/sdk/chains";

import { canonicalHash, canonicalize } from "../src/receipts/canonical.js";
import { getAccountForAgent } from "../src/verdict/auth/accounts.js";
import { getControllerWalletForAgent } from "../src/verdict/auth/controller-wallets.js";
import { mintRuntimeKey } from "../src/verdict/auth/runtime-keys.js";
import { agentsRepo, marketsRepo, openDb } from "../src/verdict/db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

const CONTRACT = getAddress("0x1B74A4bAb1E06Ed107780a245c85337AB9dEcD1A");
const CHAIN_ID = 84532;
const DAEMON = (process.env.DAEMON_URL ?? "http://localhost:8080").replace(/\/$/, "");
const TARGET = Number(process.env.BETTOR_TARGET ?? "20");
const MIN_LEAD_SEC = Number(process.env.BETTOR_MIN_LEAD_SEC ?? "150");
const MAX_LEAD_SEC = Number(process.env.BETTOR_MAX_LEAD_SEC ?? "1500");
const AGENT_SLUG = process.env.BETTOR_AGENT_SLUG ?? "operator-blind-test";
const POLL_MS = 20_000;
const DECRYPT_TIMEOUT_MS = 5 * 60 * 1000;
const DECRYPT_RETRY_MS = 10_000;
// Cap on the agent's concurrent unresolved calls; must stay <= the Gateway's
// SUBMISSION_LIMITS.max_active_calls_per_agent or submits 429. Configurable so
// a supply burst can be consumed fast.
const MAX_ACTIVE = Number(process.env.BETTOR_MAX_ACTIVE ?? "5");

const ABI = parseAbi([
  "function openReveal(bytes32 callId)",
  "function publishReveal(bytes32 callId, uint8 binaryIndex, uint16 confidenceBps, bytes binaryIndexSignature, bytes confidenceSignature)",
  "function getCall(bytes32 callId) view returns (address agent, bytes32 marketId, uint64 acceptedAt, bytes32 binaryIndexCtHash, bytes32 confidenceCtHash, uint8 revealedBinaryIndex, uint16 revealedConfidenceBps, uint8 state)",
]);

function log(msg: string): void {
  console.log(`[auto-bettor] ${new Date().toISOString()} ${msg}`);
}

function req(name: string): string {
  const v = (process.env[name] ?? "").trim();
  if (!v) throw new Error(`${name} is required`);
  return v;
}

interface InFlight {
  marketId: string;
  question: string;
  callId: string;
  onchainCallId: Hex | null;
  revealOpenAtSec: number;
  binaryIndex: number;
  confidenceBps: number;
  phase: "submitted" | "opened" | "published" | "failed";
}

async function main(): Promise<void> {
  if (process.env.MURMUR_ALLOW_FIXTURE_SEED !== "true") {
    throw new Error("auto-bettor requires MURMUR_ALLOW_FIXTURE_SEED=true (mints runtime keys)");
  }
  const rpcUrl = req("FHENIX_RPC_URL");
  const revealKey = req("BETTOR_REVEAL_KEY") as Hex;
  const agentWallet = getAddress(req("AGENT_ADDRESS"));
  const dbPath = process.env.VERDICT_DB_PATH ?? resolve(REPO_ROOT, "data/verdict.db");
  const db = openDb({ path: dbPath });

  const agent = agentsRepo.bySlug(db, AGENT_SLUG);
  if (!agent) throw new Error(`no agent slug '${AGENT_SLUG}'`);
  const accountId = getAccountForAgent(db, agent.agent_id);
  if (!accountId) throw new Error("agent has no account");
  const wallet = getControllerWalletForAgent(db, agent.agent_id);
  if (!wallet) throw new Error("agent has no controller wallet");

  const account = privateKeyToAccount(revealKey);
  const publicClient = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account, chain: baseSepolia, transport: http(rpcUrl) });
  const bal = await publicClient.getBalance({ address: account.address });
  log(`reveal EOA ${account.address} balance=${(Number(bal) / 1e18).toFixed(4)} ETH`);
  if (bal < 20_000_000_000_000_000n) throw new Error("reveal EOA underfunded (<0.02 ETH)");

  log("connecting @cofhe/sdk (reveal account) …");
  const cofheClient = createCofheClient(
    createCofheConfig({ environment: "node", supportedChains: [cofheBaseSepolia] }),
  );
  await cofheClient.connect(publicClient as never, walletClient as never);
  const selfPermit = await cofheClient.permits.createSelf({ type: "self", issuer: account.address });

  const inflight = new Map<string, InFlight>();
  const bet = new Set<string>(); // market_ids already bet this run

  const resolvedCount = (): number =>
    (db.prepare("SELECT COUNT(*) n FROM submissions WHERE agent_id=? AND status='resolved'").get(agent.agent_id) as { n: number }).n;

  const startResolved = resolvedCount();
  log(`agent ${AGENT_SLUG} start resolved=${startResolved} target=${TARGET}`);

  // Pre-seed "already bet" with markets the agent already has submissions for.
  for (const row of db.prepare("SELECT DISTINCT market_id FROM submissions WHERE agent_id=?").all(agent.agent_id) as { market_id: string }[]) {
    bet.add(row.market_id.toLowerCase());
  }

  // Recover unrevealed in-flight calls (e.g. from a previous run of this tool)
  // so the reveal loop still drives them to publish. Calls already revealed are
  // left to the resolver.
  const recovered = db.prepare(
    `SELECT s.call_id AS call_id, s.market_id AS market_id, sc.onchain_call_id AS onchain_call_id,
            sc.reveal_open_at AS reveal_open_at, sc.reveal_status AS reveal_status, m.config_json AS config_json
     FROM submissions s
     JOIN fhenix_sealed_calls sc ON sc.call_id = s.call_id
     LEFT JOIN markets m ON m.market_id = s.market_id
     WHERE s.agent_id = ? AND s.status IN ('pending','pending_t1')
       AND (sc.reveal_status IS NULL OR sc.reveal_status NOT IN ('revealed','invalid'))`,
  ).all(agent.agent_id) as {
    call_id: string; market_id: string; onchain_call_id: string | null;
    reveal_open_at: string | null; reveal_status: string | null; config_json: string | null;
  }[];
  for (const r of recovered) {
    let question = r.market_id;
    try { question = (JSON.parse(r.config_json ?? "{}").question as string) ?? r.market_id; } catch { /* keep id */ }
    inflight.set(r.call_id, {
      marketId: r.market_id.toLowerCase(),
      question,
      callId: r.call_id,
      onchainCallId: (r.onchain_call_id as Hex | null) ?? null,
      revealOpenAtSec: r.reveal_open_at ? Math.floor(Date.parse(r.reveal_open_at) / 1000) : 0,
      binaryIndex: -1,
      confidenceBps: -1,
      phase: "submitted",
    });
  }
  if (recovered.length > 0) log(`recovered ${recovered.length} unrevealed in-flight call(s) for reveal`);

  let ticks = 0;
  while (ticks < 480) {
    ticks++;
    const nowSec = Math.floor(Date.now() / 1000);
    // Stop opening NEW positions once the resolved target is met, but keep the
    // reveal loop running below so already-submitted calls are never stranded
    // sealed (which would later be marked missed and dent reveal reliability).
    const needMore = resolvedCount() < TARGET;

    if (needMore) {
    // ── SUBMIT: eligible = discovery-registered markets only. Joining the
    // discovery ledger (status listed) guarantees the market is registered
    // ON-CHAIN via registerFixedRevealMarket — betting a merely DB-listed
    // polymarket market that was never put on-chain (e.g. a pre-existing FIFA
    // market) reverts submitSealedFor with MarketNotFound and burns gas.
    const eligible = db.prepare(
      `SELECT m.market_id AS market_id, m.market_config_version AS market_config_version,
              m.config_json AS config_json
       FROM markets m
       JOIN polymarket_discovery_state d ON d.condition_id = m.market_id
       WHERE m.adapter_id='polymarket-gamma' AND m.status='listed' AND d.status='listed'`,
    ).all() as { market_id: string; market_config_version: number; config_json: string }[];

    // Soonest-ending eligible markets first, so an occupied active-call slot
    // frees as quickly as possible.
    const candidates = eligible
      .map((m) => {
        let cfg: { endDate?: string; question?: string };
        try { cfg = JSON.parse(m.config_json); } catch { return null; }
        const endMs = cfg.endDate ? Date.parse(cfg.endDate) : NaN;
        if (!Number.isFinite(endMs)) return null;
        return { m, question: cfg.question ?? m.market_id, endMs, lead: endMs / 1000 - nowSec };
      })
      .filter((c): c is NonNullable<typeof c> => c !== null)
      .filter((c) => c.lead >= MIN_LEAD_SEC && c.lead <= MAX_LEAD_SEC && !bet.has(c.m.market_id.toLowerCase()))
      .sort((a, b) => a.endMs - b.endMs);

    // Active = the agent's not-yet-resolved calls; the Gateway caps this at 5.
    let active = (db.prepare(
      "SELECT COUNT(*) n FROM submissions WHERE agent_id=? AND status IN ('pending','pending_t1')",
    ).get(agent.agent_id) as { n: number }).n;

    for (const c of candidates) {
      if (active >= MAX_ACTIVE) break;
      const mid = c.m.market_id.toLowerCase();
      try {
        await submitOne(db, agent.agent_id, accountId, wallet, agentWallet, c.m, c.question, c.endMs, inflight);
        bet.add(mid);
        active++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("rate_limited") || msg.includes("active calls per agent")) {
          // Slots are full at the Gateway — stop this tick, keep the market
          // eligible for a later tick when a call resolves.
          break;
        }
        log(`submit ${mid.slice(0, 12)} FAILED: ${msg}`);
        bet.add(mid); // deterministic failure (revert, bad config) — don't retry
      }
    }
    } // end if (needMore)

    // ── REVEAL: for each in-flight call whose window has opened, sequentially
    for (const f of inflight.values()) {
      if (f.phase === "published" || f.phase === "failed") continue;
      if (Math.floor(Date.now() / 1000) < f.revealOpenAtSec) continue;
      try {
        await revealOne(db, publicClient, walletClient, cofheClient, selfPermit, f);
      } catch (err) {
        log(`reveal ${f.callId.slice(0, 8)} FAILED: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const done = resolvedCount();
    const openInflight = [...inflight.values()].filter((f) => f.phase !== "published" && f.phase !== "failed").length;
    log(`tick ${ticks}: resolved=${done}/${TARGET} inflight-open=${openInflight} bet=${bet.size}`);
    // Exit only when the target is met AND every submitted call has been
    // revealed (or failed) — never abandon a sealed call mid-flight.
    if (done >= TARGET && openInflight === 0) break;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  log(`DONE. resolved=${resolvedCount()} (started ${startResolved}), target ${TARGET}.`);
  process.exit(0);
}

async function submitOne(
  db: ReturnType<typeof openDb>,
  agentId: string,
  accountId: string,
  wallet: { wallet_address: string; chain_id: string },
  agentWallet: Address,
  market: { market_id: string; market_config_version: number },
  question: string,
  endMs: number,
  inflight: Map<string, InFlight>,
): Promise<void> {
  const mid = market.market_id.toLowerCase();
  // Per-market runtime key (policy scopes to this one market).
  const policy = {
    allowed_intents: ["sealed_call"],
    allowed_chain_ids: [CHAIN_ID],
    allowed_market_ids: [mid],
    max_calls_per_hour: 1000,
    max_calls_per_day: 10000,
    notes: `auto-bettor ${mid}`,
  };
  const minted = mintRuntimeKey(db, {
    account_id: accountId,
    agent_id: agentId,
    label: `auto-bettor ${new Date().toISOString()}`,
    policy_json: canonicalize(policy),
    policy_hash: canonicalHash(policy),
    controller_wallet_address: wallet.wallet_address,
    controller_chain_id: wallet.chain_id,
    authorization_nonce: randomUUID(),
    authorization_message: `auto-bettor runtime key ${randomUUID()}`,
    authorization_signature: "0x" + "12".repeat(65),
    createdAt: new Date(),
  });

  const binaryIndex = randomBytes(1)[0] % 2; // 0=Up, 1=Down
  const confidenceBps = 5100 + (randomBytes(2).readUInt16BE(0) % 4400); // 5100-9500
  const clientNonce = ("0x" + randomBytes(32).toString("hex")) as Hex;
  const body = {
    marketRef: { protocol: "polymarket-gamma", sourceId: mid, configVersion: market.market_config_version },
    client_order_id: `bettor-${randomUUID()}`,
    client_nonce: clientNonce,
    privacy_mode: "murmur_sealed_fhenix",
    verdict: { binary_index: binaryIndex, confidence_bps: confidenceBps },
    public_strategy_tag: "auto-bettor",
  };
  const res = await fetch(`${DAEMON}/v2/gateway/calls/seal`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Murmur-Runtime-Key": minted.secret },
    body: JSON.stringify(body),
  });
  const first = (await res.json()) as { attempt_id?: string; call_id?: string | null; status?: string };
  if (!first.attempt_id) throw new Error(`no attempt_id (status ${res.status}): ${JSON.stringify(first).slice(0, 200)}`);

  // Poll the attempt until accepted (call_id present) or terminal failure.
  let callId: string | null = first.call_id ?? null;
  const deadline = Date.now() + 5 * 60 * 1000;
  while (!callId && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 4000));
    const row = db.prepare("SELECT status, call_id FROM fhenix_gateway_tx_attempts WHERE attempt_id=?").get(first.attempt_id) as { status: string; call_id: string | null } | undefined;
    if (row?.call_id) { callId = row.call_id; break; }
    if (row && row.status.startsWith("failed")) {
      const err = db.prepare("SELECT last_error FROM fhenix_gateway_tx_attempts WHERE attempt_id=?").get(first.attempt_id) as { last_error: string | null };
      throw new Error(`gateway attempt ${row.status}: ${err?.last_error ?? "?"}`);
    }
  }
  if (!callId) throw new Error("timed out waiting for call_id");

  // onchain_call_id from the daemon-indexed sealed call row.
  let onchainCallId: Hex | null = null;
  const ocDeadline = Date.now() + 60_000;
  while (!onchainCallId && Date.now() < ocDeadline) {
    const sc = db.prepare("SELECT onchain_call_id FROM fhenix_sealed_calls WHERE call_id=?").get(callId) as { onchain_call_id: string | null } | undefined;
    if (sc?.onchain_call_id) { onchainCallId = sc.onchain_call_id as Hex; break; }
    await new Promise((r) => setTimeout(r, 3000));
  }

  inflight.set(callId, {
    marketId: mid,
    question,
    callId,
    onchainCallId,
    revealOpenAtSec: Math.floor(endMs / 1000),
    binaryIndex,
    confidenceBps,
    phase: "submitted",
  });
  log(`SUBMIT ok call=${callId.slice(0, 8)} ${binaryIndex === 0 ? "Up" : "Down"}@${confidenceBps}bps ends=${new Date(endMs).toISOString().slice(11, 19)} ${question.slice(0, 34)}`);
}

async function revealOne(
  db: ReturnType<typeof openDb>,
  publicClient: ReturnType<typeof createPublicClient>,
  walletClient: ReturnType<typeof createWalletClient>,
  cofheClient: Awaited<ReturnType<typeof createCofheClient>> | ReturnType<typeof createCofheClient>,
  selfPermit: unknown,
  f: InFlight,
): Promise<void> {
  if (!f.onchainCallId) {
    const sc = db.prepare("SELECT onchain_call_id FROM fhenix_sealed_calls WHERE call_id=?").get(f.callId) as { onchain_call_id: string | null } | undefined;
    if (!sc?.onchain_call_id) throw new Error("no onchain_call_id yet");
    f.onchainCallId = sc.onchain_call_id as Hex;
  }
  const oc = f.onchainCallId;

  // getCall.state: 1=Sealed, 2=Opened, 3=Revealed/Published
  const call = (await publicClient.readContract({ address: CONTRACT, abi: ABI, functionName: "getCall", args: [oc] })) as readonly [Address, Hex, bigint, Hex, Hex, number, number, number];
  const state = call[7];

  if (state === 1) {
    const openTx = await walletClient.writeContract({ address: CONTRACT, abi: ABI, functionName: "openReveal", args: [oc], chain: baseSepolia, account: walletClient.account! });
    await publicClient.waitForTransactionReceipt({ hash: openTx });
    f.phase = "opened";
    log(`openReveal ${f.callId.slice(0, 8)} tx=${openTx.slice(0, 12)}`);
  }
  if (state >= 3) { f.phase = "published"; return; }

  const fresh = (await publicClient.readContract({ address: CONTRACT, abi: ABI, functionName: "getCall", args: [oc] })) as readonly [Address, Hex, bigint, Hex, Hex, number, number, number];
  const binCt = BigInt(fresh[3]);
  const confCt = BigInt(fresh[4]);

  const decrypt = async (label: string, ct: bigint): Promise<{ decryptedValue: bigint; signature: Hex }> => {
    const deadline = Date.now() + DECRYPT_TIMEOUT_MS;
    let attempt = 0;
    for (;;) {
      attempt++;
      try {
        return (await cofheClient.decryptForTx(ct).withPermit(selfPermit as never).execute()) as { decryptedValue: bigint; signature: Hex };
      } catch (err) {
        if (Date.now() + DECRYPT_RETRY_MS > deadline) throw new Error(`${label} decrypt timeout: ${err instanceof Error ? err.message : String(err)}`);
        await new Promise((r) => setTimeout(r, DECRYPT_RETRY_MS));
      }
    }
  };
  const bin = await decrypt("binIdx", binCt);
  const conf = await decrypt("conf", confCt);

  const pubTx = await walletClient.writeContract({
    address: CONTRACT,
    abi: ABI,
    functionName: "publishReveal",
    args: [oc, Number(bin.decryptedValue), Number(conf.decryptedValue), bin.signature, conf.signature],
    chain: baseSepolia,
    account: walletClient.account!,
  });
  await publicClient.waitForTransactionReceipt({ hash: pubTx });
  f.phase = "published";
  log(`publishReveal ${f.callId.slice(0, 8)} bi=${bin.decryptedValue} conf=${conf.decryptedValue} tx=${pubTx.slice(0, 12)}`);
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
