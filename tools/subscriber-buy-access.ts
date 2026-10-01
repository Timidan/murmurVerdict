#!/usr/bin/env tsx
/**
 * Subscriber-side payer: buy early decrypt access to a sealed call.
 *
 * The counterpart to tools/subscriber-unseal-granted-call.ts. That tool
 * decrypts a call you have ALREADY been granted; this one is how you get the
 * grant. Together they are the whole consumer story, and until now only the
 * second half existed — which meant the paid path had never been driven from
 * the buyer's side at all.
 *
 * Flow:
 *   1. POST /v2/gateway/calls/:callId/access with no payment  → 402 + challenge
 *   2. Ensure the buyer has USDC deposited in Circle's Gateway wallet
 *      (the batched x402 scheme spends from that balance, not from the wallet)
 *   3. Sign the payment authorization against the challenge
 *   4. Re-POST with PAYMENT-SIGNATURE → murmur reserves, settles, and queues
 *      the on-chain grant
 *   5. Poll /access/status until the grant lands
 *
 * Required env:
 *   SUBSCRIBER_PRIVATE_KEY   the buyer (pays USDC, receives decrypt access)
 *   ARBITRUM_RPC_URL          Arbitrum Sepolia RPC
 *   MURMUR_DAEMON_URL        default http://localhost:8080
 *
 * Usage: tsx tools/subscriber-buy-access.ts <onchainCallId>
 */
import "dotenv/config";
import { createPublicClient, getAddress, http, parseAbi } from "viem";
import { arbitrumSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { BatchEvmScheme, GatewayClient } from "@circle-fin/x402-batching/client";
import { subscriberAuthMessage } from "../src/verdict/gateway-purchases-surface.js";

const onchainCallId = process.argv[2];
if (!onchainCallId || !/^0x[0-9a-fA-F]{64}$/.test(onchainCallId)) {
  console.error("usage: tsx tools/subscriber-buy-access.ts <onchainCallId (0x + 64 hex)>");
  process.exit(1);
}

const daemon = (process.env.MURMUR_DAEMON_URL ?? "http://localhost:8080").replace(/\/$/, "");
const key = process.env.SUBSCRIBER_PRIVATE_KEY?.trim();
if (!key || !/^0x[0-9a-f]{64}$/i.test(key)) {
  console.error("SUBSCRIBER_PRIVATE_KEY is required (0x + 64 hex)");
  process.exit(1);
}
const account = privateKeyToAccount(key as `0x${string}`);
console.log(`[buy] subscriber ${account.address}`);

// ── 1. ask for access with no payment; murmur answers with the terms ────────
const challengeRes = await fetch(`${daemon}/v2/gateway/calls/${onchainCallId}/access`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
});
const challenge = (await challengeRes.json()) as {
  error?: string;
  accepts?: unknown[];
  price?: string;
  currency?: string;
  pricingVersion?: string;
};
if (challengeRes.status !== 402) {
  console.error(`[buy] expected 402, got ${challengeRes.status}:`, JSON.stringify(challenge));
  process.exit(1);
}
const requirements = challenge.accepts?.[0] as {
  network: string;
  amount: string;
  payTo: string;
  asset: string;
} | undefined;
if (!requirements) {
  console.error("[buy] 402 carried no payment requirements");
  process.exit(1);
}
console.log(
  `[buy] terms: ${challenge.price} ${challenge.currency} (pricing ${challenge.pricingVersion}) ` +
    `to ${requirements.payTo} on ${requirements.network}`,
);

// ── 2. the batched scheme spends a GATEWAY balance, not the wallet balance ──
const gateway = new GatewayClient({
  chain: "arbitrumSepolia",
  privateKey: key as `0x${string}`,
  ...(process.env.ARBITRUM_RPC_URL ? { rpcUrl: process.env.ARBITRUM_RPC_URL } : {}),
});
const show = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

