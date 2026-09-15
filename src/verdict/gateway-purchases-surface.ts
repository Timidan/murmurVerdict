// ─── A wallet's early-access purchases ──────────────────────────────────────
//
//   GET /v2/gateway/entitlements?subscriber=0x…
//
// Unauthenticated: `granted` rows only, each mirroring a public grantDecryptAccess event.
// Wallet proof: full history (in-flight, ambiguous, refund-owed), which is private to that wallet.
// Proof: EIP-191 personal_sign over `murmur:purchases:<lowercased address>:<unix seconds>`, sent as
// `X-Murmur-Subscriber-Auth: <unix_seconds>:<signature>`, ±300s. No nonce table; a replay only reads the signer's own history.
// Never served: nanopay_receipt_id (not even SELECTed) and fee_bps_at_sale.
// Adopted on-chain grants have NULL amount/currency by design: no payment happened.

import type Database from "better-sqlite3";

import { verifySignedMessageAddress } from "./controller-wallet.js";
import { SCHEMA_VERSION } from "./schema.js";
import type { Hex } from "viem";

export const PURCHASES_DEFAULT_LIMIT = 50;
export const PURCHASES_MAX_LIMIT = 200;
/** Freshness bound on the signed timestamp, in seconds, in both directions. */
export const SUBSCRIBER_AUTH_MAX_SKEW_SECONDS = 300;
export const SUBSCRIBER_AUTH_HEADER = "X-Murmur-Subscriber-Auth";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export type PurchasePaymentStatus = "confirmed" | "unknown";

export interface PurchasesSurfaceDeps {
  db: Database.Database;
  /** The deployment whose purchases this daemon can speak for. */
  chain: { chainId: number; sealedVerdictsAddress: string | null } | null;
  now: () => Date;
}

export interface PurchaseRow {
  onchain_call_id: string;
  status: string;
  amount: string | null;
  currency: string | null;
  grant_tx_hash: string | null;
  granted_at: string | null;
  created_at: string;
  producer_agent_slug: string | null;
  reveal_open_at: string | null;
  /** Full-history tier only. */
  refund_status?: string | null;
  /** Full-history tier only. True iff settlement evidence was recorded. */
  payment_confirmed?: boolean;
  /** Full-history tier only. 'confirmed' iff a settlement receipt exists; else 'unknown', never 'failed'. */
  payment_status?: PurchasePaymentStatus;
}

export interface PurchasesResponse {
  status: number;
  body: unknown;
}

interface PurchaseQueryRow {
  id: number;
  onchain_call_id: string;
  status: string;
  amount: string | null;
  currency: string | null;
  grant_tx_hash: string | null;
  granted_at: string | null;
  created_at: string;
  refund_status: string | null;
  /** 0/1 derived in SQL so the receipt id itself never enters this process. */
  has_receipt: number;
  producer_agent_slug: string | null;
  reveal_open_at: string | null;
}

const PURCHASES_SQL = `
  SELECT
    e.id                  AS id,
    e.onchain_call_id     AS onchain_call_id,
    e.status              AS status,
    e.amount              AS amount,
    e.currency            AS currency,
    e.grant_tx_hash       AS grant_tx_hash,
    e.granted_at          AS granted_at,
    e.created_at          AS created_at,
    e.refund_status       AS refund_status,
    CASE WHEN e.nanopay_receipt_id IS NULL THEN 0 ELSE 1 END AS has_receipt,
    a.display_slug        AS producer_agent_slug,
    f.reveal_open_at      AS reveal_open_at
  FROM entitlements e
  LEFT JOIN agents a ON a.agent_id = e.producer_agent_id
  LEFT JOIN fhenix_sealed_calls f
         ON f.chain_id = e.chain_id
        AND lower(f.contract_address) = lower(e.contract_address)
        AND lower(f.onchain_call_id) = lower(e.onchain_call_id)
  WHERE e.chain_id = @chain_id
    AND lower(e.contract_address) = lower(@contract_address)
    AND lower(e.subscriber_address) = lower(@subscriber)
    AND (@granted_only = 0 OR e.status = 'granted')
    AND (
      @cursor_created IS NULL
      OR e.created_at < @cursor_created
      OR (e.created_at = @cursor_created AND e.id < @cursor_id)
    )
  ORDER BY e.created_at DESC, e.id DESC
  LIMIT @limit
`;

/** The exact string a subscriber signs. Lowercased address, no whitespace. */
export function subscriberAuthMessage(
  subscriberAddress: string,
  unixSeconds: number,
): string {
  return `murmur:purchases:${subscriberAddress.toLowerCase()}:${unixSeconds}`;
}

export type SubscriberAuthResult =
  | { kind: "absent" }
  | { kind: "ok" }
  | { kind: "rejected"; status: number; error: string; message: string };

