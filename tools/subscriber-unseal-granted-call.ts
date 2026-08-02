#!/usr/bin/env tsx
/**
 * Flow 2 subscriber tooling — unseal a granted sealed call CLIENT-SIDE.
 *
 * Proves that a subscriber who was granted early private decrypt access (via
 * POST /v2/gateway/calls/:callId/access → grantDecryptAccess on-chain) — and
 * ONLY they — can read the agent's sealed prediction before the public reveal.
 * Murmur never sees the plaintext: the CoFHE threshold network seals the output
 * to the subscriber's self permit and the SDK unseals it locally.
 *
 * This is a MANUAL script (it needs a funded/authorized subscriber wallet and a
 * live CoFHE threshold network), so it is intentionally NOT a *.smoke.ts and is
 * not run in CI. Run it after the access purchase confirms `granted`:
 *
 *   FHENIX_RPC_URL=... \
 *   FHENIX_CHAIN_ID=84532 \
 *   FHENIX_SEALED_VERDICTS_ADDRESS=0x... \
 *   SUBSCRIBER_PRIVATE_KEY=0x... \
 *   npx tsx tools/subscriber-unseal-granted-call.ts <onchainCallId>
 *
 * The contract exposes both ciphertext handles + the subscriber's grant flag
 * via getDecryptAccess(callId, subscriber); the two encrypted fields are
 * binaryIndex (FheTypes.Uint8) and confidenceBps (FheTypes.Uint16).
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createCofheClient, createCofheConfig } from "@cofhe/sdk/node";
import { baseSepolia as cofheBaseSepolia } from "@cofhe/sdk/chains";
import { FheTypes } from "@cofhe/sdk";

const GETTER_ABI = parseAbi([
  "function getDecryptAccess(bytes32 callId, address subscriber) view returns (uint8 state, uint64 revealOpenAt, bytes32 binaryIndexCtHash, bytes32 confidenceCtHash, bool alreadyGranted)",
]);

async function main(): Promise<void> {
  const callId = process.argv[2];
  if (!callId || !/^0x[0-9a-fA-F]{64}$/.test(callId)) {
    throw new Error("usage: subscriber-unseal-granted-call.ts <onchainCallId bytes32>");
  }
  const rpcUrl = requireEnv("FHENIX_RPC_URL");
  const contract = requireEnv("FHENIX_SEALED_VERDICTS_ADDRESS") as Hex;
  const privateKey = requireEnv("SUBSCRIBER_PRIVATE_KEY");
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error("SUBSCRIBER_PRIVATE_KEY must be a 32-byte 0x private key");
  }

  const account = privateKeyToAccount(privateKey as Hex);
  const publicClient = createPublicClient({ transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account, transport: http(rpcUrl) });

  // 1. Read the ciphertext handles + confirm this wallet holds the grant.
  const view = (await publicClient.readContract({
    address: contract,
    abi: GETTER_ABI,
    functionName: "getDecryptAccess",
    args: [callId as Hex, account.address],
  })) as readonly [number, bigint, string, string, boolean];
  const [state, revealOpenAt, binaryIndexCtHash, confidenceCtHash, alreadyGranted] = view;

  process.stdout.write(
    `call=${callId} state=${state} revealOpenAt=${revealOpenAt} granted=${alreadyGranted}\n`,
  );
  if (!alreadyGranted) {
    throw new Error(
      `subscriber ${account.address} is NOT granted decrypt access to this call — purchase access first`,
    );
  }

  // 2. Connect the subscriber wallet and build a SELF permit (not a shared
  //    permit): the threshold output is sealed to this wallet's key only.
  const client = createCofheClient(
    createCofheConfig({ environment: "node", supportedChains: [cofheBaseSepolia] }),
  );
  await client.connect(publicClient as never, walletClient as never);
  const permit = await client.permits.createSelf({ type: "self", issuer: account.address });

  // 3. decryptForView each handle with the self permit. The SDK runs threshold
  //    decryption then unseals the sealed output locally — plaintext never
  //    leaves this process.
  const binaryIndex = await client
    .decryptForView(BigInt(binaryIndexCtHash), FheTypes.Uint8)
    .withPermit(permit as never)
    .execute();
  const confidenceBps = await client
    .decryptForView(BigInt(confidenceCtHash), FheTypes.Uint16)
    .withPermit(permit as never)
    .execute();

  process.stdout.write(
    `UNSEALED (local, ${account.address} only):\n` +
      `  binaryIndex  (Uint8)  = ${String(binaryIndex)}\n` +
      `  confidenceBps(Uint16) = ${String(confidenceBps)}\n`,
  );
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required env ${name}`);
  return value;
}

main().catch((err) => {
  process.stderr.write(`subscriber-unseal failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
