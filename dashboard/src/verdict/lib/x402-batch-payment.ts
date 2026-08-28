// ─── The x402 payment a browser can sign ────────────────────────────────────
//
// PURE. A 402 challenge in, an EIP-712 typed-data request and a
// PAYMENT-SIGNATURE header out. No React, no Privy, no network — so the whole
// thing is smoke-testable in node, and the smoke pins it against Circle's own
// SDK (see x402-batch-payment.smoke.ts).
//
// WHY THIS FILE EXISTS AT ALL, given the runtime buyer already has
// `@circle-fin/x402-batching`:
//
//   That package's `/client` entry is one module, and its GatewayClient half
//   does `import { randomBytes } from "crypto"` at the top level. Rollup
//   resolves that before it tree-shakes, so importing ANY export from it fails
//   the dashboard build outright:
//
//     "randomBytes" is not exported by "__vite-browser-external:crypto"
//
//   GatewayClient is a node-only deposit/withdraw client the browser has no use
//   for. What the browser needs is the other half — BatchEvmScheme's payload
//   construction — which is ~30 lines of EIP-712 with no node dependency. So
//   this is that half, and nothing else.
//
// It invents NO Circle constants. The EIP-712 domain is read wholesale out of
// the challenge the daemon served (`extra.name` / `extra.version` /
// `extra.verifyingContract` / the `eip155:` chain id), because the daemon in
// turn reads it from Circle's own facilitator. The only literals here are the
// EIP-3009 `TransferWithAuthorization` field list, which is a public standard,
// and the two validity offsets — both pinned to the SDK by the smoke.

/** Circle's batched-scheme marker on a 402. Anything else is not ours to sign. */
const CIRCLE_BATCHING_NAME = "GatewayWalletBatched";
const CIRCLE_BATCHING_VERSION = "1";
const CIRCLE_BATCHING_SCHEME = "exact";

/**
 * Circle's minimum authorization lifetime, plus their buffer: 7 days + 100s.
 * The seller's `maxTimeoutSeconds` is clamped UP to this, exactly as the SDK
 * does — Gateway batches settlement, so an authorization that expires on the
 * seller's own short timeout would be worthless by the time it settles.
 */
export const GATEWAY_AUTH_VALIDITY_WINDOW_SECONDS = 7 * 24 * 60 * 60 + 100;

/** Backdate, so a payer whose clock runs fast does not sign a not-yet-valid authorization. */
export const AUTH_VALID_AFTER_BACKDATE_SECONDS = 600;

export interface TypedDataField {
  name: string;
  type: string;
}

/**
 * The EIP-3009 struct. Field ORDER is part of the type hash — do not sort it.
 *
 * Mutable by design: `eth_signTypedData_v4` callers (Privy's included) type
 * their parameter as a plain array, and a `readonly` tuple will not satisfy it.
 * The array is rebuilt per call in `buildBatchPayment` so no caller can mutate
 * the shared one.
 */
