/**
 * Live smoke: CoFHE full-lifecycle round-trip against Base Sepolia.
 *
 * Discovered cofhejs@0.3.1 API surface (cofhejs/node):
 *   - cofhejs.initializeWithViem(params)
 *       params: { viemClient, viemWalletClient?, environment, generatePermit? }
 *       environment: "TESTNET" sets coFheUrl/verifierUrl/thresholdNetworkUrl to Fhenix testnet endpoints
 *       returns: Promise<Result<Permit | undefined>>
 *   - cofhejs.encrypt([ Encryptable.uint8(v), Encryptable.uint16(v), ... ])
 *       returns: Promise<Result<[CoFheInUint8, CoFheInUint16, ...]>>
 *       CoFheInItem = { ctHash: bigint, securityZone: number, utype: FheTypes, signature: string }
 *       ↕ matches on-chain struct InEuint8 { uint256 ctHash, uint8 securityZone, uint8 utype, bytes signature }
 *   - cofhejs.decrypt(ctHash: bigint, utype: FheTypes)
 *       returns: Promise<Result<bigint>>   ← only decrypted value, NO signature
 *   - Threshold network /decrypt endpoint: POST { ct_tempkey, host_chain_id, permit }
 *       returns: { decrypted: number[], signature: string, encryption_type: number }
 *       (cofhejs.decrypt discards the signature field — we call it directly for publishReveal)
 *
 * Contract function signatures (derived from MurmurSealedVerdicts.sol):
 *   - registerFixedRevealMarket(bytes32 marketId, uint64 revealAfter, bool active)
 *   - submitSealedFor(address agent, bytes32 marketId,
 *       (uint256,uint8,uint8,bytes) binaryIndexInput,
 *       (uint256,uint8,uint8,bytes) confidenceInput,
 *       bytes32 clientNonce) returns (bytes32 callId)
 *   - openReveal(bytes32 callId)
 *   - publishReveal(bytes32 callId, uint8 binaryIndex, uint16 confidenceBps,
 *       bytes binaryIndexSignature, bytes confidenceSignature)
 *   - getCall(bytes32 callId) view returns (agent, marketId, acceptedAt,
 *       binaryIndexCtHash, confidenceCtHash, revealedBinaryIndex, revealedConfidenceBps, state)
 *   - callRevealOpenAt(bytes32 callId) view returns (uint64)
 *
 * Threshold network API base: https://testnet-cofhe-tn.fhenix.zone
 *   POST /decrypt { ct_tempkey: hex64, host_chain_id: number, permit: Permission }
 *     → { decrypted: number[], signature: string, encryption_type: number, error_message?: string }
 *
 * IMPORTANT: cofhejs.decrypt() returns only the plaintext value.
 * For publishReveal we need the threshold-network signature over (ctHash, result, chainId).
 * We call the threshold network /decrypt endpoint directly to retrieve it.
 */