/** A malformed or stale proof is rejected, never downgraded to the public tier. */
export async function verifySubscriberAuth(input: {
  header: string | undefined;
  subscriberAddress: string;
  now: Date;
}): Promise<SubscriberAuthResult> {
  const header = input.header?.trim();
  if (!header) return { kind: "absent" };
  const separator = header.indexOf(":");
  if (separator <= 0) {
    return reject("MalformedSubscriberAuth", `${SUBSCRIBER_AUTH_HEADER} must be "<unix_seconds>:<signature>"`);
  }
  const timestampRaw = header.slice(0, separator).trim();
  const signature = header.slice(separator + 1).trim();
  if (!/^[0-9]+$/.test(timestampRaw) || !/^0x[0-9a-fA-F]+$/.test(signature)) {
    return reject("MalformedSubscriberAuth", "timestamp must be unix seconds and signature 0x hex");
  }
  const unixSeconds = Number(timestampRaw);
  if (!Number.isSafeInteger(unixSeconds)) {
    return reject("MalformedSubscriberAuth", "timestamp is not a representable unix second");
  }
  const skew = Math.abs(Math.floor(input.now.getTime() / 1000) - unixSeconds);
  if (skew > SUBSCRIBER_AUTH_MAX_SKEW_SECONDS) {
    return reject(
      "SubscriberAuthStale",
      `signed timestamp is ${skew}s from now; the limit is ${SUBSCRIBER_AUTH_MAX_SKEW_SECONDS}s`,
    );
  }
  const matches = await verifySignedMessageAddress(
    input.subscriberAddress.toLowerCase(),
    subscriberAuthMessage(input.subscriberAddress, unixSeconds),
    signature as Hex,
  );
  if (!matches) {
    return reject(
      "SubscriberAuthInvalid",
      "the signature does not recover to the subscriber address",
    );
  }
  return { kind: "ok" };
}

export async function listSubscriberPurchasesResponse(
  deps: PurchasesSurfaceDeps,
  input: {
    subscriber: string;
    limit?: number;
    cursor?: string | null;
    authHeader?: string | undefined;
  },
): Promise<PurchasesResponse> {
  const subscriber = input.subscriber.trim();
  if (!ADDRESS.test(subscriber)) {
    return {
      status: 400,
      body: { error: "BadSubscriber", message: "subscriber must be a 0x-prefixed 20-byte address" },
    };
  }
  const contractAddress = deps.chain?.sealedVerdictsAddress ?? null;
  if (!deps.chain || !contractAddress) {
    return {
      status: 503,
      body: {
        error: "FhenixDeploymentUnconfigured",
        message:
          "this daemon has no Fhenix chain + sealed-verdicts address configured, " +
          "so it cannot say which deployment's purchases these would be",
      },
    };
  }

  const auth = await verifySubscriberAuth({
    header: input.authHeader,
    subscriberAddress: subscriber,
    now: deps.now(),
  });
  if (auth.kind === "rejected") {
    return { status: auth.status, body: { error: auth.error, message: auth.message } };
  }
  const fullHistory = auth.kind === "ok";

  const cursor = parseCursor(input.cursor);
  if (cursor === "invalid") {
    return {
      status: 400,
      body: { error: "BadCursor", message: "cursor is not one this endpoint issued" },
    };
  }

  const limit = clamp(input.limit ?? PURCHASES_DEFAULT_LIMIT, 1, PURCHASES_MAX_LIMIT);
  const rows = deps.db.prepare(PURCHASES_SQL).all({
    chain_id: deps.chain.chainId,
    contract_address: contractAddress,
    subscriber,
    granted_only: fullHistory ? 0 : 1,
    cursor_created: cursor?.created_at ?? null,
    cursor_id: cursor?.id ?? 0,
    limit,
  }) as PurchaseQueryRow[];

  const purchases: PurchaseRow[] = rows.map((row) => {
    const base: PurchaseRow = {
      onchain_call_id: row.onchain_call_id,
      status: row.status,
      amount: row.amount,
      currency: row.currency,
      grant_tx_hash: row.grant_tx_hash,
      granted_at: row.granted_at,
      created_at: row.created_at,
      producer_agent_slug: row.producer_agent_slug,
      reveal_open_at: row.reveal_open_at,
    };
    if (!fullHistory) return base;
    const paymentConfirmed = row.has_receipt === 1;
    return {
      ...base,
      refund_status: row.refund_status,
      payment_confirmed: paymentConfirmed,
      payment_status: paymentConfirmed ? "confirmed" : "unknown",
    };
  });

  // Keyset, not offset: entitlements are inserted continuously, and a bare
  // LIMIT would leave older rows permanently unreachable as new ones land.
  const last = rows.length === limit ? rows[rows.length - 1] : undefined;
  return {
    status: 200,
    body: {
      schema_version: SCHEMA_VERSION,
      chain_id: deps.chain.chainId,
      contract_address: contractAddress,
      subscriber: subscriber.toLowerCase(),
      authenticated: fullHistory,
      // 'granted_only' says WHY rows may be missing, so a caller never reads a
      // short public list as a complete purchase history.
      scope: fullHistory ? "full_history" : "granted_only",
      purchases,
      next_cursor: last ? encodeCursor(last.created_at, last.id) : null,
      page: { limit, returned: purchases.length },
    },
  };
}

function reject(error: string, message: string): SubscriberAuthResult {
  return { kind: "rejected", status: 401, error, message };
}

function encodeCursor(createdAt: string, id: number): string {
  return Buffer.from(`${createdAt}|${id}`, "utf8").toString("base64url");
}

function parseCursor(
  raw: string | null | undefined,
): { created_at: string; id: number } | null | "invalid" {
  const value = raw?.trim();
  if (!value) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(value, "base64url").toString("utf8");
  } catch {
    return "invalid";
  }
  const separator = decoded.lastIndexOf("|");
  if (separator <= 0) return "invalid";
  const createdAt = decoded.slice(0, separator);
  const id = Number(decoded.slice(separator + 1));
  if (!createdAt || !Number.isSafeInteger(id) || id < 0) return "invalid";
  return { created_at: createdAt, id };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.floor(value), min), max);
}
