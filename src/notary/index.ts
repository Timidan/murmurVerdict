import * as dotenv from "dotenv";
dotenv.config();

import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  toHex,
  encodeAbiParameters,
  parseAbiParameters,
  type PublicClient,
  type WalletClient,
  type Hash,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import { createHash, randomUUID } from "crypto";

import {
  type DecisionReceipt,
  type ExecutionResult,
  type DeliberationResult,
  type RiskGateResult,
  type ScoredAsset,
  MurmurError,
} from "../types/index.js";

// ─── Errors ───────────────────────────────────────────────────────────────────

export class NotaryError extends MurmurError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, "NOTARY_ERROR", context);
    this.name = "NotaryError";
  }
}

// ─── Constants ────────────────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1_500;

// ERC-8004 Registry on Base Mainnet (The Synthesis hackathon registry)
// Agent registered at: 0x6FFa1e00509d8B625c2F061D7dB07893B37199BC
const ERC8004_REGISTRY_ADDRESS: Address =
  "0xA649254ECC9405C4d48dde88f82e99D53b94097D";

// Lighthouse IPFS/Filecoin gateway
const LIGHTHOUSE_API_URL = "https://upload.lighthouse.storage";
const LIGHTHOUSE_UPLOAD_URL = "https://upload.lighthouse.storage/api/v0/add?cid-version=1";

// ─── ERC-8004 Minimal ABI ─────────────────────────────────────────────────────
// Based on https://eips.ethereum.org/EIPS/eip-8004
// The attest function records a decision receipt hash on-chain, linked
// to the agent's participantId and emits an AgentAttested event.

const ERC8004_ABI = [
  {
    name: "attest",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "receiptHash", type: "bytes32" },
      { name: "metadataUri", type: "string" }, // IPFS/Filecoin CID URI
      { name: "actionType", type: "string" }, // e.g. "trade", "hold"
    ],
    outputs: [{ name: "attestationId", type: "uint256" }],
  },
  {
    name: "getAttestations",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "agent", type: "address" }],
    outputs: [
      {
        name: "",
        type: "tuple[]",
        components: [
          { name: "receiptHash", type: "bytes32" },
          { name: "metadataUri", type: "string" },
          { name: "actionType", type: "string" },
          { name: "timestamp", type: "uint256" },
          { name: "attestationId", type: "uint256" },
        ],
      },
    ],
  },
  {
    name: "AgentAttested",
    type: "event",
    inputs: [
      { name: "agent", type: "address", indexed: true },
      { name: "receiptHash", type: "bytes32", indexed: true },
      { name: "attestationId", type: "uint256", indexed: false },
      { name: "metadataUri", type: "string", indexed: false },
      { name: "actionType", type: "string", indexed: false },
    ],
  },
] as const;

// ─── Viem Clients ─────────────────────────────────────────────────────────────

function createClients(params: { rpcUrl: string; privateKey: `0x${string}` }): {
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: ReturnType<typeof privateKeyToAccount>;
} {
  const account = privateKeyToAccount(params.privateKey);

  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(params.rpcUrl, { timeout: REQUEST_TIMEOUT_MS }),
  });

  const walletClient = createWalletClient({
    account,
    chain: baseSepolia,
    transport: http(params.rpcUrl, { timeout: REQUEST_TIMEOUT_MS }),
  });

  return {
    publicClient: publicClient as PublicClient,
    walletClient: walletClient as WalletClient,
    account,
  };
}

// ERC-8004 registry is on Base Mainnet — use separate mainnet clients for attestation
const BASE_MAINNET_RPC = process.env.BASE_MAINNET_RPC_URL ?? "https://mainnet.base.org";

function createMainnetClients(params: { privateKey: `0x${string}` }): {
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: ReturnType<typeof privateKeyToAccount>;
} {
  const account = privateKeyToAccount(params.privateKey);

  const publicClient = createPublicClient({
    chain: base,
    transport: http(BASE_MAINNET_RPC, { timeout: REQUEST_TIMEOUT_MS }),
  });

  const walletClient = createWalletClient({
    account,
    chain: base,
    transport: http(BASE_MAINNET_RPC, { timeout: REQUEST_TIMEOUT_MS }),
  });

  return {
    publicClient: publicClient as PublicClient,
    walletClient: walletClient as WalletClient,
    account,
  };
}

