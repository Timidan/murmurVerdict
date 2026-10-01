// The browser payment builder, pinned to Circle's own SDK.
//
// dashboard/src/verdict/lib/x402-batch-payment.ts reimplements the payload half
// of `BatchEvmScheme` because the SDK's `/client` entry cannot be bundled for a
// browser (its GatewayClient half imports node's `crypto` at the top level, and
// Rollup resolves that before it tree-shakes). A reimplementation of somebody
// else's signing format is only safe while something proves it still agrees
// with theirs — so this smoke runs BOTH, on the same inputs, and asserts:
//
//   1. the typed data is structurally identical, key order included, and
//   2. it hashes to the same EIP-712 digest, which is what a signature is over.
//
// (2) is the one that survives cosmetic differences the browser cannot control
// — Privy sends decimal strings over JSON-RPC where viem sends BigInt, and
// address checksum case is not part of the encoding. If Circle ever changes
// their domain, their field order, or their validity clamp, this fails.
//
// The SDK import is node-only and that is fine: this file never ships to a
// browser. It is the reason the check can exist at all.

import { strict as assert } from "node:assert";
import { hashTypedData, type TypedDataDomain } from "viem";
import {
  BatchEvmScheme,
  GATEWAY_AUTH_VALIDITY_WINDOW_SECONDS as SDK_VALIDITY_WINDOW,
} from "@circle-fin/x402-batching/client";

import {
  buildBatchPayment,
  encodePaymentHeader,
  accessResource,
  createPaymentNonce,
  parseAccessChallenge,
  GATEWAY_AUTH_VALIDITY_WINDOW_SECONDS,
} from "./x402-batch-payment.js";

process.stdout.write("murmur x402 batch payment smoke\n");

const PAYER = "0x1111111111111111111111111111111111111111";
const SELLER = "0x2222222222222222222222222222222222222222";
const GATEWAY_WALLET = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";
const USDC = "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d";
const CALL_ID = `0x${"ab".repeat(32)}`;

/** A 402 exactly as entitlementAccessResponse builds it. */
function challengeBody(over: Record<string, unknown> = {}) {
  return {
    error: "PaymentRequired",
    accepts: [
      {
        scheme: "exact",
        network: "eip155:421614",
        asset: USDC,
        amount: "70000",
        payTo: SELLER,
        maxTimeoutSeconds: SDK_VALIDITY_WINDOW,
        extra: {
          name: "GatewayWalletBatched",
          version: "1",
          verifyingContract: GATEWAY_WALLET,
        },
      },
    ],
    price: "70000",
    currency: "USDC",
    pricingVersion: "v2",
    ...over,
  };
}

// ─── The constant is Circle's, not ours ─────────────────────────────────────

assert.equal(
  GATEWAY_AUTH_VALIDITY_WINDOW_SECONDS,
  SDK_VALIDITY_WINDOW,
  "the validity window must be the SDK's 7 days + 100s, not a number we picked",
);

// ─── Parsing a real 402 ─────────────────────────────────────────────────────

const parsed = parseAccessChallenge(challengeBody());
assert.ok(parsed.ok, "a well-formed 402 parses");
assert.equal(parsed.challenge.priceAtoms, "70000");
assert.equal(parsed.challenge.currency, "USDC");
assert.equal(parsed.challenge.pricingVersion, "v2");
assert.equal(parsed.challenge.chainId, 421614, "the chain id comes from eip155:<id>");
assert.equal(parsed.challenge.requirements.extra.verifyingContract, GATEWAY_WALLET);

// ─── …and refusing everything else ──────────────────────────────────────────

const refusals: Array<[string, unknown]> = [
  ["a non-object body", "402 Payment Required"],
  ["no accepts array", { price: "70000", currency: "USDC", pricingVersion: "v2" }],
  ["an empty accepts array", challengeBody({ accepts: [] })],
  [
    "a scheme this wallet cannot sign",
    challengeBody({ accepts: [{ ...challengeBody().accepts[0], scheme: "permit" }] }),
  ],
  [
    "a network that is not eip155",
    challengeBody({ accepts: [{ ...challengeBody().accepts[0], network: "solana:mainnet" }] }),
  ],
  [
    "a non-Circle challenge (no verifyingContract)",
    challengeBody({
      accepts: [{ ...challengeBody().accepts[0], extra: { name: "GatewayWalletBatched", version: "1" } }],
    }),
  ],
  [
    "an amount that is not atoms",
    challengeBody({ accepts: [{ ...challengeBody().accepts[0], amount: "0.07" }], price: "0.07" }),
  ],
  ["no price", challengeBody({ price: undefined })],
  ["no currency", challengeBody({ currency: undefined })],
];
for (const [what, body] of refusals) {
  const result = parseAccessChallenge(body);
  assert.equal(result.ok, false, `refuses ${what}`);
}