export const TRANSFER_WITH_AUTHORIZATION_TYPE: readonly TypedDataField[] = [
  { name: "from", type: "address" },
  { name: "to", type: "address" },
  { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" },
  { name: "validBefore", type: "uint256" },
  { name: "nonce", type: "bytes32" },
];

/** One entry of the 402's `accepts[]`, after validation. */
export interface BatchPaymentRequirements {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: {
    name: string;
    version: string;
    verifyingContract: string;
    [key: string]: unknown;
  };
}

/**
 * A 402 body from POST /v2/gateway/calls/:callId/access, parsed.
 *
 * `priceAtoms` is the LOCKED price for this one call — the daemon resolves it
 * from the call's own frozen snapshot, never from the agent's standing listing.
 * It is carried here as the atom string it arrived as; formatting is the view's
 * job (lib/atoms-format).
 */
export interface ParsedChallenge {
  priceAtoms: string;
  currency: string;
  pricingVersion: string;
  requirements: BatchPaymentRequirements;
  /** From `eip155:<id>`. The EIP-712 domain's chainId. */
  chainId: number;
}

export type ChallengeParse =
  | { ok: true; challenge: ParsedChallenge }
  | { ok: false; reason: string };

/**
 * Validate a 402 body into something signable, or say why it is not.
 *
 * Refusing is the right answer for every branch here. A browser that guesses a
 * missing field signs an authorization the facilitator will reject at best, and
 * at worst signs one against the wrong contract.
 */
export function parseAccessChallenge(body: unknown): ChallengeParse {
  if (!isRecord(body)) return { ok: false, reason: "the 402 body was not an object" };
  const accepts = body.accepts;
  if (!Array.isArray(accepts) || accepts.length === 0) {
    return { ok: false, reason: "the 402 carried no payment requirements" };
  }
  const raw = accepts[0];
  if (!isRecord(raw)) return { ok: false, reason: "accepts[0] was not an object" };

  if (raw.scheme !== CIRCLE_BATCHING_SCHEME) {
    return { ok: false, reason: `unsupported payment scheme "${String(raw.scheme)}"` };
  }
  const network = typeof raw.network === "string" ? raw.network : "";
  const chainId = chainIdFromNetwork(network);
  if (chainId === null) {
    return { ok: false, reason: `unsupported network "${network}", expected eip155:<chainId>` };
  }
  if (typeof raw.amount !== "string" || !/^\d+$/.test(raw.amount)) {
    return { ok: false, reason: "the challenge amount is not an atom string" };
  }
  if (!isAddress(raw.payTo)) return { ok: false, reason: "the challenge has no payTo address" };
  if (!isAddress(raw.asset)) return { ok: false, reason: "the challenge has no asset address" };
  if (typeof raw.maxTimeoutSeconds !== "number" || !Number.isFinite(raw.maxTimeoutSeconds)) {
    return { ok: false, reason: "the challenge has no maxTimeoutSeconds" };
  }
  const extra = isRecord(raw.extra) ? raw.extra : null;
  if (
    !extra ||
    extra.name !== CIRCLE_BATCHING_NAME ||
    extra.version !== CIRCLE_BATCHING_VERSION ||
    !isAddress(extra.verifyingContract)
  ) {
    return {
      ok: false,
      reason: "this 402 is not a Circle batched-scheme challenge, so this wallet cannot sign it",
    };
  }

  const priceAtoms = typeof body.price === "string" ? body.price : "";
  if (!/^\d+$/.test(priceAtoms)) {
    return { ok: false, reason: "the 402 quoted no price" };
  }
  // The flat `price` and the signed `amount` come from ONE resolver on the
  // daemon, so they always agree there. Checking it here means a browser can
  // never display one number and sign another — the single failure this whole
  // path exists to make impossible.
  if (priceAtoms !== raw.amount) {
    return {
      ok: false,
      reason: `the quoted price (${priceAtoms}) and the amount to sign (${raw.amount}) disagree`,
    };
  }
  const currency = typeof body.currency === "string" ? body.currency : "";
  const pricingVersion = typeof body.pricingVersion === "string" ? body.pricingVersion : "";
  if (!currency || !pricingVersion) {
    return { ok: false, reason: "the 402 named no currency or pricing version" };
  }

  return {
    ok: true,
    challenge: {
      priceAtoms,
      currency,
      pricingVersion,
      chainId,
      requirements: {
        scheme: raw.scheme,
        network,
        asset: raw.asset,
        amount: raw.amount,
        payTo: raw.payTo,
        maxTimeoutSeconds: raw.maxTimeoutSeconds,
        extra: {
          ...extra,
          name: CIRCLE_BATCHING_NAME,
          version: CIRCLE_BATCHING_VERSION,
          verifyingContract: extra.verifyingContract,
        },
      },
    },
  };
}

/**
 * The EIP-3009 authorization, in the JSON-RPC encoding (uint256 as decimal
 * strings).
 *
 * A `type` and not an `interface`, deliberately: only a type alias gets TS's
 * implicit index signature, and without one this will not satisfy the
 * `Record<string, unknown>` that `eth_signTypedData_v4` callers type their
 * message as.
 */
export type BatchAuthorization = {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
};

/**
 * An `eth_signTypedData_v4` request. Values are STRINGS, not BigInt: this goes
 * to Privy over JSON-RPC, which has no BigInt. The EIP-712 digest is identical
 * either way — the smoke proves it against the SDK's BigInt-valued version.
 *
 * `types` deliberately omits `EIP712Domain`; both viem (what the SDK signs
 * with) and Privy derive it from the domain's own keys, in key order. Adding it
 * by hand here would be a second definition of the domain to keep in step.
 */
export interface TypedDataRequest {
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: string;
  };
  types: { TransferWithAuthorization: TypedDataField[] };
  primaryType: "TransferWithAuthorization";
  message: BatchAuthorization;
}

