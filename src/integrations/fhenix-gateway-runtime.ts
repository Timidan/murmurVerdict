import { getAddress, type Address, type Hex } from "viem";

import type { FhenixGatewayReceiptTelemetry } from "../verdict/repos/fhenix-gateway-attempt-lifecycle.js";
import type {
  ContractSealedInputPair,
  GatewayReceipt,
} from "./fhenix-gateway-contract.js";
import {
  COFHE_EUINT8_UTYPE,
  COFHE_EUINT16_UTYPE,
  type CofheInput,
} from "./fhenix-gateway-schemas.js";

export type Measured<T> = {
  value: T;
  latencyMs: number;
};

export type ConfirmationState = {
  ready: boolean;
  latestBlockNumber: number | null;
  latestBlockLatencyMs: number | null;
  confirmationsObserved: number | null;
};

export interface FhenixGatewayRuntimeTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** The only security zone CoFHE 0.7 constructs. */
const COFHE_SECURITY_ZONE = 0;

/**
 * CoFHE 0.7 verifies the (euint8, euint16) pair as ONE batch; any mismatch would revert
 * on-chain after burning gas, so it's refused before broadcast:
 *  - signatures byte-identical (one signature covers keccak256(h_0 || h_1));
 *  - utypes euint8 then euint16 (the digest binds type and position);
 *  - securityZone 0 (the contract hardcodes 0 into the digest).
 */
export function contractSealedPair(
  first: CofheInput,
  second: CofheInput,
  field: string,
): ContractSealedInputPair {
  if (first.utype !== COFHE_EUINT8_UTYPE) {
    throw new Error(
      `${field}: first input must be CoFHE euint8 (utype ${COFHE_EUINT8_UTYPE}), got ${first.utype}`,
    );
  }
  if (second.utype !== COFHE_EUINT16_UTYPE) {
    throw new Error(
      `${field}: second input must be CoFHE euint16 (utype ${COFHE_EUINT16_UTYPE}), got ${second.utype}`,
    );
  }
  for (const [label, input] of [
    ["first", first],
    ["second", second],
  ] as const) {
    if (input.security_zone !== COFHE_SECURITY_ZONE) {
      throw new Error(
        `${field}: ${label} input security_zone must be ${COFHE_SECURITY_ZONE}, got ${input.security_zone}`,
      );
    }
  }
  if (first.signature.toLowerCase() !== second.signature.toLowerCase()) {
    throw new Error(
      `${field}: the two inputs carry different signatures; CoFHE 0.7 signs the pair once`,
    );
  }

  return {
    firstHandle: first.ct_hash as Hex,
    secondHandle: second.ct_hash as Hex,
    inputProof: first.signature as Hex,
  };
}


export async function measure<T>(
  nowMs: () => number,
  fn: () => Promise<T>,
): Promise<Measured<T>> {
  const started = nowMs();
  const value = await fn();
  return {
    value,
    latencyMs: Math.max(0, nowMs() - started),
  };
}

/**
 * Race the promise against a setTimeout. On timeout, the underlying network
 * call is not canceled; the Gateway Attempt retry path remains the repair
 * mechanism because client_nonce dedups the eventual onchain result.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
  timers: FhenixGatewayRuntimeTimers = defaultTimers,
): Promise<T> {
  if (timeoutMs <= 0) return promise;
  let timer: unknown = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = timers.setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) timers.clearTimeout(timer);
  }
}

const defaultTimers: FhenixGatewayRuntimeTimers = {
  setTimeout(callback, ms) {
    return setTimeout(callback, ms);
  },
  clearTimeout(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export function receiptTelemetry(input: {
  attempt_id: string;
  receipt: GatewayReceipt;
  receipt_observed_at: string;
  receipt_latency_ms: number;
  confirmation: ConfirmationState | null;
  last_rpc_error: string | null;
}): FhenixGatewayReceiptTelemetry {
  return {
    attempt_id: input.attempt_id,
    receipt_observed_at: input.receipt_observed_at,
    receipt_latency_ms: input.receipt_latency_ms,
    latest_block_latency_ms: input.confirmation?.latestBlockLatencyMs ?? null,
    receipt_status: input.receipt.status ?? null,
    receipt_block_number: safeBlockNumber(input.receipt.blockNumber),
    latest_block_number: input.confirmation?.latestBlockNumber ?? null,
    confirmations_observed: input.confirmation?.confirmationsObserved ?? null,
    gas_used: input.receipt.gasUsed?.toString() ?? null,
    effective_gas_price_wei: input.receipt.effectiveGasPrice?.toString() ?? null,
    last_rpc_error: input.last_rpc_error,
  };
}

export function numberEnv(
  name: string,
  fallback: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return value;
}

export function normalizeAddress(value: string): string {
  return getAddress(value as Address).toLowerCase();
}

export function unixSecondsToIso(value: bigint): string {
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds < 0) {
    throw new Error(`unsafe Fhenix event timestamp: ${value.toString()}`);
  }
  return new Date(seconds * 1000).toISOString().replace(/\.\d+Z$/, "Z");
}

export function safeBlockNumber(value: bigint | undefined): number | null {
  if (value === undefined) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Error text safe to PERSIST and serve via account APIs. RPC URLs carry credentials,
 * so every URL is cut to its host, auth values are redacted and length is capped.
 */
export function redactedErrorText(input: unknown): string {
  const raw = typeof input === "string" ? input : errorMessage(input);
  const stripped = raw
    .replace(
      /https?:\/\/([^\s/"'\\]+)[^\s"'\\]*/gi,
      // The capture is the whole authority; everything before the last `@` is credentials.
      (_m, authority: string) =>
        `https://${String(authority).split("@").pop()}/<redacted>`,
    )
    // Also Authorization values echoed outside a URL ("401 (Basic dXNlcjpwYXNz)").
    .replace(/\b(Basic|Bearer)\s+[A-Za-z0-9+/=._~-]+/gi, "$1 <redacted>");
  return stripped.length > 600 ? `${stripped.slice(0, 600)}…` : stripped;
}
