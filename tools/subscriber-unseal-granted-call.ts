#!/usr/bin/env tsx
/**
 * Flow 2 subscriber tooling — unseal a granted sealed call CLIENT-SIDE.
 *
 * Proves that a subscriber who was granted early private decrypt access (via
 * POST /v2/gateway/calls/:callId/access → grantDecryptAccess on-chain) — and
 * ONLY they — can read the agent's sealed prediction before the public reveal.
 * Murmur never sees the plaintext: the CoFHE threshold network seals the output
 * to the subscriber's self ACP and the SDK unseals it locally.
 *
 * This is a MANUAL script (it needs a funded/authorized subscriber wallet and a
 * live CoFHE threshold network), so it is intentionally NOT a *.smoke.ts and is
 * not run in CI. Run it after the access purchase confirms `granted`:
 *
 *   npx tsx tools/subscriber-unseal-granted-call.ts <onchainCallId>
 *
 * Required env, read from the `.env` beside you (same file the buy tool uses):
 *
 *   SUBSCRIBER_PRIVATE_KEY          the wallet that was granted access
 *   FHENIX_RPC_URL                  an RPC for the chain the contract lives on
 *   FHENIX_SEALED_VERDICTS_ADDRESS  that contract
 *
 * The last two are NOT derived from the deployment manifest on purpose: this
 * tool talks only to the chain, and the contract that matters is whichever one
 * the daemon you BOUGHT FROM grants on. It publishes both as
 * `fhenix.contract_address` and `fhenix.chain_id` on GET /v1/meta; a local
 * data/deployments.json describes some other operator's deployment and would
 * silently read the wrong contract, which surfaces as "NOT granted".
 *
 * The contract exposes both ciphertext handles + the subscriber's grant flag
 * via getDecryptAccess(callId, subscriber); the two encrypted fields are
 * binaryIndex (FheTypes.Uint8) and confidenceBps (FheTypes.Uint16).
 */
// The docs tell a buyer to put these in a `chmod 600` .env rather than on a
// command line, so this has to read one. Matches tools/subscriber-buy-access.ts.
import "dotenv/config";
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

import { COFHE_404_RETRY_TIMEOUT_MS } from "../src/integrations/cofhe-decrypt-tuning.js";

const RETRY_INTERVAL_MS = 3_000;

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

  // 2. Connect the subscriber wallet and build a SELF ACP (not a shared ACP):
  //    the threshold output is sealed to this wallet's key only.
  const client = createCofheClient(
    createCofheConfig({ environment: "node", supportedChains: [cofheBaseSepolia] }),
  );
  await client.connect(publicClient as never, walletClient as never);
  const acp = await client.acp.createSelf({ type: "self", issuer: account.address });

  // 3. decryptForView each handle with the self ACP. The SDK runs threshold
  //    decryption then unseals the sealed output locally — plaintext never
  //    leaves this process.
  //
  //    Retry is REQUIRED here. After grantDecryptAccess lands on-chain the
  //    threshold network needs ~5-30s to observe the ACL write, and until it
  //    does it rejects the request. Two distinct rejections matter:
  //
  //      * 403/Forbidden — how this repo has observed ACL lag in practice
  //        (see fhenix-reveal-worker.ts and tools/operator-blind-roundtrip.ts).
  //        The SDK treats 403 as FATAL: isRetryableSubmitStatus covers only
  //        204/404, so set404RetryTimeout does NOT help here. Hence the
  //        explicit loop below.
  //      * 404/204 — not-yet-indexed at submit. The SDK does retry these, but
  //        only for 10s by default, which is shorter than the observed lag.
  //
  //    So we widen the SDK's own window AND wrap the call, covering both.
  const deadlineMs = Date.now() + COFHE_404_RETRY_TIMEOUT_MS;
  const decryptWithRetry = async <T>(
    label: string,
    run: () => Promise<T>,
  ): Promise<T> => {
    let attempt = 0;
    for (;;) {
      attempt += 1;
      try {
        return await run();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Only ACL-propagation rejections are worth retrying. A genuinely
        // ungranted wallet also 403s, but the pre-flight `alreadyGranted`
        // check above has already ruled that out, so within the deadline a
        // 403 here means "not indexed yet".
        const retryable = /\b(403|forbidden|404|not found)\b/i.test(msg);
        if (!retryable || Date.now() + RETRY_INTERVAL_MS >= deadlineMs) {
          throw new Error(`${label} failed after ${attempt} attempt(s): ${msg}`);
        }
        process.stdout.write(
          `${label}: attempt ${attempt} rejected (${msg}); threshold network likely still indexing the grant — retrying in ${RETRY_INTERVAL_MS / 1000}s\n`,
        );
        await new Promise((r) => setTimeout(r, RETRY_INTERVAL_MS));
      }
    }
  };

  //    The two handles are independent, so decrypt them concurrently rather
  //    than sequentially — serial decryption doubles time-to-plaintext for no
  //    reason, and on a short-horizon market that is most of the usable window.
  const [binaryIndex, confidenceBps] = await Promise.all([
    decryptWithRetry("binaryIndex", () =>
      client
        .decryptForView(BigInt(binaryIndexCtHash), FheTypes.Uint8)
        .set404RetryTimeout(COFHE_404_RETRY_TIMEOUT_MS)
        .withACP(acp as never)
        .execute(),
    ),
    decryptWithRetry("confidenceBps", () =>
      client
        .decryptForView(BigInt(confidenceCtHash), FheTypes.Uint16)
        .set404RetryTimeout(COFHE_404_RETRY_TIMEOUT_MS)
        .withACP(acp as never)
        .execute(),
    ),
  ]);

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
