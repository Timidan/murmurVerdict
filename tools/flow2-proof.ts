#!/usr/bin/env tsx
/**
 * Flow 2 live proof (operator, manual) — register a market on the given
 * MurmurSealedVerdicts, seal+submit a call, then grantDecryptAccess to a
 * subscriber. Prints the on-chain callId + the plaintext it sealed, so the
 * subscriber-unseal tool can prove that ONLY the granted wallet reads it.
 *
 *   FLOW2_CONTRACT=0x... RELAYER_PRIVATE_KEY=0x... GRANTOR_PRIVATE_KEY=0x... \
 *   SUBSCRIBER_ADDRESS=0x... FHENIX_RPC_URL=... npx tsx tools/flow2-proof.ts
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  getAddress,
  decodeEventLog,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { randomBytes } from "node:crypto";
import { createCofheClient, createCofheConfig } from "@cofhe/sdk/node";
import { baseSepolia as cofheBaseSepolia } from "@cofhe/sdk/chains";
import { Encryptable } from "@cofhe/sdk";
// 0.7 stopped echoing securityZone/utype per input, and the contract no longer
// takes either at runtime — utype is a compile-time brand on externalEuint*.
const COFHE_SECURITY_ZONE = 0;

const ABI = parseAbi([
  "function registerMarket(bytes32 marketId, (uint64 armCloseAt, uint64 submissionOpenAt, uint64 earlyAccessCutoffAt, uint64 submissionCloseAt, uint64 resolutionAt, uint64 publicRevealAt, bool active) schedule)",
  // 0.7: two bare ciphertext handles plus the ONE proof covering both.
  "function submitSealedFor(address agent, bytes32 marketId, bytes32 binaryIndexInput, bytes32 confidenceInput, bytes inputProof, bytes32 clientNonce) returns (bytes32 callId)",
  "function grantDecryptAccess(bytes32 callId, address subscriber)",
  "function getDecryptAccess(bytes32 callId, address subscriber) view returns (uint8 state, uint64 grantCloseAt, bytes32 binaryIndexCtHash, bytes32 confidenceCtHash, bool alreadyGranted)",
  "event SealedCallSubmitted(bytes32 indexed callId, address indexed agent, bytes32 indexed marketId, uint64 acceptedAt, uint64 publicRevealAt, bytes32 binaryIndexCtHash, bytes32 confidenceCtHash, bytes32 clientNonce, uint8 submissionClass)",
]);

function env(n: string): string {
  const v = process.env[n]?.trim();
  if (!v) throw new Error(`missing ${n}`);
  return v;
}

async function main(): Promise<void> {
  const rpcUrl = env("FHENIX_RPC_URL");
  const contract = getAddress(env("FLOW2_CONTRACT"));
  const relayer = privateKeyToAccount(env("RELAYER_PRIVATE_KEY") as Hex);
  const grantor = privateKeyToAccount(env("GRANTOR_PRIVATE_KEY") as Hex);
  const subscriber = getAddress(env("SUBSCRIBER_ADDRESS"));
  const BIN = 1; // Down
  const CONF = 8800; // 88.00%
  const revealSec = Number(process.env.FLOW2_REVEAL_SEC ?? "240");

  const publicClient = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
  const relayerWallet = createWalletClient({ account: relayer, chain: baseSepolia, transport: http(rpcUrl) });
  const grantorWallet = createWalletClient({ account: grantor, chain: baseSepolia, transport: http(rpcUrl) });

  const marketId = ("0x" + randomBytes(32).toString("hex")) as Hex;
  const clientNonce = ("0x" + randomBytes(32).toString("hex")) as Hex;
  const nowSec = Math.floor(Date.now() / 1000);
  const revealAfter = nowSec + revealSec;

  // 1. register the market's six-instant schedule (owner == relayer here).
  // Compressed for the proof run, but still strictly ordered with armCloseAt
  // in the future, which registration enforces.
  const schedule = {
    // Wide enough for CoFHE SDK init + input encryption; 30s was not.
    armCloseAt: BigInt(nowSec + 10),
    submissionOpenAt: BigInt(nowSec + 20),
    earlyAccessCutoffAt: BigInt(nowSec + 150),
    submissionCloseAt: BigInt(nowSec + 180),
    resolutionAt: BigInt(nowSec + 200),
    publicRevealAt: BigInt(revealAfter),
    active: true,
  };
  console.log(`[flow2] registerMarket ${marketId} publicRevealAt=${revealAfter} (+${revealSec}s)`);
  const regTx = await relayerWallet.writeContract({
    address: contract, abi: ABI, functionName: "registerMarket",
    args: [marketId, schedule], chain: baseSepolia, account: relayer,
  });
  await publicClient.waitForTransactionReceipt({ hash: regTx });

  // Submissions are rejected before submissionOpenAt.
  while (BigInt(Math.floor(Date.now() / 1000)) < schedule.submissionOpenAt) {
    await new Promise((r) => setTimeout(r, 1_000));
  }

  // 2. seal (CoFHE encrypt) + submitSealedFor.
  console.log(`[flow2] connecting @cofhe/sdk + encrypting inputs (binaryIndex=${BIN}, confidenceBps=${CONF})`);
  const cofhe = createCofheClient(createCofheConfig({ environment: "node", supportedChains: [cofheBaseSepolia] }));
  await cofhe.connect(publicClient as never, relayerWallet as never);
  // 0.7 renamed Permits to ACPs.
  await cofhe.acp.createSelf({ type: "self", issuer: relayer.address });
  // 0.7 binds the consuming contract into a SINGLE batch signature and returns
  // [...ctHashes, batchSignature] — one element more than the input count.
  const enc = await cofhe
    .encryptInputs([Encryptable.uint8(BigInt(BIN)), Encryptable.uint16(BigInt(CONF))] as never)
    .setAccount(relayer.address)
    .setSecurityZone(COFHE_SECURITY_ZONE)
    .setConsumingContract(contract)
    .execute();
  const [binCtHash, confCtHash, batchSignature] = enc as unknown as [Hex, Hex, Hex];

  console.log(`[flow2] submitSealedFor agent=${relayer.address}`);
  const subTx = await relayerWallet.writeContract({
    address: contract, abi: ABI, functionName: "submitSealedFor",
    args: [
      relayer.address, marketId,
      // Handle order is signed over: euint8 first, euint16 second, then the
      // one batch signature covering both.
      binCtHash, confCtHash, batchSignature,
      clientNonce,
    ] as never,
    chain: baseSepolia, account: relayer,
  });
  const subRcpt = await publicClient.waitForTransactionReceipt({ hash: subTx });
  let callId: Hex | null = null;
  for (const log of subRcpt.logs) {
    try {
      const d = decodeEventLog({ abi: ABI, data: log.data, topics: log.topics });
      if (d.eventName === "SealedCallSubmitted") { callId = (d.args as { callId: Hex }).callId; break; }
    } catch { /* not our event */ }
  }
  if (!callId) throw new Error("could not extract callId from SealedCallSubmitted");
  console.log(`[flow2] SEALED call submitted: callId=${callId}`);

  // 3. grant decrypt access to the subscriber (grantor key, BEFORE revealOpenAt).
  console.log(`[flow2] grantDecryptAccess(${callId}, ${subscriber}) from grantor ${grantor.address}`);
  const grantTx = await grantorWallet.writeContract({
    address: contract, abi: ABI, functionName: "grantDecryptAccess",
    args: [callId, subscriber], chain: baseSepolia, account: grantor,
  });
  await publicClient.waitForTransactionReceipt({ hash: grantTx });

  const view = (await publicClient.readContract({
    address: contract, abi: ABI, functionName: "getDecryptAccess", args: [callId, subscriber],
  })) as readonly [number, bigint, string, string, boolean];
  console.log(`[flow2] on-chain getDecryptAccess(subscriber): state=${view[0]} grantCloseAt=${view[1]} granted=${view[4]}`);

  console.log(`\n=== PROOF INPUTS (sealed, on-chain) ===`);
  console.log(`FLOW2_CALL_ID=${callId}`);
  console.log(`SUBMITTED binaryIndex=${BIN} confidenceBps=${CONF}`);
  console.log(`PUBLIC_REVEAL_AT=${revealAfter}`);
  console.log(`GRANT_CLOSE_AT=${schedule.submissionCloseAt} (buying closes when the prediction window opens \u2014 strictly BEFORE public reveal)`);
}

main().catch((e) => { console.error(e instanceof Error ? (e.stack ?? e.message) : String(e)); process.exit(1); });
