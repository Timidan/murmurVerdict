import { strict as assert } from "node:assert";
import { gatewayBalance, gatewayShortfall } from "./browser-call-access.js";

const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    assert.equal(JSON.parse(String(init?.body)).sources[0].domain, 3, "funding queries use Circle Arbitrum domain 3");
    if (String(url).endsWith("/v1/balances")) {
      return new Response(JSON.stringify({ balances: [{ balance: "0.010000" }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ deposits: [{ status: "pending" }] }), { status: 200 });
  }) as typeof fetch;

  const balance = await gatewayBalance("0x1111111111111111111111111111111111111111");
  assert.equal(balance.spendable, 10_000n, "uses Circle's spendable USDC ledger, not a wallet balance");
  assert.equal(balance.pending, true, "records pending deposits");
  assert.equal(gatewayShortfall(balance, 70_000n), null, "a pending deposit cannot trigger another deposit");

  globalThis.fetch = (async () => new Response("down", { status: 503 })) as typeof fetch;
  await assert.rejects(
    () => gatewayBalance("0x1111111111111111111111111111111111111111"),
    /Gateway balance check failed/,
    "does not treat an unavailable balance ledger as funded or safe to retry",
  );
} finally {
  globalThis.fetch = originalFetch;
}

process.stdout.write("browser call access smoke passed\n");
