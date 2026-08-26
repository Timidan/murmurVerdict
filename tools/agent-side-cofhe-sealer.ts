#!/usr/bin/env tsx
import "dotenv/config";

import { Encryptable } from "@cofhe/sdk";
import { baseSepolia as cofheBaseSepolia } from "@cofhe/sdk/chains";
import { createCofheClient, createCofheConfig } from "@cofhe/sdk/node";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  createPublicClient,
  getAddress,
  http,
  type Address,
} from "viem";
import { baseSepolia } from "viem/chains";

import {
  normalizeCofheBytesHex,
  normalizeCofheCtHashToHex32,
} from "../src/integrations/fhenix-gateway-cofhe-normalize.js";
import type { CofheInput } from "../src/integrations/fhenix-gateway-schemas.js";
import {
  addressOnlyWalletClient,
  AGENT_GATEWAY_PATH,
  buildAgentSealedCallBody,
  buildGatewayPopHeaders,
  cofheVerifierError,
} from "../src/integrations/agent-side-cofhe-sealer-support.js";

interface MetaResponse {
  fhenix?: {
    chain_id_numeric?: number;
    relayer_address?: string | null;
  };
}

async function fetchMeta(apiBase: string): Promise<{
  chainId: number;
  relayerAddress: Address;
}> {
  const response = await fetch(`${apiBase}/v1/meta`);
  if (!response.ok) {
    throw new Error(`Murmur /v1/meta failed with HTTP ${response.status}`);
  }
  const meta = await response.json() as MetaResponse;
  const chainId = meta.fhenix?.chain_id_numeric;
  const relayerAddress = meta.fhenix?.relayer_address;
  if (!chainId || !relayerAddress) {
    throw new Error(
      "Murmur /v1/meta does not publish fhenix.chain_id_numeric and " +
        "fhenix.relayer_address; client-side relayer binding is unavailable",
    );
  }
  return { chainId, relayerAddress: getAddress(relayerAddress) };
}

async function sealVerdict(input: {
  binaryIndex: number;
  confidenceBps: number;
  chainId: number;
  relayerAddress: Address;
  rpcUrl: string;
}): Promise<{
  binary_index_input: CofheInput;
  confidence_input: CofheInput;
}> {
  if (input.chainId !== cofheBaseSepolia.id) {
    throw new Error(
      `unsupported CoFHE chain ${input.chainId}; this tool supports Base Sepolia ${cofheBaseSepolia.id}`,
    );
  }

  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(input.rpcUrl),
  });
  const client = createCofheClient(createCofheConfig({
    environment: "node",
    supportedChains: [cofheBaseSepolia],
  }));
  await client.connect(
    publicClient as never,
    addressOnlyWalletClient(input.relayerAddress) as never,
  );

  try {
    const [binary, confidence] = await client
      .encryptInputs([
        Encryptable.uint8(BigInt(input.binaryIndex)),
        Encryptable.uint16(BigInt(input.confidenceBps)),
      ])
      .setAccount(input.relayerAddress)
      .execute();
    return {
      binary_index_input: normalizeInput(binary, "binary_index_input"),
      confidence_input: normalizeInput(confidence, "confidence_input"),
    };
  } catch (error) {
    throw cofheVerifierError(error);
  }
}

function normalizeInput(
  input: { ctHash: unknown; securityZone: number; utype: number; signature: unknown },
  label: string,
): CofheInput {
  return {
    ct_hash: normalizeCofheCtHashToHex32(input.ctHash, label),
    security_zone: input.securityZone,
    utype: input.utype,
    signature: normalizeCofheBytesHex(input.signature, label),
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required environment variable ${name}`);
  return value;
}

function parseArguments(): {
  marketSourceId: string;
  binaryIndex: number;
  confidenceBps: number;
  configVersion: number;
  strategyTag: string;
} {
  const [marketSourceId, binaryRaw, confidenceRaw, configRaw = "1", strategyTag = "agent-local"] =
    process.argv.slice(2);
  if (!marketSourceId || binaryRaw === undefined || confidenceRaw === undefined) {
    throw new Error(
      "usage: agent-side-cofhe-sealer.ts <market-source-id> <binary-index> " +
        "<confidence-bps> [config-version] [strategy-tag]",
    );
  }
  const binaryIndex = Number(binaryRaw);
  const confidenceBps = Number(confidenceRaw);
  const configVersion = Number(configRaw);
  if (!Number.isInteger(binaryIndex) || (binaryIndex !== 0 && binaryIndex !== 1)) {
    throw new Error("binary-index must be 0 or 1");
  }
  if (!Number.isInteger(confidenceBps) || confidenceBps < 0 || confidenceBps > 10_000) {
    throw new Error("confidence-bps must be an integer from 0 to 10000");
  }
  if (!Number.isInteger(configVersion) || configVersion < 1) {
    throw new Error("config-version must be a positive integer");
  }
  return { marketSourceId, binaryIndex, confidenceBps, configVersion, strategyTag };
}

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    process.stdout.write(
      "usage: npx tsx tools/agent-side-cofhe-sealer.ts <market-source-id> " +
        "<binary-index> <confidence-bps> [config-version] [strategy-tag]\n\n" +
        "requires MURMUR_API, MURMUR_RUNTIME_KEY, MURMUR_RUNTIME_KEY_ID, " +
        "MURMUR_RUNTIME_KEY_SIGNING_PK, MURMUR_POP_AUDIENCE, and FHENIX_RPC_URL\n" +
        "needs no EVM or relayer private key; plaintext remains local\n",
    );
    return;
  }

  const args = parseArguments();
  const apiBase = requiredEnv("MURMUR_API").replace(/\/+$/, "");
  const runtimeKey = requiredEnv("MURMUR_RUNTIME_KEY");
  const runtimeKeyId = requiredEnv("MURMUR_RUNTIME_KEY_ID");
  const signingPrivateKey = requiredEnv("MURMUR_RUNTIME_KEY_SIGNING_PK");
  const audience = requiredEnv("MURMUR_POP_AUDIENCE");
  const rpcUrl = requiredEnv("FHENIX_RPC_URL");
  const { chainId, relayerAddress } = await fetchMeta(apiBase);
  const sealed = await sealVerdict({
    binaryIndex: args.binaryIndex,
    confidenceBps: args.confidenceBps,
    chainId,
    relayerAddress,
    rpcUrl,
  });
  const body = buildAgentSealedCallBody({
    binaryInput: sealed.binary_index_input,
    confidenceInput: sealed.confidence_input,
    configVersion: args.configVersion,
    marketSourceId: args.marketSourceId,
    strategyTag: args.strategyTag,
  });
  const bodyBytes = Buffer.from(JSON.stringify(body), "utf8");
  const headers = buildGatewayPopHeaders({
    audience,
    bodyBytes,
    runtimeKey,
    runtimeKeyId,
    signingPrivateKey,
  });
  const response = await fetch(`${apiBase}${AGENT_GATEWAY_PATH}`, {
    method: "POST",
    headers,
    body: bodyBytes,
  });
  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(
      `Murmur Gateway rejected the sealed handles with HTTP ${response.status}: ${responseText}`,
    );
  }
  process.stdout.write(`${responseText}\n`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
