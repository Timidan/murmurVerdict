import {
  createHash,
  createPrivateKey,
  randomBytes,
  randomUUID,
  sign,
} from "node:crypto";
import type { Address, WalletClient } from "viem";

import type {
  CofheInput,
  GatewaySealedCallBody,
} from "./fhenix-gateway-schemas.js";

import {
  buildRuntimeKeyPopSigningString,
  POP_HEADER_NONCE,
  POP_HEADER_SIGNATURE,
  POP_HEADER_TIMESTAMP,
} from "../verdict/auth/runtime-key-pop.js";

export const AGENT_GATEWAY_PATH = "/v2/gateway/calls";

export interface GatewayPopHeadersInput {
  audience: string;
  bodyBytes: Buffer;
  nonce?: string;
  runtimeKey: string;
  runtimeKeyId: string;
  signingPrivateKey: string;
  timestamp?: number;
}

/** CoFHE connect reads only account.address; this shim cannot sign transactions. */
export function addressOnlyWalletClient(address: Address): WalletClient {
  return { account: { address } } as unknown as WalletClient;
}

export function buildGatewayPopHeaders(
  input: GatewayPopHeadersInput,
): Record<string, string> {
  const timestamp = input.timestamp ?? Math.floor(Date.now() / 1000);
  const nonce = input.nonce ?? randomBytes(16).toString("hex");
  const rawBodySha256 = createHash("sha256").update(input.bodyBytes).digest("hex");
  const signingString = buildRuntimeKeyPopSigningString({
    audience: input.audience,
    runtimeKeyId: input.runtimeKeyId,
    timestamp,
    nonce,
    method: "POST",
    pathAndQuery: AGENT_GATEWAY_PATH,
    rawBodySha256,
  });
  const key = createPrivateKey({
    key: Buffer.from(input.signingPrivateKey, "base64"),
    format: "der",
    type: "pkcs8",
  });
  const signature = sign(null, Buffer.from(signingString, "utf8"), key).toString("hex");

  return {
    "Content-Type": "application/json",
    "X-Murmur-Runtime-Key": input.runtimeKey,
    [POP_HEADER_TIMESTAMP]: String(timestamp),
    [POP_HEADER_NONCE]: nonce,
    [POP_HEADER_SIGNATURE]: signature,
  };
}

export function buildAgentSealedCallBody(input: {
  binaryInput: CofheInput;
  clientNonce?: `0x${string}`;
  clientOrderId?: string;
  confidenceInput: CofheInput;
  configVersion: number;
  marketSourceId: string;
  strategyTag: string;
}): GatewaySealedCallBody {
  return {
    marketRef: {
      protocol: "polymarket-gamma",
      sourceId: input.marketSourceId,
      configVersion: input.configVersion,
    },
    client_order_id: input.clientOrderId ?? randomUUID(),
    client_nonce: input.clientNonce ?? `0x${randomBytes(32).toString("hex")}`,
    privacy_mode: "sealed_fhenix",
    binary_index_input: input.binaryInput,
    confidence_input: input.confidenceInput,
    strategy_tag: input.strategyTag,
  };
}

export function cofheVerifierError(error: unknown): Error {
  const record = typeof error === "object" && error !== null
    ? error as { code?: unknown; message?: unknown }
    : null;
  const messages = errorMessages(error);
  const message = messages[0] ?? String(error);
  const verifierFailure = record?.code === "ZK_VERIFY_FAILED" ||
    /zk proof verification|verifier/i.test(messages.join(" "));
  if (!verifierFailure) return error instanceof Error ? error : new Error(message);

  const confirmedUnavailable =
    /\b404\b|cannot (?:post|get).*\/verify|fetch failed|econnrefused|enotfound|etimedout/i
      .test(messages.join(" "));
  if (confirmedUnavailable) {
    return new Error(
      "CoFHE verifier is unreachable (HTTP 404 or network failure). Local sealing " +
        "stopped, no plaintext was sent to Murmur, and the Gateway was not called. " +
        `Retry after the verifier recovers. SDK error: ${messages.join(" | ")}`,
      { cause: error instanceof Error ? error : undefined },
    );
  }

  return new Error(
    "CoFHE proof verification failed before Murmur submission. The SDK returned " +
      "ZK_VERIFY_FAILED without a confirmed HTTP 404 or network outage; the proof " +
      "or verifier response may be invalid. No plaintext was sent to Murmur and the " +
      "Gateway was not called. Fhenix verifier endpoints are currently known to be " +
      `returning HTTP 404, so check service health and the SDK error: ${messages.join(" | ")}`,
    { cause: error instanceof Error ? error : undefined },
  );
}

function errorMessages(error: unknown): string[] {
  const messages: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current !== null && current !== undefined; depth++) {
    if (typeof current !== "object") {
      messages.push(String(current));
      break;
    }
    const record = current as { cause?: unknown; message?: unknown };
    if (typeof record.message === "string" && record.message.length > 0) {
      messages.push(record.message);
    }
    if (!("cause" in record)) break;
    current = record.cause;
  }
  return messages;
}