// SPENDABLE balance comes from Circle's balance API, not from the contract.
//
// The two obvious reads answer different questions, and the difference is the
// whole bug:
//
//   availableBalance() on-chain   what has been DEPOSITED (minus withdrawals).
//                                 It does not know about the off-chain batched
//                                 spends the x402 scheme makes, so after a
//                                 purchase it still reports the pre-purchase
//                                 figure. Observed live: the contract said
//                                 133000 atoms while Circle said 121000 — the
//                                 12000 just spent was invisible on-chain.
//
//   REST /v1/balances             what is SPENDABLE right now. Deposits become
//                                 spendable only after Circle confirms them,
//                                 and spends are deducted immediately on a successful
//                                 /settle.
//
// Only the second answers "can this purchase succeed", so it is the number the
// preflight uses. An earlier iteration of this tool read the contract BECAUSE
// GatewayClient.getBalances() returned 0 while a deposit had plainly landed —
// but that helper calls this same endpoint, and the 0 was correct: the deposit
// had confirmed on-chain and was not yet spendable. Reading the contract to
// "fix" that just replaced a true answer with a flattering one.
const needed = BigInt(requirements.amount);
const chainClient = createPublicClient({
  chain: arbitrumSepolia,
  transport: http(process.env.ARBITRUM_RPC_URL),
});
const gatewayWallet = getAddress(
  (requirements as unknown as { extra?: { verifyingContract?: string } }).extra
    ?.verifyingContract ?? "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
);

/**
 * Circle's cross-chain domain id, which is NOT the EVM chain id.
 *
 * Arbitrum Sepolia only. The deposit client and the diagnostic RPC client above
 * are both pinned to arbitrumSepolia, so accepting a mainnet challenge here would
 * read mainnet funds while depositing testnet USDC. This is a testnet buyer
 * tool; it says so by refusing rather than by half-supporting mainnet.
 */
const CIRCLE_DOMAIN_BY_CHAIN: Record<number, number> = { 421614: 3 };

// Circle's own facilitator, matching what the daemon settles against
// (daemon-runtime-adapters picks Circle's fixed URL and offers no override).
// Deliberately NOT configurable: pointing the preflight at a different ledger
// than the settlement would report funds that do not exist where it counts.
const FACILITATOR_URL = "https://gateway-api-testnet.circle.com";

const paymentNetwork = requirements.network;
const paymentAsset = getAddress(requirements.asset);

async function spendableAtoms(): Promise<bigint> {
  const chainId = Number(paymentNetwork.split(":")[1]);
  const domain = CIRCLE_DOMAIN_BY_CHAIN[chainId];
  if (domain === undefined) {
    throw new Error(
      `this tool only buys on Arbitrum Sepolia (421614); the challenge is for chain ` +
        `${chainId}. Its deposit and RPC clients are pinned to Arbitrum Sepolia, so ` +
        `running it here would read one chain's funds and spend another's.`,
    );
  }
  const res = await fetch(`${FACILITATOR_URL}/v1/balances`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: "USDC",
      sources: [{ domain, depositor: account.address }],
    }),
  });
  if (!res.ok) throw new Error(`balance query failed: HTTP ${res.status}`);
  const body = (await res.json()) as { balances?: { balance?: string }[] };
  const human = body.balances?.[0]?.balance;
  if (human === undefined) throw new Error(`balance query returned no entry for ${account.address}`);
  // "0.121000" → atoms. Fixed 6dp for USDC; parse without float rounding.
  const [whole = "0", frac = ""] = human.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, "0").slice(0, 6));
}

/**
 * The contract's view, purely as a diagnostic. NON-FATAL: an unavailable or
 * rate-limited RPC must not stop a purchase Circle has already said is funded.
 */
async function depositedAtoms(): Promise<bigint | null> {
  try {
    return (await chainClient.readContract({
      address: gatewayWallet,
      abi: parseAbi([
        "function availableBalance(address token, address account) view returns (uint256)",
      ]),
      functionName: "availableBalance",
      args: [paymentAsset, account.address],
    })) as bigint;
  } catch {
    return null;
  }
}

let available = await spendableAtoms();
const deposited = await depositedAtoms();
console.log(
  `[buy] spendable ${available} atoms (need ${needed})` +
    (deposited !== null && deposited !== available
      ? `; contract shows ${deposited} deposited — ${deposited - available} atoms either spent ` +
        `and awaiting batch settlement, or deposited and not yet spendable`
      : ""),
);

if (available < needed) {
  // Deposit AT MOST ONCE per run, then wait for it to become spendable.
  //
  // Depositing on every short balance was the trap: Circle makes a deposit
  // spendable only after confirmation, so a re-run inside that window saw the
  // same short balance and deposited 20× again, while the payment still failed
  // insufficient_balance. Money in, nothing bought, repeatedly.
  if (deposited !== null && deposited - available >= needed) {
    console.log(
      `[buy] NOT depositing: ${deposited - available} atoms are already on-chain but ` +
        `not yet spendable. Waiting for Circle to confirm the deposit.`,
    );
  } else {
    const topUp = (Number(needed) / 1e6) * 20;
    console.log(`[buy] gateway balance short; depositing ${topUp} USDC (once)`);
    console.log(`[buy] deposited: ${show(await gateway.deposit(String(topUp)))}`);
  }
  // Poll until spendable rather than signing an authorization that would be
  // rejected. Bounded, and it says what it is waiting for.
  const deadline = Date.now() + 20 * 60_000;
  while (available < needed && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 30_000));
    available = await spendableAtoms();
    console.log(`[buy] waiting for spendable funds: ${available}/${needed} atoms`);
  }
  if (available < needed) {
    throw new Error(
      `still only ${available} spendable atoms of ${needed} after 20 minutes. ` +
        `Do NOT re-run blindly — a further deposit would stack on one already pending.`,
    );
  }
}