// ─── Canonical JSON ───────────────────────────────────────────────────────────

/**
 * Produce a deterministic, canonical JSON string for a DecisionReceipt.
 * Keys are sorted alphabetically at every level to ensure consistent hashing.
 */
export function toCanonicalJson(receipt: DecisionReceipt): string {
  return JSON.stringify(receipt, (_, value) => {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      return Object.keys(value as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((sorted, key) => {
          sorted[key] = (value as Record<string, unknown>)[key];
          return sorted;
        }, {});
    }
    // Serialize bigint as string to avoid JSON.stringify throwing
    if (typeof value === "bigint") {
      return value.toString();
    }
    return value as unknown;
  });
}

/**
 * Compute a keccak256 hash of the canonical receipt JSON.
 * Returns a 0x-prefixed hex string usable as bytes32 on-chain.
 */
export function hashReceipt(receipt: DecisionReceipt): `0x${string}` {
  const canonical = toCanonicalJson(receipt);
  const encoded = toHex(new TextEncoder().encode(canonical));
  return keccak256(encoded);
}

/**
 * Compute a sha256 content hash of the receipt for Filecoin integrity verification.
 */
export function sha256Receipt(receipt: DecisionReceipt): string {
  const canonical = toCanonicalJson(receipt);
  return createHash("sha256").update(canonical).digest("hex");
}

// ─── Receipt Builder ──────────────────────────────────────────────────────────

/**
 * Assemble a DecisionReceipt from the outputs of all upstream modules.
 * The receipt is stamped with the agent's ERC-8004 identity address.
 */
export function buildReceipt(params: {
  cycleId: string;
  agentAddress: `0x${string}`;
  scoredAssets: ScoredAsset[];
  deliberation: DeliberationResult;
  riskGate: RiskGateResult;
  execution: ExecutionResult | null;
  delegationCapBefore: number;
  delegationCapAfter: number;
  delegationUsed?: `0x${string}`;
}): DecisionReceipt {
  const {
    cycleId,
    agentAddress,
    scoredAssets,
    deliberation,
    riskGate,
    execution,
    delegationCapBefore,
    delegationCapAfter,
    delegationUsed,
  } = params;

  // Build a partial receipt (no hash yet — hash is computed after)
  const partial: Omit<DecisionReceipt, "receiptHash"> = {
    id: randomUUID(),
    agentIdentity: agentAddress,
    cycleId,
    scoredAssets,
    deliberation,
    riskGate,
    execution,
    delegationUsed,
    delegationCapBefore,
    delegationCapAfter,
    createdAt: new Date().toISOString(),
    version: "1.0",
  };

  // Compute hash over the partial (before fields attestationTxHash / filecoinCid are set)
  const receiptHash = hashReceipt(partial as DecisionReceipt);

  return {
    ...partial,
    receiptHash,
  };
}

// ─── Filecoin / IPFS Storage via Lighthouse ───────────────────────────────────

interface LighthouseUploadResponse {
  Name: string;
  Hash: string; // CID
  Size: string;
}

/**
 * Upload the full receipt JSON to Filecoin/IPFS via Lighthouse.
 * Returns the IPFS CID of the stored file.
 */