import "dotenv/config";
import { strict as assert } from "node:assert";
import {
  createPublicClient,
  createWalletClient,
  http,
  getAddress,
  parseAbi,
  toHex,
  keccak256,
  encodePacked,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
// cofhejs/node.mjs has broken dynamic requires in ESM context; load via CJS path.
// The .js (CJS) build works fine when required via createRequire in the ESM host.
// We use an absolute filesystem path to bypass the package exports map restriction.
import { createRequire } from "node:module";
import { resolve as pathResolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const _require = createRequire(import.meta.url);
const _cofhejsCjsPath = pathResolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../node_modules/cofhejs/dist/node.js",
);
const {
  cofhejs,
  Encryptable,
  FheTypes,
} = _require(_cofhejsCjsPath) as typeof import("cofhejs/node");
type Permission = import("cofhejs/node").Permission;
import { loadDeployment } from "./deployments.js";

const CHAIN_ID = 84532;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 5_000;
const THRESHOLD_NETWORK_URL = "https://testnet-cofhe-tn.fhenix.zone";

const rpc = process.env.FHENIX_RPC_URL || process.env.BASE_RPC_URL;
if (!rpc) throw new Error("FHENIX_RPC_URL or BASE_RPC_URL must be set");
const relayerKey = (process.env.FHENIX_GATEWAY_RELAYER_PRIVATE_KEY ?? process.env.AGENT_PRIVATE_KEY) as Hex | undefined;
if (!relayerKey) throw new Error("FHENIX_GATEWAY_RELAYER_PRIVATE_KEY or AGENT_PRIVATE_KEY must be set");
const agentAddress = process.env.AGENT_ADDRESS;
if (!agentAddress) throw new Error("AGENT_ADDRESS must be set");

const sealed = loadDeployment(CHAIN_ID, "MurmurSealedVerdicts");
if (!sealed) throw new Error("MurmurSealedVerdicts not in manifest; run sync-deployments");
const contractAddress = getAddress(sealed.address);
console.log(`[smoke] MurmurSealedVerdicts @ ${contractAddress}`);

const account = privateKeyToAccount(relayerKey);
const publicClient = createPublicClient({ chain: baseSepolia, transport: http(rpc) });
const walletClient = createWalletClient({ account, chain: baseSepolia, transport: http(rpc) });

// Minimal ABI — only what the smoke calls
// InEuint8/InEuint16 on-chain struct: (uint256 ctHash, uint8 securityZone, uint8 utype, bytes signature)
// Matches cofhejs CoFheInItem: { ctHash: bigint, securityZone: number, utype: FheTypes, signature: string }
const ABI = parseAbi([
  "function registerFixedRevealMarket(bytes32 marketId, uint64 revealAfter, bool active)",
  "function submitSealedFor(address agent, bytes32 marketId, (uint256 ctHash, uint8 securityZone, uint8 utype, bytes signature) binaryIndexInput, (uint256 ctHash, uint8 securityZone, uint8 utype, bytes signature) confidenceInput, bytes32 clientNonce) returns (bytes32 callId)",
  "function openReveal(bytes32 callId)",
  "function publishReveal(bytes32 callId, uint8 binaryIndex, uint16 confidenceBps, bytes binaryIndexSignature, bytes confidenceSignature)",
  "function getCall(bytes32 callId) view returns (address agent, bytes32 marketId, uint64 acceptedAt, bytes32 binaryIndexCtHash, bytes32 confidenceCtHash, uint8 revealedBinaryIndex, uint16 revealedConfidenceBps, uint8 state)",
  "function callRevealOpenAt(bytes32 callId) view returns (uint64)",
  "event SealedCallSubmitted(bytes32 indexed callId, address indexed agent, bytes32 indexed marketId, uint64 acceptedAt, uint64 revealOpenAt, bytes32 binaryIndexCtHash, bytes32 confidenceCtHash, bytes32 clientNonce)",
  "event RevealOpened(bytes32 indexed callId, bytes32 binaryIndexCtHash, bytes32 confidenceCtHash, uint64 openedAt)",
  "event VerdictRevealed(bytes32 indexed callId, address indexed agent, bytes32 indexed marketId, uint8 binaryIndex, uint16 confidenceBps, uint64 revealedAt)",
]);

/** Calls the threshold network /decrypt endpoint directly to get both the plaintext and signature.
 *  The cofhejs.decrypt() API discards the signature, but publishReveal needs it.
 */
async function fetchDecryptWithSignature(
  ctHashBigint: bigint,
  permission: Permission,
): Promise<{ decrypted: bigint; signature: Hex }> {
  const ct_tempkey = ctHashBigint.toString(16).padStart(64, "0");
  const body = JSON.stringify({
    ct_tempkey,
    host_chain_id: CHAIN_ID,
    permit: permission,
  });
  const res = await fetch(`${THRESHOLD_NETWORK_URL}/decrypt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  const data = await res.json() as {
    decrypted?: number[];
    signature?: string;
    encryption_type?: number;
    error_message?: string;
  };
  if (data.error_message) throw new Error(`Threshold /decrypt error: ${data.error_message}`);
  if (!data.decrypted || !data.signature) {
    throw new Error(`Threshold /decrypt missing fields: ${JSON.stringify(data)}`);
  }
  // Convert decrypted byte array (big-endian) to bigint
  const decrypted = BigInt("0x" + Buffer.from(data.decrypted).toString("hex") || "0");
  const signature = data.signature.startsWith("0x") ? data.signature as Hex : `0x${data.signature}` as Hex;
  return { decrypted, signature };
}

async function pollDecrypt(
  label: string,
  ctHashBigint: bigint,
  permission: Permission,
): Promise<{ decrypted: bigint; signature: Hex }> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const result = await fetchDecryptWithSignature(ctHashBigint, permission);
      if (result.signature && result.signature !== "0x" && result.signature.length > 4) {
        return result;
      }
      console.log(`[smoke] polling ${label} (no signature yet)…`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[smoke] polling ${label}… (${msg})`);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function main() {
  const startMs = Date.now();
  console.log("[smoke] starting");

  // Step 1 — register a fixed-reveal market with a 90-second window
  const marketId = keccak256(encodePacked(["string", "uint64"], [`smoke-${Date.now()}`, BigInt(Date.now())]));
  const revealAfter = BigInt(Math.floor(Date.now() / 1000) + 90);
  console.log(`[smoke] registerFixedRevealMarket marketId=${marketId} revealAfter=${revealAfter}`);
  const registerTx = await walletClient.writeContract({
    address: contractAddress,
    abi: ABI,
    functionName: "registerFixedRevealMarket",
    args: [marketId, revealAfter, true],
  });
  await publicClient.waitForTransactionReceipt({ hash: registerTx });
  console.log(`[smoke] ok: market registered (tx=${registerTx})`);

  // Step 2 — initialize cofhejs against Base Sepolia testnet CoFHE
  // environment: "TESTNET" uses https://testnet-cofhe.fhenix.zone for keys,
  // https://testnet-cofhe-vrf.fhenix.zone for ZK verification,
  // https://testnet-cofhe-tn.fhenix.zone for threshold-network decrypt
  console.log(`[smoke] initializing cofhejs (environment=TESTNET, chain=${CHAIN_ID})`);
  const initResult = await cofhejs.initializeWithViem({
    viemClient: publicClient as any,
    viemWalletClient: walletClient as any,
    environment: "TESTNET",
    generatePermit: true,
  });
  if (!initResult.success) {
    throw new Error(`cofhejs init failed: ${initResult.error?.message}`);
  }
  console.log(`[smoke] cofhejs initialized, permit=${initResult.data ? "created" : "none"}`);

  // Get the permission struct needed for threshold network calls
  const permitResult = cofhejs.getPermission();
  if (!permitResult.success) {
    // If no permit yet, create one
    const createResult = await cofhejs.createPermit({ type: "self", issuer: account.address });
    if (!createResult.success) {
      throw new Error(`createPermit failed: ${createResult.error?.message}`);
    }
    const permResult = cofhejs.getPermission();
    if (!permResult.success) throw new Error(`getPermission failed: ${permResult.error?.message}`);
  }
  const permission: Permission = cofhejs.getPermission().data!;

  // Step 2 (continued) — encrypt binaryIndex=0 (euint8) and confidenceBps=7500 (euint16)
  console.log(`[smoke] encrypting inputs via cofhejs`);
  const encryptResult = await cofhejs.encrypt([
    Encryptable.uint8(BigInt(0)),
    Encryptable.uint16(BigInt(7500)),
  ]);
  if (!encryptResult.success) {
    throw new Error(`cofhejs.encrypt failed: ${encryptResult.error?.message}`);
  }
  const [binEnc, confEnc] = encryptResult.data;
  console.log(`[smoke] encrypted: binEnc.ctHash=${binEnc.ctHash} confEnc.ctHash=${confEnc.ctHash}`);

  // Step 3 — submitSealedFor
  const clientNonce = keccak256(toHex(`nonce-${Date.now()}-${Math.random()}`));
  console.log(`[smoke] submitSealedFor agent=${agentAddress} marketId=${marketId} nonce=${clientNonce}`);
  const submitTx = await walletClient.writeContract({
    address: contractAddress,
    abi: ABI,
    functionName: "submitSealedFor",
    args: [
      agentAddress as Address,
      marketId,
      {
        ctHash: binEnc.ctHash,
        securityZone: binEnc.securityZone,
        utype: binEnc.utype,
        signature: binEnc.signature as Hex,
      },
      {
        ctHash: confEnc.ctHash,
        securityZone: confEnc.securityZone,
        utype: confEnc.utype,
        signature: confEnc.signature as Hex,
      },
      clientNonce,
    ],
  });
  const submitReceipt = await publicClient.waitForTransactionReceipt({ hash: submitTx });

  // Extract callId from SealedCallSubmitted event (topic[1] = callId)
  const sealedCallTopic = keccak256(toHex("SealedCallSubmitted(bytes32,address,bytes32,uint64,uint64,bytes32,bytes32,bytes32)"));
  const submittedLog = submitReceipt.logs.find(
    (l) => l.address.toLowerCase() === contractAddress.toLowerCase()
      && l.topics[0] === sealedCallTopic,
  );
  assert.ok(submittedLog, "SealedCallSubmitted log not found");
  const callId = submittedLog!.topics[1] as Hex;
  console.log(`[smoke] ok: sealed call submitted (callId=${callId}, tx=${submitTx})`);

  // Step 4 — wait until the reveal window opens
  const revealOpenAt = await publicClient.readContract({
    address: contractAddress,
    abi: ABI,
    functionName: "callRevealOpenAt",
    args: [callId],
  });
  console.log(`[smoke] waiting for reveal window (revealOpenAt=${revealOpenAt}, now=${Math.floor(Date.now() / 1000)})`);
  while (Math.floor(Date.now() / 1000) < Number(revealOpenAt)) {
    const remaining = Number(revealOpenAt) - Math.floor(Date.now() / 1000);
    console.log(`[smoke] ${remaining}s until reveal window opens…`);
    await new Promise((r) => setTimeout(r, 5_000));
  }

  // Step 5 — openReveal
  console.log(`[smoke] openReveal callId=${callId}`);
  const openTx = await walletClient.writeContract({
    address: contractAddress,
    abi: ABI,
    functionName: "openReveal",
    args: [callId],
  });
  await publicClient.waitForTransactionReceipt({ hash: openTx });
  console.log(`[smoke] ok: reveal opened (tx=${openTx})`);

  // Retrieve ctHashes from the getCall view
  const callData = await publicClient.readContract({
    address: contractAddress,
    abi: ABI,
    functionName: "getCall",
    args: [callId],
  });
  const binaryIndexCtHash = callData[3]; // bytes32 binaryIndexCtHash (FHE.unwrap of euint8)
  const confidenceCtHash = callData[4];  // bytes32 confidenceCtHash (FHE.unwrap of euint16)
  const binCtHashBigint = BigInt(binaryIndexCtHash);
  const confCtHashBigint = BigInt(confidenceCtHash);
  console.log(`[smoke] ctHashes: bin=${binaryIndexCtHash} conf=${confidenceCtHash}`);

  // Step 6 — poll threshold network for decrypted values + signatures
  // After openReveal calls FHE.allowPublic, the oracle calls publishDecryptResult on-chain.
  // We call the threshold network /decrypt endpoint directly to get both the plaintext AND
  // the threshold-network signature required by publishReveal.
  console.log(`[smoke] polling threshold network for decrypt results (timeout=${POLL_TIMEOUT_MS / 1000}s)`);

  const binDecrypt = await pollDecrypt("binaryIndex decrypt", binCtHashBigint, permission);
  const confDecrypt = await pollDecrypt("confidenceBps decrypt", confCtHashBigint, permission);

  console.log(`[smoke] decrypted: binaryIndex=${binDecrypt.decrypted} confidenceBps=${confDecrypt.decrypted}`);
  assert.equal(Number(binDecrypt.decrypted), 0, "binaryIndex plaintext mismatch");
  assert.equal(Number(confDecrypt.decrypted), 7500, "confidenceBps plaintext mismatch");

  // Step 7 — publishReveal
  console.log(`[smoke] publishReveal callId=${callId}`);
  const publishTx = await walletClient.writeContract({
    address: contractAddress,
    abi: ABI,
    functionName: "publishReveal",
    args: [
      callId,
      Number(binDecrypt.decrypted),
      Number(confDecrypt.decrypted),
      binDecrypt.signature,
      confDecrypt.signature,
    ],
  });
  await publicClient.waitForTransactionReceipt({ hash: publishTx });
  console.log(`[smoke] ok: verdict revealed (tx=${publishTx})`);

  // Step 8 — assert final state
  const finalCallData = await publicClient.readContract({
    address: contractAddress,
    abi: ABI,
    functionName: "getCall",
    args: [callId],
  });
  const finalState = finalCallData[7]; // uint8 state (CallState enum: 0=None,1=Sealed,2=Opened,3=Revealed,4=Invalid)
  assert.equal(Number(finalState), 3, "expected calls[callId].state === Revealed(3)");
  console.log(`[smoke] ok: final state Revealed`);

  const elapsedSec = ((Date.now() - startMs) / 1000).toFixed(1);
  console.log(`[smoke] PASS callId=${callId} elapsed=${elapsedSec}s`);
}

main().catch((err) => {
  console.error("[smoke] FAILED:", err);
  process.exit(1);
});