/** 32 random bytes, hex. WebCrypto — present in every browser and in node ≥19. */
export function createPaymentNonce(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Build the authorization and the typed data to sign for it.
 *
 * `nowSeconds` and `nonce` are parameters rather than reads of the clock and
 * the RNG, so the smoke can hold both fixed and compare byte-for-byte with the
 * SDK's output. Production callers omit them.
 */
export function buildBatchPayment(input: {
  challenge: ParsedChallenge;
  /** The payer, and therefore the subscriber: whoever signs receives the grant. */
  from: string;
  nowSeconds?: number;
  nonce?: string;
}): { authorization: BatchAuthorization; typedData: TypedDataRequest } {
  const { challenge, from } = input;
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const validity = Math.max(
    challenge.requirements.maxTimeoutSeconds,
    GATEWAY_AUTH_VALIDITY_WINDOW_SECONDS,
  );
  const authorization: BatchAuthorization = {
    from,
    to: challenge.requirements.payTo,
    value: challenge.requirements.amount,
    validAfter: String(now - AUTH_VALID_AFTER_BACKDATE_SECONDS),
    validBefore: String(now + validity),
    nonce: input.nonce ?? createPaymentNonce(),
  };
  return {
    authorization,
    typedData: {
      // Key order is load-bearing: with no explicit EIP712Domain type, both
      // signers derive the domain's field list from these keys in this order.
      domain: {
        name: challenge.requirements.extra.name,
        version: challenge.requirements.extra.version,
        chainId: challenge.chainId,
        verifyingContract: challenge.requirements.extra.verifyingContract,
      },
      types: { TransferWithAuthorization: [...TRANSFER_WITH_AUTHORIZATION_TYPE] },
      primaryType: "TransferWithAuthorization",
      message: authorization,
    },
  };
}

/**
 * What the buyer is buying. Circle rejects a payload without it, and it is an
 * OBJECT, not a URL string.
 *
 * Note it sits OUTSIDE the EIP-712 signature, which covers only
 * from/to/value/validity/nonce. That is exactly why murmur binds a payment to
 * its resource on the signed authorization instead of on this envelope.
 */
export interface PaymentResource {
  url: string;
  description: string;
  mimeType: string;
}

export function accessResource(absoluteAccessUrl: string, onchainCallId: string): PaymentResource {
  return {
    url: absoluteAccessUrl,
    description: `Early private decrypt access to murmur sealed call ${onchainCallId}`,
    mimeType: "application/json",
  };
}

/**
 * base64 of the x402 envelope — the PAYMENT-SIGNATURE header value.
 *
 * UTF-8 first, then base64: the daemon decodes with
 * `Buffer.from(header, "base64").toString("utf8")`, and `btoa` alone throws on
 * any code point above U+00FF.
 */
export function encodePaymentHeader(input: {
  requirements: BatchPaymentRequirements;
  authorization: BatchAuthorization;
  signature: string;
  resource: PaymentResource;
  x402Version?: number;
}): string {
  const envelope = {
    x402Version: input.x402Version ?? 1,
    resource: input.resource,
    accepted: input.requirements,
    payload: { authorization: input.authorization, signature: input.signature },
  };
  const bytes = new TextEncoder().encode(JSON.stringify(envelope));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function chainIdFromNetwork(network: string): number | null {
  const match = /^eip155:(\d+)$/.exec(network);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAddress(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}
