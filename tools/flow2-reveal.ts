#!/usr/bin/env tsx
/** Flow 2 proof — complete the public reveal on the new contract (Flow 1 still
 *  works alongside the paid private grant). openReveal → threshold decrypt →
 *  publishReveal, then confirm the public plaintext matches. */
import { createPublicClient, createWalletClient, http, parseAbi, getAddress, type Hex, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia } from "viem/chains";
import { createCofheClient, createCofheConfig } from "@cofhe/sdk/node";
import { arbSepolia as cofheArbitrumSepolia } from "@cofhe/sdk/chains";

const ABI = parseAbi([
  "function openReveal(bytes32 callId)",
  "function publishReveal(bytes32 callId, uint8 binaryIndex, uint16 confidenceBps, bytes binaryIndexSignature, bytes confidenceSignature)",
  "function getCall(bytes32 callId) view returns (address agent, bytes32 marketId, uint64 acceptedAt, bytes32 binaryIndexCtHash, bytes32 confidenceCtHash, uint8 revealedBinaryIndex, uint16 revealedConfidenceBps, uint8 state)",
  "function callPublicRevealAt(bytes32 callId) view returns (uint64)",
]);
const env = (n: string) => { const v = process.env[n]?.trim(); if (!v) throw new Error(`missing ${n}`); return v; };

async function main() {
  const rpcUrl = env("FHENIX_RPC_URL");
  const contract = getAddress(env("FLOW2_CONTRACT"));
  const callId = env("FLOW2_CALL_ID") as Hex;
  const account = privateKeyToAccount(env("REVEAL_PRIVATE_KEY") as Hex);
  const publicClient = createPublicClient({ chain: arbitrumSepolia, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account, chain: arbitrumSepolia, transport: http(rpcUrl) });
  const cofhe = createCofheClient(createCofheConfig({ environment: "node", supportedChains: [cofheArbitrumSepolia] }));
  await cofhe.connect(publicClient as never, walletClient as never);
  const acp = await cofhe.acp.createSelf({ type: "self", issuer: account.address });

  const openAt = Number(await publicClient.readContract({ address: contract, abi: ABI, functionName: "callPublicRevealAt", args: [callId] }));
  while (Math.floor(Date.now() / 1000) < openAt) {
    console.log(`[reveal] ${openAt - Math.floor(Date.now() / 1000)}s until reveal window…`);
    await new Promise((r) => setTimeout(r, 5000));
  }
  let call = (await publicClient.readContract({ address: contract, abi: ABI, functionName: "getCall", args: [callId] })) as readonly [Address, Hex, bigint, Hex, Hex, number, number, number];
  if (call[7] === 1) {
    const openTx = await walletClient.writeContract({ address: contract, abi: ABI, functionName: "openReveal", args: [callId], chain: arbitrumSepolia, account });
    await publicClient.waitForTransactionReceipt({ hash: openTx });
    console.log(`[reveal] openReveal ok`);
    call = (await publicClient.readContract({ address: contract, abi: ABI, functionName: "getCall", args: [callId] })) as typeof call;
  }
  const dec = async (ct: bigint) => {
    for (let i = 0; i < 30; i++) {
      try { return (await cofhe.decryptForTx(ct).withACP(acp as never).execute()) as { decryptedValue: bigint; signature: Hex }; }
      catch (e) { await new Promise((r) => setTimeout(r, 8000)); if (i === 29) throw e; }
    }
    throw new Error("decrypt timeout");
  };
  const bin = await dec(BigInt(call[3]));
  const conf = await dec(BigInt(call[4]));
  console.log(`[reveal] decryptForTx: binaryIndex=${bin.decryptedValue} confidenceBps=${conf.decryptedValue} (sig lens ${bin.signature.length}/${conf.signature.length})`);
  const pubTx = await walletClient.writeContract({ address: contract, abi: ABI, functionName: "publishReveal", args: [callId, Number(bin.decryptedValue), Number(conf.decryptedValue), bin.signature, conf.signature], chain: arbitrumSepolia, account });
  const pubRcpt = await publicClient.waitForTransactionReceipt({ hash: pubTx });
  console.log(`[reveal] publishReveal tx ${pubTx} status=${pubRcpt.status}`);
  const after = (await publicClient.readContract({ address: contract, abi: ABI, functionName: "getCall", args: [callId] })) as typeof call;
  console.log(`[reveal] publishReveal ok — PUBLIC plaintext: binaryIndex=${after[5]} confidenceBps=${after[6]} state=${after[7]}`);
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
