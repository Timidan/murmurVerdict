/**
 * Murmur Verdict — external agent reference.
 *
 * 5-minute starter that proves an external agent can self-onboard and
 * submit committed-mode calls against the new market_id wire shape
 * without any Murmur-specific SDK. Uses raw HTTP + viem for wallet
 * signing only. Port to any language by following the wire contracts.
 *
 * Lifecycle on first run (`npm run agent`):
 *   1. Look up the slug — if unknown, run wallet-only claim flow:
 *      a. POST /v1/agents/<slug>/claim/wallet-only/init
 *      b. EIP-191 personal_sign the response's `sign_message`
 *      c. POST /v1/agents/<slug>/claim/wallet-only/finalize
 *      d. Persist the returned api_key to .agent-state.json
 *   2. Read ETH/USD price now + ~1m earlier from Pyth Hermes (no SDK)
 *   3. Compute a one-line momentum signal (recent_delta sign)
 *   4. Generate fresh 32-byte salt
 *   5. POST /v1/calls with privacy_mode='committed' + market_id
 *   6. Persist the canonical preimage to .agent-state.json so we can
 *      reveal at horizon
 *
 * On `npm run reveal` (no args):
 *   - Walk persisted preimages whose accepted_at + horizon_seconds is
 *     past, and POST each to /v1/calls/<call_id>/reveal. The daemon
 *     verifies keccak256(canonical_json(preimage)) === stored commit.hash.
 */

import {
  privateKeyToAccount,
  type PrivateKeyAccount,
} from "viem/accounts";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ─── Config ─────────────────────────────────────────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_PATH = resolve(HERE, "..", ".agent-state.json");
const ENV_PATH = resolve(HERE, "..", ".env");