// The one that matters most: a body whose DISPLAYED price and SIGNED amount
// disagree is refused outright rather than resolved in either direction.
{
  const skewed = parseAccessChallenge(challengeBody({ price: "50000" }));
  assert.equal(skewed.ok, false, "a quote that does not match the amount to sign is refused");
  assert.ok(
    !skewed.ok && skewed.reason.includes("50000") && skewed.reason.includes("70000"),
    "and the refusal names both numbers",
  );
}

// ─── The payload, against Circle's ──────────────────────────────────────────

const NOW = 1_780_000_000;
const NONCE = `0x${"3c".repeat(32)}`;

/** BigInt → string, so the SDK's viem-shaped values compare with JSON-RPC ones. */
const normalize = (value: unknown) =>
  JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));

// The digest is what a signature actually covers. Hashing both proves the
// string-vs-BigInt encoding is cosmetic, and that the domain derives the same
// way with no explicit EIP712Domain entry.
//
// The uint256 coercion here is the ONLY difference the smoke is allowed to
// paper over, and it is exactly the JSON-RPC ↔ viem boundary Privy crosses
// internally. Everything else — domain, key order, field list — is compared
// as-is.
function digest(typedData: unknown): `0x${string}` {
  const td = typedData as {
    domain: Record<string, unknown>;
    types: Record<string, { name: string; type: string }[]>;
    message: Record<string, unknown>;
  };
  const message: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(td.message)) {
    const field = td.types.TransferWithAuthorization?.find((f) => f.name === key);
    message[key] = field?.type === "uint256" ? BigInt(value as string | bigint) : value;
  }
  return hashTypedData({
    domain: td.domain as TypedDataDomain,
    types: { TransferWithAuthorization: td.types.TransferWithAuthorization! },
    primaryType: "TransferWithAuthorization",
    message,
  });
}

/**
 * Circle's own scheme, run on one challenge with the clock and the RNG frozen
 * to NOW/NONCE — the only way the SDK exposes either, since
 * createPaymentPayload reads both from globals. Restored in a `finally` so one
 * throwing case cannot leave the rest of this file running on a stopped clock.
 */
async function sdkPaymentFor(requirements: unknown): Promise<{
  schemeName: string;
  x402Version: number;
  authorization: unknown;
  typedData: unknown;
}> {
  let captured: unknown = null;
  const scheme = new BatchEvmScheme({
    address: PAYER,
    signTypedData: async (params: unknown) => {
      captured = params;
      return "0xsigned";
    },
  } as never);

  const realNow = Date.now;
  const realRandom = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
  Date.now = () => NOW * 1000;
  globalThis.crypto.getRandomValues = (<T extends ArrayBufferView | null>(array: T): T => {
    const bytes = array as unknown as Uint8Array;
    for (let i = 0; i < bytes.length; i++) bytes[i] = 0x3c;
    return array;
  }) as typeof globalThis.crypto.getRandomValues;

  try {
    const payload = await scheme.createPaymentPayload(1, requirements as never);
    assert.ok(captured, "the SDK asked its signer for typed data");
    return {
      schemeName: scheme.scheme,
      x402Version: payload.x402Version,
      authorization: (payload.payload as { authorization: unknown }).authorization,
      typedData: captured,
    };
  } finally {
    Date.now = realNow;
    globalThis.crypto.getRandomValues = realRandom;
  }
}

/**
 * BOTH sides of the validity clamp, each against the real SDK.
 *
 * This used to compare the two builders at one timeout — Circle's own window —
 * and check the short-timeout case against our builder alone. At that single
 * point `Math.max(published, window)` and `window` are the same number, so the
 * comparison could not tell the two apart: a Circle that stopped clamping,
 * clamped DOWN, or moved the constant would still have matched. The clamp is
 * the one branch in this file whose behaviour is somebody else's decision, so
 * every branch of it is now run through their code and ours.
 */
const clampCases: Array<{ label: string; maxTimeoutSeconds: number; validity: number }> = [
  {
    label: "a 60s seller timeout, clamped UP to Circle's window",
    maxTimeoutSeconds: 60,
    validity: SDK_VALIDITY_WINDOW,
  },
  {
    label: "exactly Circle's window",
    maxTimeoutSeconds: SDK_VALIDITY_WINDOW,
    validity: SDK_VALIDITY_WINDOW,
  },
  {
    label: "a seller timeout LONGER than Circle's window, which is kept",
    maxTimeoutSeconds: SDK_VALIDITY_WINDOW + 86_400,
    validity: SDK_VALIDITY_WINDOW + 86_400,
  },
];

