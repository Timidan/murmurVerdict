import { strict as assert } from "node:assert";
import {
  encodeAbiParameters,
  padHex,
  parseAbiParameters,
  type Address,
  type Hex,
} from "viem";
import { SEALED_CALL_SUBMITTED_TOPIC } from "./fhenix-event-primitives.js";
import {
  FhenixEventVerificationError,
  ViemFhenixEventVerifier,
  fhenixMarketIdForMurmurMarket,
  loadFhenixEventVerifierConfig,
} from "./fhenix-events.js";

let failures = 0;

async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    process.stdout.write(`  ok ${name}\n`);
  } catch (err) {
    failures += 1;
    process.stdout.write(`  fail ${name}\n`);
    process.stdout.write(`      ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

process.stdout.write("murmur fhenix events smoke\n");

const chainId = 84532;
const contract = "0x2222222222222222222222222222222222222222";
const resolvedContract = "0x3333333333333333333333333333333333333333";
const agent = "0x1111111111111111111111111111111111111111";
const marketId = "eth.1h";
const onchainCallId = "0x" + "33".repeat(32);
const submitTxHash = "0x" + "44".repeat(32);
const acceptedAt = "2026-05-14T12:00:00Z";
const revealOpenAt = "2026-05-14T13:00:00Z";
const binaryIndexCtHash = ("0x" + "55".repeat(32)) as Hex;
const confidenceCtHash = ("0x" + "66".repeat(32)) as Hex;
const clientNonce = ("0x" + "77".repeat(32)) as Hex;
const eventTopic = SEALED_CALL_SUBMITTED_TOPIC;
const encodedData = encodeAbiParameters(
  parseAbiParameters("uint64,uint64,bytes32,bytes32,bytes32"),
  [
    BigInt(Date.parse(acceptedAt) / 1000),
    BigInt(Date.parse(revealOpenAt) / 1000),
    binaryIndexCtHash,
    confidenceCtHash,
    clientNonce,
  ],
);
const topics = [
  eventTopic,
  onchainCallId as Hex,
  padHex(agent as Hex, { size: 32 }),
  fhenixMarketIdForMurmurMarket(marketId) as Hex,
] as const;
const client = {
  getChainId: async () => chainId,
  getTransactionReceipt: async () => ({
    logs: [
      {
        address: contract as Address,
        data: encodedData,
        topics,
        logIndex: 7,
      },
    ],
  }),
};

await check("verifier config consumes resolved contract address", () => {
  const env = {
    FHENIX_RPC_URL: "http://fhenix.invalid",
    FHENIX_CHAIN_ID: String(chainId),
  };
  assert.throws(
    () =>
      loadFhenixEventVerifierConfig({
        FHENIX_RPC_URL: "http://fhenix.invalid",
      }),
    (err) =>
      err instanceof FhenixEventVerificationError &&
      err.kind === "not_configured",
  );
  assert.throws(
    () =>
      loadFhenixEventVerifierConfig({
        FHENIX_RPC_URL: "http://fhenix.invalid",
        FHENIX_CHAIN_ID: "not-a-chain",
      }),
    (err) =>
      err instanceof FhenixEventVerificationError &&
      err.kind === "not_configured",
  );
  assert.equal(
    loadFhenixEventVerifierConfig(env, {
      contractAddress: resolvedContract,
    })?.contractAddress,
    resolvedContract,
  );
  assert.throws(
    () =>
      loadFhenixEventVerifierConfig({
        ...env,
        FHENIX_SEALED_VERDICTS_ADDRESS: contract,
      }, {
        contractAddress: null,
      }),
    (err) =>
      err instanceof FhenixEventVerificationError &&
      err.kind === "not_configured",
  );
  assert.throws(
    () =>
      loadFhenixEventVerifierConfig(env, {
        contractAddress: "not-an-address",
      }),
    (err) =>
      err instanceof FhenixEventVerificationError &&
      err.kind === "not_configured",
  );
});

await check("verifier accepts configured contract event", async () => {
  const verifier = new ViemFhenixEventVerifier({
    rpcUrl: "",
    chainId,
    contractAddress: contract,
    client: client as never,
  });
  const verified = await verifier.verifySealedCallSubmitted({
    chain_id: chainId,
    contract_address: contract,
    onchain_call_id: onchainCallId,
    submit_tx_hash: submitTxHash,
    submit_log_index: 7,
    binary_index_ct_hash: binaryIndexCtHash,
    confidence_ct_hash: confidenceCtHash,
    accepted_at: acceptedAt,
    reveal_open_at: revealOpenAt,
    expected_agent_wallet: agent,
    expected_market_id: marketId,
  });
  assert.equal(verified.contract_address, contract);
});

await check("verifier rejects non-allowlisted contract", async () => {
  const verifier = new ViemFhenixEventVerifier({
    rpcUrl: "",
    chainId,
    contractAddress: "0x9999999999999999999999999999999999999999",
    client: client as never,
  });
  await assert.rejects(
    () =>
      verifier.verifySealedCallSubmitted({
        chain_id: chainId,
        contract_address: contract,
        onchain_call_id: onchainCallId,
        submit_tx_hash: submitTxHash,
        submit_log_index: 7,
        binary_index_ct_hash: binaryIndexCtHash,
        confidence_ct_hash: confidenceCtHash,
        accepted_at: acceptedAt,
        reveal_open_at: revealOpenAt,
        expected_agent_wallet: agent,
        expected_market_id: marketId,
      }),
    /allowlisted/,
  );
});

if (failures > 0) {
  process.stdout.write(`fhenix events smoke failed: ${failures} failure(s)\n`);
  process.exit(1);
}

process.stdout.write("fhenix events smoke ok\n");
