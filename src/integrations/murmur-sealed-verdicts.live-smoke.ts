/**
 * Live smoke: CoFHE full-lifecycle round-trip against Base Sepolia.
 *
 * Uses @cofhe/sdk, not the deprecated cofhejs: cofhejs ships node-tfhe@0.11.1,
 * which cannot deserialize the testnet's TFHE 0.5 CompactPkeCrs key format.
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
 *   - registerMarket(bytes32 marketId, Market schedule)   [six-instant schedule]
 *   - submitSealedFor(address agent, bytes32 marketId,
 *       (uint256,uint8,uint8,bytes) binaryIndexInput,
 *       (uint256,uint8,uint8,bytes) confidenceInput,
 *       bytes32 clientNonce) returns (bytes32 callId)
 *   - openReveal(bytes32 callId)
 *   - publishReveal(bytes32 callId, uint8 binaryIndex, uint16 confidenceBps,
 *       bytes binaryIndexSignature, bytes confidenceSignature)
 *   - getCall(bytes32 callId) view returns (agent, marketId, acceptedAt,
 *       binaryIndexCtHash, confidenceCtHash, revealedBinaryIndex, revealedConfidenceBps, state)
 *   - callPublicRevealAt(bytes32 callId) view returns (uint64)
 *
 * Threshold network API base: https://testnet-cofhe-tn.fhenix.zone
 *   POST /decrypt { ct_tempkey: hex64, host_chain_id: number, permit: Permission }
 *     → { decrypted: number[], signature: string, encryption_type: number, error_message?: string }
 *
 * IMPORTANT: cofhejs.decrypt() and @cofhe/sdk decryptForView return only the plaintext value.
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
import { createCofheClient, createCofheConfig } from "@cofhe/sdk/node";
import { baseSepolia as cofheBaseSepolia } from "@cofhe/sdk/chains";
import { Encryptable } from "@cofhe/sdk";
import {
  COFHE_EUINT8_UTYPE,
  COFHE_EUINT16_UTYPE,
} from "./fhenix-gateway-schemas.js";
import { loadDeployment } from "./deployments.js";

const CHAIN_ID = 84532;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 5_000;

const rpc = process.env.FHENIX_RPC_URL || process.env.BASE_RPC_URL;
if (!rpc) throw new Error("FHENIX_RPC_URL or BASE_RPC_URL must be set");
const relayerKey = (process.env.FHENIX_GATEWAY_RELAYER_PRIVATE_KEY ?? process.env.AGENT_PRIVATE_KEY) as Hex | undefined;
if (!relayerKey) throw new Error("FHENIX_GATEWAY_RELAYER_PRIVATE_KEY or AGENT_PRIVATE_KEY must be set");
const agentAddress = process.env.AGENT_ADDRESS;
if (!agentAddress) throw new Error("AGENT_ADDRESS must be set");

const sealed = loadDeployment(CHAIN_ID, "MurmurSealedVerdicts");
if (!sealed) throw new Error("MurmurSealedVerdicts not in manifest; run sync-deployments");
// 0.7 no longer echoes securityZone/utype back per input; we send what we
// asked the verifier to sign.
const COFHE_SECURITY_ZONE = 0;
const contractAddress = getAddress(sealed.address);
console.log(`[smoke] MurmurSealedVerdicts @ ${contractAddress}`);

const account = privateKeyToAccount(relayerKey);
const publicClient = createPublicClient({ chain: baseSepolia, transport: http(rpc) });
const walletClient = createWalletClient({ account, chain: baseSepolia, transport: http(rpc) });

// Minimal ABI — only what the smoke calls
// InEuint8/InEuint16 on-chain struct: (uint256 ctHash, uint8 securityZone, uint8 utype, bytes signature)
// Matches cofhejs CoFheInItem: { ctHash: bigint, securityZone: number, utype: FheTypes, signature: string }
const ABI = parseAbi([
  "function registerMarket(bytes32 marketId, (uint64 armCloseAt, uint64 submissionOpenAt, uint64 earlyAccessCutoffAt, uint64 submissionCloseAt, uint64 resolutionAt, uint64 publicRevealAt, bool active) schedule)",
  "function submitSealedFor(address agent, bytes32 marketId, (uint256 ctHash, uint8 securityZone, uint8 utype, bytes signature) binaryIndexInput, (uint256 ctHash, uint8 securityZone, uint8 utype, bytes signature) confidenceInput, bytes32 clientNonce) returns (bytes32 callId)",
  "function openReveal(bytes32 callId)",
  "function publishReveal(bytes32 callId, uint8 binaryIndex, uint16 confidenceBps, bytes binaryIndexSignature, bytes confidenceSignature)",
  "function getCall(bytes32 callId) view returns (address agent, bytes32 marketId, uint64 acceptedAt, bytes32 binaryIndexCtHash, bytes32 confidenceCtHash, uint8 revealedBinaryIndex, uint16 revealedConfidenceBps, uint8 state)",
  "function callPublicRevealAt(bytes32 callId) view returns (uint64)",
  "event SealedCallSubmitted(bytes32 indexed callId, address indexed agent, bytes32 indexed marketId, uint64 acceptedAt, uint64 publicRevealAt, bytes32 binaryIndexCtHash, bytes32 confidenceCtHash, bytes32 clientNonce, uint8 submissionClass)",
  "event RevealOpened(bytes32 indexed callId, bytes32 binaryIndexCtHash, bytes32 confidenceCtHash, uint64 openedAt)",
  "event VerdictRevealed(bytes32 indexed callId, address indexed agent, bytes32 indexed marketId, uint8 binaryIndex, uint16 confidenceBps, uint64 revealedAt)",
]);

async function main() {
  const startMs = Date.now();
  console.log("[smoke] starting");

  // Step 1 — register a market with a compressed six-instant schedule.
  // Every instant must be strictly ordered and armCloseAt must be in the
  // future, so the whole schedule is anchored a few seconds out.
  const marketId = keccak256(encodePacked(["string", "uint64"], [`smoke-${Date.now()}`, BigInt(Date.now())]));
  const base = BigInt(Math.floor(Date.now() / 1000));
  // REGISTRATION_LEAD is the gap from "we built this schedule" to armCloseAt,
  // and it has to cover the whole write: gas estimation, the RPC round trip,
  // and inclusion in a block. A 10s lead was NOT enough — the transaction
  // mined ~45s after the schedule was built, so the contract saw
  // `armCloseAt <= block.timestamp` and reverted RevealAfterMustBeFuture on
  // every run. That is the contract behaving correctly: registration must
  // complete before arming opens.
  //
  // Everything downstream is offset from armCloseAt rather than from `base`,
  // so widening the lead cannot silently compress a later window.
  const REGISTRATION_LEAD = 90n;
  const armCloseAt = base + REGISTRATION_LEAD;
  const schedule = {
    armCloseAt,
    // Wide enough for CoFHE SDK init + input encryption before the window
    // closes; a 20s budget was not.
    submissionOpenAt: armCloseAt + 10n,
    earlyAccessCutoffAt: armCloseAt + 140n,
    submissionCloseAt: armCloseAt + 170n,
    resolutionAt: armCloseAt + 190n,
    publicRevealAt: armCloseAt + 250n,
    active: true,
  };
  const revealAfter = schedule.publicRevealAt;
  console.log(`[smoke] registerMarket marketId=${marketId} publicRevealAt=${revealAfter}`);
  const registerTx = await walletClient.writeContract({
    address: contractAddress,
    abi: ABI,
    functionName: "registerMarket",
    args: [marketId, schedule],
  });
  await publicClient.waitForTransactionReceipt({ hash: registerTx });
  console.log(`[smoke] ok: market registered (tx=${registerTx})`);

  // Submissions are rejected before submissionOpenAt, so wait for the window.
  while (BigInt(Math.floor(Date.now() / 1000)) < schedule.submissionOpenAt) {
    await new Promise((r) => setTimeout(r, 1_000));
  }

  // Step 2 — initialize @cofhe/sdk against Base Sepolia testnet CoFHE
  console.log(`[smoke] initializing @cofhe/sdk client (chain=${CHAIN_ID})`);
  const cofheConfig = createCofheConfig({
    environment: "node",
    supportedChains: [cofheBaseSepolia],
  });
  const cofheClient = createCofheClient(cofheConfig);
  await cofheClient.connect(publicClient as never, walletClient as never);

  // Self-ACP, signed by the relayer, authorizing decryptForTx below.
  // 0.7 renamed the Permit system to ACP; options and semantics are unchanged.
  const selfAcp = await cofheClient.acp.createSelf({
    type: "self",
    issuer: account.address,
  });

  // Step 2 (continued) — encrypt binaryIndex=0 (euint8) and confidenceBps=7500 (euint16)
  console.log(`[smoke] encrypting inputs via @cofhe/sdk`);
  // 0.7: the consuming contract is bound into the batch signature, and
  // execute() returns [...ctHashes, batchSignature] — one element more than the
  // input count, with a single signature covering both hashes in order.
  const encryptedInputs = await cofheClient
    .encryptInputs([
      Encryptable.uint8(BigInt(0)),
      Encryptable.uint16(BigInt(7500)),
    ])
    .setAccount(account.address)
    .setSecurityZone(COFHE_SECURITY_ZONE)
    .setConsumingContract(contractAddress)
    .execute();
  const [binCtHash, confCtHash, batchSignature] = encryptedInputs;
  console.log(`[smoke] encrypted: binCtHash=${binCtHash} confCtHash=${confCtHash}`);

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
      // Both inputs carry the SAME batch signature under 0.7. The deployed
      // contract still takes a per-input signature, so this submit only lands
      // once MurmurSealedVerdicts moves to the batch (FHE.asEuint*s) form.
      {
        ctHash: BigInt(binCtHash),
        securityZone: COFHE_SECURITY_ZONE,
        utype: COFHE_EUINT8_UTYPE,
        signature: batchSignature as Hex,
      },
      {
        ctHash: BigInt(confCtHash),
        securityZone: COFHE_SECURITY_ZONE,
        utype: COFHE_EUINT16_UTYPE,
        signature: batchSignature as Hex,
      },
      clientNonce,
    ],
  });
  const submitReceipt = await publicClient.waitForTransactionReceipt({ hash: submitTx });

  // Extract callId from SealedCallSubmitted event (topic[1] = callId)
  const sealedCallTopic = keccak256(toHex("SealedCallSubmitted(bytes32,address,bytes32,uint64,uint64,bytes32,bytes32,bytes32,uint8)"));
  const submittedLog = submitReceipt.logs.find(
    (l) => l.address.toLowerCase() === contractAddress.toLowerCase()
      && l.topics[0] === sealedCallTopic,
  );
  assert.ok(submittedLog, "SealedCallSubmitted log not found");
  const callId = submittedLog!.topics[1] as Hex;
  console.log(`[smoke] ok: sealed call submitted (callId=${callId}, tx=${submitTx})`);

  // Step 4 — wait until the reveal window opens (max 15 min guard)
  // Polled, for the same reason as the final-state read below: the
  // submitSealedFor receipt is confirmed, but a load-balanced RPC can serve
  // this from a replica that has not seen the call yet, and the contract then
  // reverts CallNotFound on a call that certainly exists. Bounded, so a call
  // that genuinely never landed still fails.
  const REVEAL_AT_TIMEOUT_MS = 60_000;
  const revealAtDeadline = Date.now() + REVEAL_AT_TIMEOUT_MS;
  let publicRevealAt: bigint | undefined;
  for (;;) {
    try {
      publicRevealAt = (await publicClient.readContract({
        address: contractAddress,
        abi: ABI,
        functionName: "callPublicRevealAt",
        args: [callId],
      })) as bigint;
      break;
    } catch (err) {
      if (Date.now() > revealAtDeadline) {
        throw new Error(
          `callPublicRevealAt(${callId}) still reverting ${
            REVEAL_AT_TIMEOUT_MS / 1000
          }s after the submit receipt confirmed: ${(err as Error).message}`,
        );
      }
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }
  const maxWaitMs = 15 * 60 * 1000;
  const waitDeadline = Date.now() + maxWaitMs;
  console.log(`[smoke] waiting for reveal window (publicRevealAt=${publicRevealAt}, now=${Math.floor(Date.now() / 1000)})`);
  while (Math.floor(Date.now() / 1000) < Number(publicRevealAt)) {
    if (Date.now() > waitDeadline) throw new Error("Timed out waiting for reveal window");
    const remaining = Number(publicRevealAt) - Math.floor(Date.now() / 1000);
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

  // Step 6 — decrypt via the SDK's v2 `decryptForTx` path. It returns the
  // threshold-network signature in the exact form `FHE.verifyDecryptResult`
  // (and thus `publishReveal`) accepts on-chain. The older hand-rolled v1
  // `/decrypt` signature is rejected by the current CoFHE verifier
  // (`InvalidSignature`, 0x8baa579f). `openReveal` already called
  // `FHE.allowPublic`; the threshold network needs ~5-30s to observe it, so
  // retry transient errors. Mirrors tools/operator-blind-roundtrip.ts.
  console.log(`[smoke] decrypting via @cofhe/sdk decryptForTx (timeout=${POLL_TIMEOUT_MS / 1000}s)`);
  const decryptForTxWithRetry = async (
    label: string,
    ctHash: bigint,
  ): Promise<{ decrypted: bigint; signature: Hex }> => {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    let attempt = 0;
    while (Date.now() < deadline) {
      attempt++;
      try {
        const r = await cofheClient
          .decryptForTx(ctHash)
          .withACP(selfAcp as never)
          .execute();
        console.log(`[smoke] ${label} decrypted after ${attempt} attempt(s)`);
        return { decrypted: r.decryptedValue, signature: r.signature as Hex };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (Date.now() + POLL_INTERVAL_MS > deadline) {
          throw new Error(`${label} timed out after ${attempt} attempt(s): ${msg}`);
        }
        console.log(`[smoke] polling ${label} (attempt=${attempt}, ${msg})…`);
        await new Promise((res) => setTimeout(res, POLL_INTERVAL_MS));
      }
    }
    throw new Error(`${label} timed out after ${attempt} attempts`);
  };

  const binDecrypt = await decryptForTxWithRetry("binaryIndex decrypt", binCtHashBigint);
  const confDecrypt = await decryptForTxWithRetry("confidenceBps decrypt", confCtHashBigint);

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

  // Step 8 — assert final state.
  //
  // POLLED, not read once. The publishReveal receipt is already confirmed
  // above, but a load-balanced RPC can still serve this read from a replica
  // that has not caught up — observed on Alchemy: the assertion failed while
  // the contract genuinely held state=3 with the correct values. A single
  // read here turns provider lag into a false privacy/lifecycle failure.
  //
  // Bounded, so a genuinely stuck reveal still fails rather than hanging.
  const FINAL_STATE_TIMEOUT_MS = 60_000;
  const finalDeadline = Date.now() + FINAL_STATE_TIMEOUT_MS;
  let finalState = 0;
  let finalCallData: readonly unknown[] = [];
  for (;;) {
    finalCallData = (await publicClient.readContract({
      address: contractAddress,
      abi: ABI,
      functionName: "getCall",
      args: [callId],
    })) as readonly unknown[];
    // uint8 state (CallState: 0=None,1=Sealed,2=Opened,3=Revealed,4=Invalid)
    finalState = Number(finalCallData[7]);
    if (finalState === 3 || finalState === 4) break;
    if (Date.now() > finalDeadline) break;
    await new Promise((r) => setTimeout(r, 2_000));
  }
  assert.equal(
    finalState,
    3,
    `expected calls[callId].state === Revealed(3), got ${finalState} after ` +
      `polling ${FINAL_STATE_TIMEOUT_MS / 1000}s past the publishReveal receipt`,
  );
  console.log(`[smoke] ok: final state Revealed`);

  const elapsedSec = ((Date.now() - startMs) / 1000).toFixed(1);
  console.log(`[smoke] PASS callId=${callId} elapsed=${elapsedSec}s`);
}

main().catch((err) => {
  console.error("[smoke] FAILED:", err);
  process.exit(1);
});