// Tiny dotenv shim — keeps the example dependency-free for env loading.
if (existsSync(ENV_PATH)) {
  for (const line of readFileSync(ENV_PATH, "utf-8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, "");
  }
}

const MURMUR_API_URL = (process.env.MURMUR_API_URL ?? "http://localhost:8080").replace(/\/$/, "");
const AGENT_SLUG = process.env.AGENT_SLUG ?? "external-momentum-demo";
const AGENT_DISPLAY_NAME = process.env.AGENT_DISPLAY_NAME ?? AGENT_SLUG;
const MARKET_ID = process.env.MARKET_ID ?? "eth.1h";
const CHAIN_ID = "eip155:8453"; // Base mainnet — daemon default

const WALLET_PRIVKEY = process.env.WALLET_PRIVKEY ?? "";
if (!WALLET_PRIVKEY.match(/^0x[0-9a-fA-F]{64}$/)) {
  console.error(
    "WALLET_PRIVKEY missing or malformed. Generate one with `node -e \"console.log('0x'+require('crypto').randomBytes(32).toString('hex'))\"` and write it to .env (DO NOT use a wallet that holds real funds).",
  );
  process.exit(1);
}

// ─── State persistence ─────────────────────────────────────────────────────

interface PendingPreimage {
  call_id: string;
  preimage: Record<string, unknown>;
  accepted_at: string;
  horizon_seconds: number;
  market_id: string;
  revealed: boolean;
}

interface AgentState {
  agent_id?: string;
  api_key?: string;
  pending_preimages: PendingPreimage[];
}

function loadState(): AgentState {
  if (!existsSync(STATE_PATH)) return { pending_preimages: [] };
  return JSON.parse(readFileSync(STATE_PATH, "utf-8")) as AgentState;
}

function saveState(state: AgentState): void {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n", "utf-8");
}

// ─── Wallet-only claim ─────────────────────────────────────────────────────

async function claimSlug(account: PrivateKeyAccount): Promise<{ agent_id: string; api_key: string }> {
  const initBody = {
    wallet_to_bind: account.address.toLowerCase(),
    chain_id: CHAIN_ID,
    display_name: AGENT_DISPLAY_NAME,
  };
  console.log(`[claim] init for slug=${AGENT_SLUG}, wallet=${account.address}`);
  const initRes = await fetch(`${MURMUR_API_URL}/v1/agents/${AGENT_SLUG}/claim/wallet-only/init`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(initBody),
  });
  if (!initRes.ok) {
    throw new Error(`claim init failed: ${initRes.status} ${await initRes.text()}`);
  }
  const init = (await initRes.json()) as {
    challenge_id: string;
    sign_message: string;
    agent_id: string;
  };

  const signature = await account.signMessage({ message: init.sign_message });
  console.log(`[claim] signed challenge_id=${init.challenge_id}`);

  const finalizeRes = await fetch(`${MURMUR_API_URL}/v1/agents/${AGENT_SLUG}/claim/wallet-only/finalize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      challenge_id: init.challenge_id,
      signature,
      chain_id: CHAIN_ID,
    }),
  });
  if (!finalizeRes.ok) {
    throw new Error(`claim finalize failed: ${finalizeRes.status} ${await finalizeRes.text()}`);
  }
  const finalized = (await finalizeRes.json()) as {
    agent_id: string;
    api_key: string;
  };
  console.log(`[claim] success: agent_id=${finalized.agent_id}`);
  return { agent_id: finalized.agent_id, api_key: finalized.api_key };
}

async function ensureClaimed(state: AgentState, account: PrivateKeyAccount): Promise<AgentState> {
  if (state.agent_id && state.api_key) {
    console.log(`[claim] already claimed (agent_id=${state.agent_id}); skipping`);
    return state;
  }
  // Slug may already exist on the daemon (a benchmark or another claim
  // attempt). Try claim — daemon rejects with 409/403 if the slug is
  // taken by another wallet.
  const claimed = await claimSlug(account);
  state.agent_id = claimed.agent_id;
  state.api_key = claimed.api_key;
  saveState(state);
  console.log(`[claim] persisted api_key to ${STATE_PATH}`);
  return state;
}

// ─── Pyth Hermes price read (no SDK) ────────────────────────────────────────

const PYTH_ETH_USD =
  "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace";
const HERMES_LATEST = "https://hermes.pyth.network/v2/updates/price/latest";

async function readPythEthUsd(): Promise<{ price: number; publish_time: number }> {
  const res = await fetch(`${HERMES_LATEST}?ids[]=${PYTH_ETH_USD}&parsed=true`);
  if (!res.ok) throw new Error(`hermes ${res.status}`);
  const body = (await res.json()) as {
    parsed: Array<{
      price: { price: string; expo: number; publish_time: number };
    }>;
  };
  const p = body.parsed[0]?.price;
  if (!p) throw new Error("hermes returned no parsed entries");
  return {
    price: Number(p.price) * Math.pow(10, p.expo),
    publish_time: p.publish_time,
  };
}

async function computeSignal(): Promise<{
  side: "BUY" | "SELL";
  confidence: number;
  rationale: string;
}> {
  // Two reads ~10s apart — enough delta for a directional opinion in
  // demo usage. Production agents would maintain a richer signal.
  const p1 = await readPythEthUsd();
  await new Promise((r) => setTimeout(r, 10_000));
  const p2 = await readPythEthUsd();
  const delta = (p2.price - p1.price) / p1.price;
  const side: "BUY" | "SELL" = delta >= 0 ? "BUY" : "SELL";
  // Tighter delta → lower confidence; wider delta → higher confidence.
  // Clamp to the schema-required [0.51, 0.95] range.
  const confidence = Math.min(0.95, Math.max(0.51, 0.55 + Math.abs(delta) * 200));
  const rationale = `pyth-eth-usd ${p1.price.toFixed(2)} → ${p2.price.toFixed(2)} (${(delta * 100).toFixed(3)}%)`;
  return { side, confidence, rationale };
}

// ─── Submit (committed-mode + market_id wire shape) ────────────────────────

async function submitCall(state: AgentState): Promise<void> {
  if (!state.agent_id || !state.api_key) {
    throw new Error("submit requires a claimed agent_id + api_key");
  }
  const signal = await computeSignal();
  const salt = randomBytes(32).toString("hex");
  const client_order_id = randomUUID();
  const nowIso = new Date().toISOString().replace(/\.\d+Z$/, "Z");

  const body = {
    schema_version: 1,
    agent_id: state.agent_id,
    client_order_id,
    market_id: MARKET_ID,
    side: signal.side,
    confidence: Number(signal.confidence.toFixed(4)),
    submitted_at: nowIso,
    rationale: signal.rationale,
    privacy_mode: "committed",
    salt,
  };

  console.log(`[submit] ${MARKET_ID} ${signal.side} conf=${body.confidence} (${signal.rationale})`);
  const res = await fetch(`${MURMUR_API_URL}/v1/calls`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-murmur-agent-id": state.agent_id,
      "x-murmur-api-key": state.api_key,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`submit failed: ${res.status} ${await res.text()}`);
  }
  const accepted = (await res.json()) as {
    call: { call_id: string; accepted_at: string; horizon_hours: number };
    receipt_hash: string;
  };
  console.log(`[submit] accepted call_id=${accepted.call.call_id} receipt=${accepted.receipt_hash}`);

  // Persist the canonical preimage so we can reveal at horizon.
  // Domain is the v0.2.5 market-aware schema (see commit-preimage.ts).
  // Note: market_config_version is what the daemon stamped at acceptance;
  // the receipt's commit.preimage_schema field tells you which domain to
  // use, but for this demo we hardcode the v0.2.5 domain.
  const market = await fetchMarket(MARKET_ID);
  state.pending_preimages.push({
    call_id: accepted.call.call_id,
    accepted_at: accepted.call.accepted_at,
    horizon_seconds: market.horizon_seconds,
    market_id: MARKET_ID,
    preimage: {
      v: 1,
      domain: "murmur-verdict-v0.2.5-commit",
      call_id: accepted.call.call_id,
      agent_wallet: privateKeyToAccount(WALLET_PRIVKEY as `0x${string}`).address.toLowerCase(),
      chain_id: CHAIN_ID,
      side: body.side,
      market_id: MARKET_ID,
      market_config_version: market.market_config_version,
      confidence: body.confidence,
      salt: salt.toLowerCase(),
      t0: accepted.call.accepted_at,
    },
    revealed: false,
  });
  saveState(state);
}

async function fetchMarket(market_id: string): Promise<{
  market_id: string;
  horizon_seconds: number;
  market_config_version: number;
}> {
  const res = await fetch(`${MURMUR_API_URL}/v1/markets`);
  if (!res.ok) throw new Error(`fetch markets failed: ${res.status}`);
  const body = (await res.json()) as { markets: Array<{ market_id: string; horizon_seconds: number; market_config_version: number }> };
  const m = body.markets.find((x) => x.market_id === market_id);
  if (!m) throw new Error(`market ${market_id} not in registry`);
  return m;
}

// ─── Reveal at horizon ──────────────────────────────────────────────────────

async function reveal(state: AgentState): Promise<void> {
  if (!state.agent_id || !state.api_key) return;
  const now = Date.now();
  for (const p of state.pending_preimages) {
    if (p.revealed) continue;
    const horizonMs = Date.parse(p.accepted_at) + p.horizon_seconds * 1000;
    if (now < horizonMs) {
      const remaining = Math.round((horizonMs - now) / 1000);
      console.log(`[reveal] call ${p.call_id} not yet revealable (${remaining}s remaining)`);
      continue;
    }
    console.log(`[reveal] revealing ${p.call_id}`);
    const res = await fetch(`${MURMUR_API_URL}/v1/calls/${p.call_id}/reveal`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-murmur-agent-id": state.agent_id,
        "x-murmur-api-key": state.api_key,
      },
      body: JSON.stringify({ commit_preimage: p.preimage }),
    });
    if (!res.ok) {
      console.error(`[reveal] failed: ${res.status} ${await res.text()}`);
      continue;
    }
    p.revealed = true;
    saveState(state);
    console.log(`[reveal] revealed ${p.call_id}`);
  }
}

// ─── Entrypoint ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const claimOnly = args.has("--claim-only");
  const submitOnly = args.has("--submit-only");
  const revealOnly = args.has("--reveal");

  const account = privateKeyToAccount(WALLET_PRIVKEY as `0x${string}`);
  let state = loadState();

  if (revealOnly) {
    await reveal(state);
    return;
  }

  state = await ensureClaimed(state, account);
  if (claimOnly) return;

  await submitCall(state);
  if (submitOnly) return;

  // Default flow ends here — submit one call and exit. Production
  // agents would loop, monitor, and reveal on their own schedule.
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
