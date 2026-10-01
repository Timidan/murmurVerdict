#!/usr/bin/env tsx
import "dotenv/config";

import { Encryptable } from "@cofhe/sdk";
import { arbSepolia as cofheArbitrumSepolia } from "@cofhe/sdk/chains";
import { createCofheClient, createCofheConfig } from "@cofhe/sdk/node";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  createPublicClient,
  getAddress,
  http,
  type Address,
} from "viem";
import { arbitrumSepolia } from "viem/chains";

import {
  normalizeCofheBytesHex,
  normalizeCofheCtHashToHex32,
} from "../src/integrations/fhenix-gateway-cofhe-normalize.js";
import {
  COFHE_EUINT8_UTYPE,
  COFHE_EUINT16_UTYPE,
  type CofheInput,
} from "../src/integrations/fhenix-gateway-schemas.js";
import {
  addressOnlyWalletClient,
  AGENT_GATEWAY_PATH,
  buildAgentSealedCallBody,
  buildGatewayPopHeaders,
  cofheVerifierError,
} from "../src/integrations/agent-side-cofhe-sealer-support.js";

import { CONFIDENCE_BPS_MAX, CONFIDENCE_BPS_MIN } from "../src/verdict/schema.js";

// The SDK doesn't echo securityZone/utype per input; send what we asked the verifier to sign.
const COFHE_SECURITY_ZONE = 0;

interface MetaResponse {
  fhenix?: {
    chain_id_numeric?: number;
    relayer_address?: string | null;
    contract_address?: string | null;
  };
  verdict_bounds?: { confidence_bps?: { min?: number; max?: number } };
}

export interface ConfidenceBounds {
  min: number;
  max: number;
}

export async function fetchMeta(apiBase: string): Promise<{
  chainId: number;
  relayerAddress: Address;
  contractAddress: Address;
  confidenceBounds: ConfidenceBounds;
}> {
  const response = await fetch(`${apiBase}/v1/meta`);
  if (!response.ok) {
    throw new Error(`Murmur /v1/meta failed with HTTP ${response.status}`);
  }
  const meta = await response.json() as MetaResponse;
  const chainId = meta.fhenix?.chain_id_numeric;
  const relayerAddress = meta.fhenix?.relayer_address;
  const contractAddress = meta.fhenix?.contract_address;
  if (!chainId || !relayerAddress || !contractAddress) {
    throw new Error(
      "Murmur /v1/meta does not publish fhenix.chain_id_numeric, " +
        "fhenix.relayer_address and fhenix.contract_address; client-side " +
        "proof binding is unavailable",
    );
  }
  // The deployment publishes the band the contract enforces; a daemon that
  // predates the field gets the same numbers from the shared constant.
  const published = meta.verdict_bounds?.confidence_bps;
  const confidenceBounds: ConfidenceBounds =
    Number.isInteger(published?.min) && Number.isInteger(published?.max)
      ? { min: published!.min!, max: published!.max! }
      : { min: CONFIDENCE_BPS_MIN, max: CONFIDENCE_BPS_MAX };
  return {
    chainId,
    relayerAddress: getAddress(relayerAddress),
    contractAddress: getAddress(contractAddress),
    confidenceBounds,
  };
}

export async function sealVerdict(input: {
  binaryIndex: number;
  confidenceBps: number;
  chainId: number;
  relayerAddress: Address;
  contractAddress: Address;
  rpcUrl: string;
  /** From fetchMeta. Defaults to the shared constant for callers that skip it. */
  confidenceBounds?: ConfidenceBounds;
}): Promise<{
  binary_index_input: CofheInput;
  confidence_input: CofheInput;
}> {
  // Nothing downstream can catch this: the daemon relays ciphertext and the
  // contract only sees the value at reveal, when the submit gas is already spent.
  const bounds = input.confidenceBounds ?? { min: CONFIDENCE_BPS_MIN, max: CONFIDENCE_BPS_MAX };
  if (input.binaryIndex !== 0 && input.binaryIndex !== 1) {
    throw new Error(`binary index must be 0 or 1, got ${input.binaryIndex}`);
  }
  if (
    !Number.isInteger(input.confidenceBps) ||
    input.confidenceBps < bounds.min ||
    input.confidenceBps > bounds.max
  ) {
    throw new Error(
      `confidence_bps ${input.confidenceBps} is outside ${bounds.min}-${bounds.max}: the ` +
        "sealed-verdicts contract would reject it at reveal, losing the call and the gas " +
        "its submit spent. Refusing to seal it.",
    );
  }
  if (input.chainId !== cofheArbitrumSepolia.id) {
    throw new Error(
      `unsupported CoFHE chain ${input.chainId}; this tool supports Arbitrum Sepolia ${cofheArbitrumSepolia.id}`,
    );
  }

  const publicClient = createPublicClient({
    chain: arbitrumSepolia,
    transport: http(input.rpcUrl),
  });
  const client = createCofheClient(createCofheConfig({
    environment: "node",
    supportedChains: [cofheArbitrumSepolia],
  }));
  await client.connect(
    publicClient as never,
    addressOnlyWalletClient(input.relayerAddress) as never,
  );

  try {
    // Both bindings are Murmur's PUBLISHED values, not this agent's: the proof
    // is signed for Murmur's relayer (which broadcasts it) and for
    // MurmurSealedVerdicts (which consumes it). Input order is load-bearing —
    // the single batch signature covers the hashes in this exact sequence.
    const [binaryHash, confidenceHash, batchSignature] = await client
      .encryptInputs([
        Encryptable.uint8(BigInt(input.binaryIndex)),
        Encryptable.uint16(BigInt(input.confidenceBps)),
      ])
      .setAccount(input.relayerAddress)
      .setSecurityZone(COFHE_SECURITY_ZONE)
      .setConsumingContract(input.contractAddress)
      .execute();
    const signature = normalizeCofheBytesHex(batchSignature, "sealed_batch");
    return {
      binary_index_input: {
        ct_hash: normalizeCofheCtHashToHex32(binaryHash, "binary_index_input"),
        security_zone: COFHE_SECURITY_ZONE,
        utype: COFHE_EUINT8_UTYPE,
        signature,
      },
      confidence_input: {
        ct_hash: normalizeCofheCtHashToHex32(confidenceHash, "confidence_input"),
        security_zone: COFHE_SECURITY_ZONE,
        utype: COFHE_EUINT16_UTYPE,
        signature,
      },
    };
  } catch (error) {
    throw cofheVerifierError(error);
  }
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
  if (!Number.isInteger(confidenceBps)) {
    throw new Error("confidence-bps must be an integer; sealVerdict checks it against the published band");
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
  const { chainId, relayerAddress, contractAddress, confidenceBounds } = await fetchMeta(apiBase);
  const sealed = await sealVerdict({
    binaryIndex: args.binaryIndex,
    confidenceBps: args.confidenceBps,
    chainId,
    relayerAddress,
    contractAddress,
    rpcUrl,
    confidenceBounds,
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