async function uploadToLighthouse(params: {
  apiKey: string;
  receipt: DecisionReceipt;
  retries?: number;
}): Promise<string> {
  const { apiKey, receipt, retries = MAX_RETRIES } = params;

  const canonical = toCanonicalJson(receipt);
  const blob = new Blob([canonical], { type: "application/json" });

  const filename = `murmur-receipt-${receipt.cycleId}-${receipt.id}.json`;

  const formData = new FormData();
  formData.append("file", blob, filename);

  let lastError: Error = new Error("Unknown upload error");

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      const res = await fetch(LIGHTHOUSE_UPLOAD_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        body: formData,
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!res.ok) {
        const text = await res.text().catch(() => "unknown");
        throw new NotaryError(
          `Lighthouse upload failed: HTTP ${res.status} — ${text.slice(0, 200)}`,
          { attempt, status: res.status },
        );
      }

      const data = (await res.json()) as LighthouseUploadResponse;

      if (!data.Hash) {
        throw new NotaryError("Lighthouse response missing CID", {
          attempt,
          data,
        });
      }

      console.log(
        `[Notary] Receipt stored on Filecoin: ipfs://${data.Hash} (${data.Size} bytes)`,
      );

      return data.Hash;
    } catch (err) {
      lastError = err as Error;
      if (attempt < retries) {
        const delay = RETRY_DELAY_MS * attempt;
        console.warn(
          `[Notary] Lighthouse upload attempt ${attempt}/${retries} failed — retrying in ${delay}ms: ${lastError.message}`,
        );
        await sleep(delay);
      }
    }
  }

  throw new NotaryError(
    `Lighthouse upload failed after ${retries} attempts: ${lastError.message}`,
    { lastError: lastError.message },
  );
}

/**
 * Verify a receipt stored on Filecoin by fetching it and comparing the sha256.
 */