// ── 3. sign the authorization against murmur's exact challenge ──────────────
// BatchEvmScheme directly rather than registerBatchScheme: the latter wants a
// full x402 client to register itself INTO, and there is no such client here —
// this tool talks to murmur over plain fetch. A viem account already satisfies
// BatchEvmSigner (address + signTypedData), which is all the scheme needs.
const scheme = new BatchEvmScheme({
  address: account.address,
  signTypedData: (params: unknown) => account.signTypedData(params as never),
} as never);
const signed = await scheme.createPaymentPayload(1, requirements as never);

// The decoded header IS the paymentPayload murmur forwards to Circle, so it
// needs Circle's required top-level fields too — `x402Version` and `resource`.
// Sending only `{accepted, payload}` got a precise 400 back:
// "paymentPayload.x402Version: Required, paymentPayload.resource: Required".
//
// `resource` names what is being bought. Note it is NOT covered by the
// EIP-712 signature, which is exactly why murmur's payment→resource binding
// keys on the signed authorization (network/payTo/amount/from/nonce) rather
// than on this envelope.
// Circle's PaymentPayload.resource is an OBJECT — {url, description,
// mimeType} — not a URL string. Sending the string got a precise 400:
// "paymentPayload.resource: Expected object, received string".
const resource = {
  url: `${daemon}/v2/gateway/calls/${onchainCallId}/access`,
  description: `Early private decrypt access to murmur sealed call ${onchainCallId}`,
  mimeType: "application/json",
};
const header = Buffer.from(
  JSON.stringify({
    x402Version: signed.x402Version ?? 1,
    resource,
    accepted: requirements,
    payload: signed.payload,
  }),
  "utf8",
).toString("base64");

// ── 4. present it ───────────────────────────────────────────────────────────
const paidRes = await fetch(`${daemon}/v2/gateway/calls/${onchainCallId}/access`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "PAYMENT-SIGNATURE": header },
});
const paid = (await paidRes.json()) as Record<string, unknown>;
console.log(`[buy] purchase HTTP ${paidRes.status}:`, show(paid));
if (paidRes.status >= 400) process.exit(1);

// ── 5. the grant is broadcast asynchronously; wait for it ───────────────────
// 100 × 5s ≈ 8m20s. Sized to OUTLAST the slowest honest answer, not the
// fastest: a purchase interrupted mid-settle reaches its terminal
// grant_failed_refund_due only after the reconciler's full budget — 30s
// reserve grace + 8 retries × 30s ≈ 5-6 minutes, measured live at 5m03s and
// 5m58s. The previous 60-poll (5 min) budget expired ~30s before that, so the
// one message that tells the buyer a refund is owed was unreachable.
for (let i = 0; i < 100; i++) {
  const unixSeconds = Math.floor(Date.now() / 1000);
  const signature = await account.signMessage({
    message: subscriberAuthMessage(account.address, unixSeconds),
  });
  const st = await fetch(
    `${daemon}/v2/gateway/calls/${onchainCallId}/access/status?subscriber=${account.address}`,
    { headers: { "X-Murmur-Subscriber-Auth": `${unixSeconds}:${signature}` } },
  );
  const s = (await st.json()) as {
    status?: string;
    grant?: { onchainGranted?: boolean; txHash?: string | null };
    lastError?: string | null;
  };
  console.log(`[buy] poll ${i + 1}: status=${s.status} granted=${s.grant?.onchainGranted} tx=${s.grant?.txHash ?? "-"}`);
  if (s.grant?.onchainGranted) {
    console.log(`[buy] GRANTED — now run: tsx tools/subscriber-unseal-granted-call.ts ${onchainCallId}`);
    process.exit(0);
  }
  if (s.status === "grant_failed_refund_due") {
    console.error(`[buy] grant FAILED after payment; refund is manual: ${s.lastError}`);
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 5_000));
}
console.error("[buy] timed out waiting for the grant");
process.exit(1);