/** The `maxTimeoutSeconds === SDK_VALIDITY_WINDOW` case, reused below. */
let canonical: { mine: ReturnType<typeof buildBatchPayment>; digest: `0x${string}` } | null = null;

for (const c of clampCases) {
  const challenge = parseAccessChallenge(
    challengeBody({
      accepts: [{ ...challengeBody().accepts[0], maxTimeoutSeconds: c.maxTimeoutSeconds }],
    }),
  );
  assert.ok(challenge.ok, `${c.label}: the challenge parses`);

  const sdk = await sdkPaymentFor(challenge.challenge.requirements);
  assert.equal(sdk.schemeName, "exact", "the scheme name the daemon's parser requires");
  assert.equal(sdk.x402Version, 1);

  const built = buildBatchPayment({
    challenge: challenge.challenge,
    from: PAYER,
    nowSeconds: NOW,
    nonce: NONCE,
  });

  assert.equal(
    normalize(built.typedData),
    normalize(sdk.typedData),
    `${c.label}: the typed data is identical to the SDK's, key order included`,
  );
  // The authorization on the wire, too — this is the object murmur's broker
  // reads `from` and `nonce` out of.
  assert.equal(
    normalize(built.authorization),
    normalize(sdk.authorization),
    `${c.label}: the authorization sent to the facilitator matches the SDK's byte for byte`,
  );
  assert.equal(
    digest(built.typedData),
    digest(sdk.typedData),
    `${c.label}: same EIP-712 digest → the same signature is produced`,
  );

  // Agreement alone would still pass if both sides drifted together, so the
  // absolute numbers are pinned as well.
  assert.equal(
    built.authorization.validBefore,
    String(NOW + c.validity),
    `${c.label}: validBefore`,
  );
  assert.equal(built.authorization.validAfter, String(NOW - 600), `${c.label}: backdated 10 minutes`);

  if (c.maxTimeoutSeconds === SDK_VALIDITY_WINDOW) {
    canonical = { mine: built, digest: digest(built.typedData) };
  }
}

assert.ok(canonical, "the canonical challenge is one of the clamp cases");
const mine = canonical.mine;
const sdkDigest = canonical.digest;

// Address case is not part of the encoding, so a wallet that hands back a
// lowercase address still signs the identical digest. Worth pinning: this file
// deliberately does NOT pull viem's getAddress into the browser bundle.
{
  const lower = buildBatchPayment({
    challenge: parsed.ok ? parsed.challenge : (null as never),
    from: PAYER.toLowerCase(),
    nowSeconds: NOW,
    nonce: NONCE,
  });
  assert.equal(digest(lower.typedData), sdkDigest, "checksum case does not change what is signed");
}

// ─── The header the daemon parses ───────────────────────────────────────────

{
  const header = encodePaymentHeader({
    requirements: parsed.ok ? parsed.challenge.requirements : (null as never),
    authorization: mine.authorization,
    signature: "0xsigned",
    resource: accessResource(`https://api.example/v2/gateway/calls/${CALL_ID}/access`, CALL_ID),
  });
  // Decoded exactly the way src/verdict/entitlement-access-surface.ts does it.
  const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as {
    x402Version: number;
    resource: { url: string; description: string; mimeType: string };
    accepted: { scheme: string; amount: string; payTo: string };
    payload: { authorization: { from: string; nonce: string }; signature: string };
  };
  assert.equal(decoded.x402Version, 1);
  assert.equal(decoded.accepted.scheme, "exact", "the daemon's parser requires exactly this");
  assert.equal(decoded.accepted.amount, "70000");
  assert.equal(decoded.accepted.payTo, SELLER);
  assert.equal(decoded.payload.authorization.from, PAYER, "the payer IS the subscriber");
  assert.equal(decoded.payload.authorization.nonce, NONCE, "the nonce the broker binds on");
  assert.equal(decoded.payload.signature, "0xsigned");
  // Circle rejects a payload without these two, with a precise 400 each.
  assert.equal(typeof decoded.resource, "object", "resource is an object, not a URL string");
  assert.ok(decoded.resource.url.endsWith(`/v2/gateway/calls/${CALL_ID}/access`));
  assert.ok(decoded.resource.description.includes(CALL_ID));
}

// ─── The nonce ──────────────────────────────────────────────────────────────

{
  const a = createPaymentNonce();
  const b = createPaymentNonce();
  assert.match(a, /^0x[0-9a-f]{64}$/, "32 bytes, hex — the bytes32 the type declares");
  assert.notEqual(a, b, "a fresh nonce per payment; the facilitator replay-protects on it");
}

process.stdout.write("OK x402 batch payment smoke\n");