export async function verifyFilecoinReceipt(params: {
  cid: string;
  expectedSha256: string;
}): Promise<{ valid: boolean; fetchedSha256: string }> {
  const { cid, expectedSha256 } = params;

  try {
    const url = `https://gateway.lighthouse.storage/ipfs/${cid}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!res.ok) {
      return { valid: false, fetchedSha256: "" };
    }

    const text = await res.text();
    const fetchedSha256 = createHash("sha256").update(text).digest("hex");
    const valid = fetchedSha256 === expectedSha256;

    return { valid, fetchedSha256 };
  } catch (err) {
    console.warn(
      `[Notary] Filecoin verification failed: ${(err as Error).message}`,
    );
    return { valid: false, fetchedSha256: "" };
  }
}

// ─── On-Chain ERC-8004 Attestation ───────────────────────────────────────────

/**
 * Attest a decision receipt hash to the ERC-8004 registry on Base Mainnet.
 * This creates an immutable, timestamped, on-chain record tied to the agent identity.
 */
async function attestOnChain(params: {
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: Address;
  receiptHash: `0x${string}`;
  filecoinCid: string;
  actionType: string;
}): Promise<Hash> {
  const {
    publicClient,
    walletClient,
    account,
    receiptHash,
    filecoinCid,
    actionType,
  } = params;

  const metadataUri = `ipfs://${filecoinCid}`;

  console.log(
    `[Notary] Attesting to ERC-8004 registry: hash=${receiptHash.slice(0, 18)}... uri=${metadataUri}`,
  );

  // Don't pass `account` as address string — walletClient already has the signing account embedded
  // Passing an address string would make viem use eth_sendTransaction (needs RPC-side signing)
  // Omitting it makes viem sign locally and use eth_sendRawTransaction
  const hash = await (
    walletClient as WalletClient & {
      writeContract: (args: unknown) => Promise<Hash>;
    }
  ).writeContract({
    address: ERC8004_REGISTRY_ADDRESS,
    abi: ERC8004_ABI,
    functionName: "attest",
    args: [receiptHash as `0x${string}`, metadataUri, actionType],
    chain: base,
  });

  console.log(`[Notary] Attestation tx submitted (Base Mainnet): ${hash}`);

  const receipt = await publicClient.waitForTransactionReceipt({
    hash,
    timeout: 120_000,
  });

  if (receipt.status !== "success") {
    throw new NotaryError(`Attestation tx reverted: ${hash}`, { hash });
  }

  console.log(
    `[Notary] ✅ Attested on-chain — block ${receipt.blockNumber} | tx: ${hash}`,
  );

  return hash;
}

/**
 * Fallback: if the ERC-8004 registry contract is unavailable, emit a raw log
 * via a direct eth_sendRawTransaction with the receipt hash in calldata.
 * This preserves the on-chain record without requiring a specific contract.
 */
async function attestFallbackLog(params: {
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: Address;
  agentAddress: Address;
  receiptHash: `0x${string}`;
  filecoinCid: string;
}): Promise<Hash> {
  const { walletClient, account, agentAddress, receiptHash, filecoinCid } =
    params;

  // Encode the attestation data as calldata for a self-send
  const data = encodeAbiParameters(
    parseAbiParameters("bytes32 receiptHash, address agent, string cid"),
    [receiptHash, agentAddress, `ipfs://${filecoinCid}`],
  );

  const hash = await (
    walletClient as WalletClient & {
      sendTransaction: (args: unknown) => Promise<Hash>;
    }
  ).sendTransaction({
    to: agentAddress, // self-send
    data,
    value: BigInt(0),
    chain: base,
  });

  console.log(`[Notary] Fallback attestation log tx (Base Mainnet): ${hash}`);

  return hash;
}

// ─── Main Notarize ────────────────────────────────────────────────────────────

export interface NotarizeParams {
  receipt: DecisionReceipt;
  filecoinApiKey: string;
  rpcUrl: string;
  privateKey: `0x${string}` | null;
  agentAddress: `0x${string}`;
  skipOnChain?: boolean; // true = skip on-chain attestation (e.g. testnet / demo mode)
  skipFilecoin?: boolean; // true = skip Filecoin upload
}

export interface NotarizeResult {
  receipt: DecisionReceipt; // updated receipt with CID + attestation tx
  receiptHash: `0x${string}`;
  filecoinCid: string | null;
  attestationTxHash: `0x${string}` | null;
  sha256: string;
  success: boolean;
  errors: string[];
}

/**
 * Full notarization pipeline:
 * 1. Compute canonical hash of the receipt
 * 2. Upload to Filecoin/IPFS via Lighthouse
 * 3. Attest on-chain to ERC-8004 registry on Base Sepolia
 * 4. Return the updated receipt with all provenance fields filled in
 */
export async function notarize(
  params: NotarizeParams,
): Promise<NotarizeResult> {
  const {
    receipt,
    filecoinApiKey,
    rpcUrl,
    privateKey,
    agentAddress,
    skipOnChain = false,
    skipFilecoin = false,
  } = params;

  const errors: string[] = [];
  let filecoinCid: string | null = null;
  let attestationTxHash: `0x${string}` | null = null;

  const receiptHash = receipt.receiptHash;
  const sha256 = sha256Receipt(receipt);
  const actionType = receipt.execution
    ? receipt.deliberation.decision.action
    : "hold";

  console.log(
    `[Notary] Notarizing receipt ${receipt.id} | action=${actionType} | hash=${receiptHash.slice(0, 18)}...`,
  );

  // ── Step 1: Upload to Filecoin ─────────────────────────────────────────────
  if (!skipFilecoin) {
    try {
      filecoinCid = await uploadToLighthouse({
        apiKey: filecoinApiKey,
        receipt,
      });
    } catch (err) {
      const message = `Filecoin upload failed: ${(err as Error).message}`;
      console.error(`[Notary] ${message}`);
      errors.push(message);
    }
  } else {
    console.log("[Notary] Filecoin upload skipped (skipFilecoin=true)");
  }

  // ── Step 2: On-chain ERC-8004 attestation ─────────────────────────────────
  if (!skipOnChain) {
    if (!privateKey) {
      const message =
        "On-chain attestation requested but no private key was provided";
      console.error(`[Notary] ${message}`);
      errors.push(message);
    } else {
      // ERC-8004 registry is on Base Mainnet, not Sepolia
      const { publicClient, walletClient, account } = createMainnetClients({
        privateKey,
      });

      try {
        attestationTxHash = await attestOnChain({
          publicClient,
          walletClient,
          account: account.address,
          receiptHash,
          filecoinCid: filecoinCid ?? sha256, // fall back to sha256 if no CID
          actionType,
        });
      } catch (err) {
        const message = `ERC-8004 attestation failed: ${(err as Error).message}`;
        console.warn(`[Notary] ${message} — attempting fallback log`);
        errors.push(message);

        // Try fallback log attestation
        try {
          attestationTxHash = await attestFallbackLog({
            publicClient,
            walletClient,
            account: account.address,
            agentAddress,
            receiptHash,
            filecoinCid: filecoinCid ?? sha256,
          });
        } catch (fallbackErr) {
          const fallbackMessage = `Fallback attestation also failed: ${(fallbackErr as Error).message}`;
          console.error(`[Notary] ${fallbackMessage}`);
          errors.push(fallbackMessage);
        }
      }
    }
  } else {
    console.log("[Notary] On-chain attestation skipped (skipOnChain=true)");
  }

  // ── Step 3: Stamp the receipt with provenance ──────────────────────────────
  const finalReceipt: DecisionReceipt = {
    ...receipt,
    filecoinCid: filecoinCid ?? undefined,
    attestationTxHash: attestationTxHash ?? undefined,
  };

  const success = errors.length === 0;

  console.log(
    `[Notary] ${success ? "✅" : "⚠️"} Notarization complete | CID=${filecoinCid ?? "none"} | attest=${attestationTxHash?.slice(0, 18) ?? "none"}`,
  );

  return {
    receipt: finalReceipt,
    receiptHash,
    filecoinCid,
    attestationTxHash,
    sha256,
    success,
    errors,
  };
}

// ─── Receipt Retrieval ────────────────────────────────────────────────────────

/**
 * Fetch a stored receipt from Filecoin by CID.
 */
export async function fetchReceiptFromFilecoin(
  cid: string,
): Promise<DecisionReceipt | null> {
  try {
    const url = `https://gateway.lighthouse.storage/ipfs/${cid}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!res.ok) {
      console.warn(
        `[Notary] Failed to fetch receipt from Filecoin (${cid}): HTTP ${res.status}`,
      );
      return null;
    }

    const text = await res.text();
    return JSON.parse(text) as DecisionReceipt;
  } catch (err) {
    console.warn(
      `[Notary] Error fetching receipt from Filecoin: ${(err as Error).message}`,
    );
    return null;
  }
}

/**
 * Read all on-chain attestations for an agent from the ERC-8004 registry.
 */
export async function getOnChainAttestations(params: {
  rpcUrl: string;
  agentAddress: Address;
}): Promise<
  Array<{
    receiptHash: `0x${string}`;
    metadataUri: string;
    actionType: string;
    timestamp: bigint;
    attestationId: bigint;
  }>
> {
  const { rpcUrl, agentAddress } = params;

  // ERC-8004 registry is on Base Mainnet
  const publicClient = createPublicClient({
    chain: base,
    transport: http(BASE_MAINNET_RPC),
  });

  try {
    const result = await publicClient.readContract({
      address: ERC8004_REGISTRY_ADDRESS,
      abi: ERC8004_ABI,
      functionName: "getAttestations",
      args: [agentAddress],
    });

    return result as Array<{
      receiptHash: `0x${string}`;
      metadataUri: string;
      actionType: string;
      timestamp: bigint;
      attestationId: bigint;
    }>;
  } catch (err) {
    console.warn(
      `[Notary] Could not read on-chain attestations: ${(err as Error).message}`,
    );
    return [];
  }
}

// ─── Logging ──────────────────────────────────────────────────────────────────

export function summarizeNotarization(result: NotarizeResult): string {
  const lines: string[] = [
    `\n[Notary] Notarization Summary`,
    `  Status:       ${result.success ? "✅ SUCCESS" : "⚠️  PARTIAL"}`,
    `  Receipt ID:   (internal)`,
    `  Hash:         ${result.receiptHash.slice(0, 18)}...${result.receiptHash.slice(-6)}`,
    `  SHA-256:      ${result.sha256.slice(0, 16)}...`,
    `  Filecoin CID: ${result.filecoinCid ?? "not stored"}`,
    `  On-chain Tx:  ${result.attestationTxHash ?? "not attested"}`,
  ];

  if (result.attestationTxHash) {
    lines.push(
      `  BaseScan:     https://sepolia.basescan.org/tx/${result.attestationTxHash}`,
    );
  }

  if (result.filecoinCid) {
    lines.push(
      `  IPFS:         https://gateway.lighthouse.storage/ipfs/${result.filecoinCid}`,
    );
  }

  if (result.errors.length > 0) {
    lines.push(`  Errors:`);
    for (const err of result.errors) {
      lines.push(`    - ${err}`);
    }
  }

  return lines.join("\n");
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Standalone runner ────────────────────────────────────────────────────────

if (process.argv[1]?.includes("notary")) {
  console.log("=".repeat(60));
  console.log("  MURMUR — Notary Module (smoke test)");
  console.log("=".repeat(60));

  const mockReceipt: DecisionReceipt = {
    id: randomUUID(),
    agentIdentity: "0x0000000000000000000000000000000000000001",
    cycleId: "smoke-test-001",
    scoredAssets: [],
    deliberation: {
      decision: {
        action: "hold",
        slug: "ethereum",
        sizeBucket: "1pct",
        confidence: 0,
        holdingHorizon: "24h",
        thesis: "Smoke test — no real decision",
        invalidationCondition: "N/A",
        risks: [],
      },
      candidatesConsidered: [],
      modelUsed: "claude-sonnet-4-6",
      promptTokens: 0,
      completionTokens: 0,
      deliberatedAt: new Date().toISOString(),
    },
    riskGate: {
      approved: true,
      checks: [],
      effectiveSizeUsd: 0,
      maxSlippageBps: 50,
      delegationCapRemaining: 1000,
      evaluatedAt: new Date().toISOString(),
    },
    execution: null,
    receiptHash:
      "0x0000000000000000000000000000000000000000000000000000000000000000",
    delegationCapBefore: 1000,
    delegationCapAfter: 1000,
    createdAt: new Date().toISOString(),
    version: "1.0",
  };

  // Stamp the real hash
  mockReceipt.receiptHash = hashReceipt(mockReceipt);

  console.log(`\nCanonical JSON (first 200 chars):`);
  console.log(toCanonicalJson(mockReceipt).slice(0, 200) + "...");
  console.log(`\nReceipt hash:  ${mockReceipt.receiptHash}`);
  console.log(`SHA-256:       ${sha256Receipt(mockReceipt)}`);

  const filecoinApiKey = process.env.FILECOIN_API_TOKEN;
  if (!filecoinApiKey) {
    console.warn(
      "\n[Notary] FILECOIN_API_TOKEN not set — skipping upload test",
    );
    console.log("[Notary] Done.");
    process.exit(0);
  }

  const rpcUrl = process.env.BASE_RPC_URL ?? "https://sepolia.base.org";
  const privateKey = process.env.METAMASK_DELEGATION_PRIVATE_KEY as
    | `0x${string}`
    | undefined;

  if (!privateKey) {
    console.warn("[Notary] No private key — testing Filecoin upload only");

    uploadToLighthouse({ apiKey: filecoinApiKey, receipt: mockReceipt })
      .then((cid) => {
        console.log(`[Notary] Uploaded! CID: ${cid}`);
        console.log(
          `[Notary] View: https://gateway.lighthouse.storage/ipfs/${cid}`,
        );
        process.exit(0);
      })
      .catch((err) => {
        console.error("[Notary] Upload failed:", err);
        process.exit(1);
      });
  } else {
    notarize({
      receipt: mockReceipt,
      filecoinApiKey,
      rpcUrl,
      privateKey,
      agentAddress: "0x0000000000000000000000000000000000000001",
    })
      .then((result) => {
        console.log(summarizeNotarization(result));
        process.exit(0);
      })
      .catch((err) => {
        console.error("[Notary] Fatal:", err);
        process.exit(1);
      });
  }
}
