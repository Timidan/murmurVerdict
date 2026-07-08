import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import express from "express";
import {
  encodeAbiParameters,
  keccak256,
  padHex,
  parseAbiParameters,
  toBytes,
  type Address,
  type Hex,
} from "viem";

import { ViemFhenixEventVerifier, fhenixMarketIdForMurmurMarket } from "./fhenix-events.js";
import {
  FhenixGatewayBroadcaster,
  type FhenixGatewayClient,
} from "./fhenix-gateway.js";
import type { MurmurOwnedCofheSealer } from "./murmur-owned-cofhe-sealer.js";
import {
  MurmurOwnedSealedCallBodySchema,
} from "./murmur-owned-sealing-schemas.js";
import { createVerdictRouter } from "../verdict/api.js";
import {
  bindControllerWallet,
  getOrCreateAccount,
  linkAgentToAccount,
  mintRuntimeKey,
} from "../verdict/auth/accounts.js";
import {
  agentsRepo,
  feedContractsRepo,
  feedPacketsRepo,
  fhenixGatewayFeedPacketTxRepo,
  fhenixGatewayTxRepo,
  fhenixSealedCallsRepo,
  marketsRepo,
  openDb,
  submissionsRepo,
} from "../verdict/db.js";
import { canonicalHash, canonicalize } from "../receipts/canonical.js";

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

process.stdout.write("murmur fhenix gateway smoke\n");

const tmp = mkdtempSync(join(tmpdir(), "murmur-fhenix-gateway-smoke-"));
const dbPath = join(tmp, "test.db");
let server: Server | null = null;

try {
  const chainId = 84532;
  const acceptedAt = "2026-05-14T12:00:00Z";
  const revealOpenAt = "2026-05-14T13:00:00Z";
  const contract = "0x2222222222222222222222222222222222222222";
  const relayer = "0x3333333333333333333333333333333333333333";
  const wallet = "0x1111111111111111111111111111111111111111";
  const marketId = "0x" + "ab".repeat(32);
  const disallowedMarketId = "0x" + "cd".repeat(32);
  const txHash = "0x" + "44".repeat(32);
  const retryTxHash = "0x" + "49".repeat(32);
  const feedTxHash = "0x" + "4a".repeat(32);
  const onchainCallId = "0x" + "88".repeat(32);
  const onchainFeedPacketId = "0x" + "89".repeat(32);
  const binaryIndexCtHash = "0x" + "55".repeat(32);
  const confidenceCtHash = "0x" + "66".repeat(32);
  const feedActionCtHash = "0x" + "57".repeat(32);
  const feedSignalCtHash = "0x" + "67".repeat(32);
  const clientNonce = "0x" + "77".repeat(32);
  const retryClientNonce = "0x" + "78".repeat(32);
  const feedClientNonce = "0x" + "79".repeat(32);
  const feedRetryClientNonce = "0x" + "7a".repeat(32);
  const ownedSealClientNonce = "0x" + "7b".repeat(32);
  const feedRetryTxHash = "0x" + "4b".repeat(32);

  const db = openDb({ path: dbPath });
  const agentId = randomUUID();
  agentsRepo.insert(db, {
    agent_id: agentId,
    display_slug: "fhenix-gateway-smoke",
    kind: "agent",
    display_name: "Fhenix Gateway Smoke",
    created_at: acceptedAt,
    wallet_address: wallet,
    chain_id: `eip155:${chainId}`,
  });
  const account = getOrCreateAccount(db, {
    privy_user_id: "did:privy:fhenix-gateway-smoke",
    session_id: "smoke-session",
    expires_at: "2026-05-14T18:00:00Z",
  }, {
    resolvedAt: new Date(acceptedAt),
  });
  linkAgentToAccount(db, account.account_id, agentId, {
    linkedAt: new Date(acceptedAt),
  });
  bindControllerWallet(db, {
    account_id: account.account_id,
    agent_id: agentId,
    wallet_address: wallet,
    chain_id: `eip155:${chainId}`,
    wallet_kind: "embedded",
    provider: "smoke",
    binding_message: "smoke controller wallet binding",
    binding_signature: "0x" + "11".repeat(65),
    createdAt: new Date(acceptedAt),
  });
  const runtimePolicy = {
    allowed_market_ids: [marketId],
    max_calls_per_hour: 5,
    max_calls_per_day: 10,
    feed_packets: true,
  };
  const runtimePolicyJson = canonicalize(runtimePolicy);
  const runtimePolicyHash = canonicalHash(runtimePolicy);
  const runtimeKey = mintRuntimeKey(db, {
    account_id: account.account_id,
    agent_id: agentId,
    label: "gateway smoke",
    policy_json: runtimePolicyJson,
    policy_hash: runtimePolicyHash,
    controller_wallet_address: wallet,
    controller_chain_id: `eip155:${chainId}`,
    authorization_nonce: "gateway-smoke-runtime-001",
    authorization_message: "gateway smoke runtime key authorization",
    authorization_signature: "0x" + "12".repeat(65),
    createdAt: new Date(acceptedAt),
  });
  marketsRepo.upsertExternalMarket(db, {
    market_id: marketId,
    asset_id: "polymarket:event",
    market_kind: "event_binary",
    horizon_seconds: 3600,
    primary_oracle_id: "polymarket-gamma-oracle",
    adapter_id: "polymarket-gamma",
    market_family: "prediction-market-binary",
    scoring_kind: "multinomial_brier",
    config_json: JSON.stringify({
      conditionId: marketId,
      slug: "fhenix-gateway-smoke-market",
      outcomes: ["Yes", "No"],
      endDate: revealOpenAt,
      gamma_url: "https://polymarket.com/event/fhenix-gateway-smoke-market",
    }),
    void_band: "0",
    status: "listed",
    created_at: acceptedAt,
  });
  marketsRepo.upsertExternalMarket(db, {
    market_id: disallowedMarketId,
    asset_id: "polymarket:event",
    market_kind: "event_binary",
    horizon_seconds: 3600,
    primary_oracle_id: "polymarket-gamma-oracle",
    adapter_id: "polymarket-gamma",
    market_family: "prediction-market-binary",
    scoring_kind: "multinomial_brier",
    config_json: JSON.stringify({
      conditionId: disallowedMarketId,
      slug: "fhenix-gateway-smoke-disallowed-market",
      outcomes: ["Yes", "No"],
      endDate: revealOpenAt,
      gamma_url: "https://polymarket.com/event/fhenix-gateway-smoke-disallowed-market",
    }),
    void_band: "0",
    status: "listed",
    created_at: acceptedAt,
  });
  const feedId = randomUUID();
  const feedIdHash = keccak256(toBytes(feedId));
  feedContractsRepo.insert(db, {
    feed_id: feedId,
    agent_id: agentId,
    name: "Gateway Feed Smoke",
    description: "sealed feed relay smoke",
    status: "listed",
    venue: "polymarket-gamma",
    resolution_classes: ["event_binary"],
    edge_classes: ["domain"],
    covered_market_ids: [marketId],
    delivery_cadence_seconds: 3600,
    trigger_rules: [],
    max_latency_seconds: null,
    subscriber_capacity: 10,
    commercial_template: "capacity_capped_subscription",
    reveal_policy: { kind: "fixed_delay", delay_seconds: 3600 },
    refund_rule: { kind: "credit", missed_delivery_grace: 0 },
    slash_rule: { kind: "reputation", missed_delivery_threshold: 2 },
    created_at: acceptedAt,
    updated_at: acceptedAt,
  });

  const eventTopic = keccak256(
    toBytes(
      "SealedCallSubmitted(bytes32,address,bytes32,uint64,uint64,bytes32,bytes32,bytes32)",
    ),
  );
	  const receipt = {
	    status: "success" as const,
	    blockNumber: 20n,
	    gasUsed: 123456n,
	    effectiveGasPrice: 1_000_000_000n,
	    logs: [
      {
        address: contract as Address,
        data: encodeAbiParameters(
          parseAbiParameters("uint64,uint64,bytes32,bytes32,bytes32"),
          [
            BigInt(Date.parse(acceptedAt) / 1000),
            BigInt(Date.parse(revealOpenAt) / 1000),
            binaryIndexCtHash as Hex,
            confidenceCtHash as Hex,
            clientNonce as Hex,
          ],
        ),
        topics: [
          eventTopic,
          onchainCallId as Hex,
          padHex(wallet as Hex, { size: 32 }),
          fhenixMarketIdForMurmurMarket(marketId) as Hex,
        ],
        logIndex: 4,
        blockNumber: 20n,
        transactionHash: txHash as Hex,
      },
    ],
  };
  const feedEventTopic = keccak256(
    toBytes(
      "FeedPacketSubmitted(bytes32,address,bytes32,bytes32,uint64,uint64,bytes32,bytes32,bytes32)",
    ),
  );
	  const feedReceipt = {
	    status: "success" as const,
	    blockNumber: 21n,
	    gasUsed: 234567n,
	    effectiveGasPrice: 2_000_000_000n,
	    logs: [
      {
        address: contract as Address,
        data: encodeAbiParameters(
          parseAbiParameters("bytes32,uint64,uint64,bytes32,bytes32,bytes32"),
          [
            fhenixMarketIdForMurmurMarket(marketId) as Hex,
            BigInt(Date.parse(acceptedAt) / 1000),
            BigInt(Date.parse(revealOpenAt) / 1000),
            feedActionCtHash as Hex,
            feedSignalCtHash as Hex,
            feedClientNonce as Hex,
          ],
        ),
        topics: [
          feedEventTopic,
          onchainFeedPacketId as Hex,
          padHex(wallet as Hex, { size: 32 }),
          feedIdHash as Hex,
        ],
        logIndex: 5,
        blockNumber: 21n,
        transactionHash: feedTxHash as Hex,
      },
    ],
  };
  let writes = 0;
  let lastFeedRevealAfterArg: bigint | null = null;
  const gatewayClient: FhenixGatewayClient = {
    getChainId: async () => chainId,
    getBlockNumber: async () => 22n,
    writeContract: async (args) => {
      writes++;
      if (args.functionName === "submitFeedPacketFor") {
        assert.equal(args.args[0].toLowerCase(), wallet.toLowerCase());
        assert.equal(args.args[1], feedIdHash);
        assert.equal(args.args[2], fhenixMarketIdForMurmurMarket(marketId));
        lastFeedRevealAfterArg = args.args[3];
        assert.ok(
          args.args[6] === feedClientNonce || args.args[6] === feedRetryClientNonce,
        );
        return (args.args[6] === feedRetryClientNonce ? feedRetryTxHash : feedTxHash) as Hex;
      }
      assert.equal(args.functionName, "submitSealedFor");
      assert.equal(args.args[0].toLowerCase(), wallet.toLowerCase());
      assert.equal(args.args[1], fhenixMarketIdForMurmurMarket(marketId));
      assert.ok(
        args.args[4] === clientNonce ||
          args.args[4] === retryClientNonce ||
          args.args[4] === ownedSealClientNonce,
      );
      return (args.args[4] === retryClientNonce ? retryTxHash : txHash) as Hex;
    },
    getTransactionReceipt: async ({ hash }) => hash === feedTxHash ? feedReceipt : receipt,
  };
  const verifier = new ViemFhenixEventVerifier({
    rpcUrl: "",
    chainId,
    contractAddress: contract,
    client: gatewayClient as never,
  });
  const fakeMurmurOwnedSealer: MurmurOwnedCofheSealer & {
    calls: Array<{ binary_index: number; confidence_bps: number }>;
  } = {
    calls: [],
    async sealVerdict(input) {
      this.calls.push(input);
      return {
        binary_index_input: {
          ct_hash: binaryIndexCtHash,
          security_zone: 0,
          utype: 2,
          signature: "0x1234",
        },
        confidence_input: {
          ct_hash: confidenceCtHash,
          security_zone: 0,
          utype: 3,
          signature: "0xabcd",
        },
      };
    },
  };
  const attemptIds: string[] = [];
  const claimTokens: string[] = [];
  const sealedCallIds = ["00000000-0000-4000-8000-000000000401"];
  const consumedSealedCallIds: string[] = [];
  const feedPacketIds = ["gateway-smoke-packet-1"];
  const consumedFeedPacketIds: string[] = [];
  const gateway = new FhenixGatewayBroadcaster({
    db,
    chainId,
    contractAddress: contract,
    relayerAddress: relayer,
    client: gatewayClient,
    confirmations: 2,
    murmurOwnedSealer: fakeMurmurOwnedSealer,
    newAttemptId: () => {
      const attemptId = `gateway-smoke-attempt-${attemptIds.length + 1}`;
      attemptIds.push(attemptId);
      return attemptId;
    },
    newClaimToken: () => {
      const token = `gateway-smoke-claim-${claimTokens.length + 1}`;
      claimTokens.push(token);
      return token;
    },
    newSealedCallId: () => {
      const id = sealedCallIds.shift();
      assert.ok(id, "Sealed Call ID Adapter consumed too many IDs");
      consumedSealedCallIds.push(id);
      return id;
    },
    newFeedPacketId: () => {
      const id = feedPacketIds.shift();
      assert.ok(id, "Feed Packet ID Adapter consumed too many IDs");
      consumedFeedPacketIds.push(id);
      return id;
    },
    now: () => new Date("2026-05-14T12:05:00Z"),
  });

  const app = express();
  app.use(
    createVerdictRouter({
      db,
      fhenixVerifier: verifier,
      fhenixGateway: gateway,
      adminToken: "gateway-admin-token",
      now: () => new Date("2026-05-14T12:05:00Z"),
    }),
  );
  server = await new Promise<Server>((resolve) => {
    const s = createServer(app);
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const body = {
    marketRef: {
      protocol: "polymarket-gamma",
      sourceId: marketId,
      configVersion: 1,
    },
    client_order_id: "gateway-smoke-order-001",
    client_nonce: clientNonce,
    privacy_mode: "sealed_fhenix",
    binary_index_input: {
      ct_hash: binaryIndexCtHash,
      security_zone: 0,
      utype: 2,
      signature: "0x1234",
    },
    confidence_input: {
      ct_hash: confidenceCtHash,
      security_zone: 0,
      utype: 3,
      signature: "0xabcd",
    },
    strategy_tag: "momentum",
  };
  const feedBody = {
    packet_kind: "verdict",
    market_id: marketId,
    client_order_id: "gateway-feed-smoke-order-001",
    client_nonce: feedClientNonce,
    privacy_mode: "sealed_fhenix",
    reveal_after: revealOpenAt,
    action_input: {
      ct_hash: feedActionCtHash,
      security_zone: 0,
      utype: 2,
      signature: "0x5678",
    },
    signal_input: {
      ct_hash: feedSignalCtHash,
      security_zone: 0,
      utype: 3,
      signature: "0xdcba",
    },
  };

  let attemptId = "";
  let feedAttemptId = "";

  await check("murmur-owned sealing request rejects provider-created ciphertext", () => {
    const parsed = MurmurOwnedSealedCallBodySchema.safeParse({
      marketRef: {
        protocol: "polymarket-gamma",
        sourceId: marketId,
        configVersion: 1,
      },
      client_order_id: "owned-seal-smoke-order-001",
      client_nonce: clientNonce,
      privacy_mode: "murmur_sealed_fhenix",
      verdict: {
        binary_index: 1,
        confidence_bps: 7400,
      },
      binary_index_input: body.binary_index_input,
    });
    assert.equal(parsed.success, false);
  });

  await check("runtime key gateway policy rejects disallowed market", async () => {
    const res = await fetch(`${baseUrl}/v2/gateway/calls`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Murmur-Runtime-Key": runtimeKey.secret,
      },
      body: JSON.stringify({
        ...body,
        marketRef: {
          ...body.marketRef,
          sourceId: disallowedMarketId,
        },
        client_order_id: "gateway-smoke-order-disallowed",
        client_nonce: "0x" + "7a".repeat(32),
      }),
    });
    assert.equal(res.status, 403);
    const payload = await res.json() as { code: string };
    assert.equal(payload.code, "agent_not_authorized");
    assert.equal(writes, 0);
    assert.deepEqual(attemptIds, []);
  });

  await check("public feed packet metadata route is retired", async () => {
    const res = await fetch(`${baseUrl}/v1/feeds/${feedId}/packets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 410);
    const payload = await res.json() as { code: string; replacement: string };
    assert.equal(payload.code, "endpoint_removed");
    assert.equal(payload.replacement, "/v2/gateway/feeds/:feed_id/packets");
  });

  await check("runtime key gateway submit broadcasts relayer transaction", async () => {
    const res = await fetch(`${baseUrl}/v2/gateway/calls`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Murmur-Runtime-Key": runtimeKey.secret,
      },
      body: JSON.stringify(body),
    });
    assert.equal(res.status, 202);
    const payload = await res.json() as {
      attempt_id: string;
      status: string;
      tx_hash: string;
      idempotent_hit: boolean;
    };
    attemptId = payload.attempt_id;
    assert.equal(payload.attempt_id, "gateway-smoke-attempt-1");
    assert.equal(payload.status, "submitted");
    assert.equal(payload.tx_hash, txHash);
    assert.equal(payload.idempotent_hit, false);
    assert.equal(writes, 1);
    assert.deepEqual(attemptIds, ["gateway-smoke-attempt-1"]);
    assert.deepEqual(claimTokens, ["gateway-smoke-claim-1"]);
  });

  await check("admin gateway snapshot exposes relayer queue state", async () => {
    const denied = await fetch(`${baseUrl}/v1/admin/fhenix/gateway`);
    assert.equal(denied.status, 403);
    const res = await fetch(`${baseUrl}/v1/admin/fhenix/gateway`, {
      headers: { "X-Admin-Token": "gateway-admin-token" },
    });
    assert.equal(res.status, 200);
    const payload = await res.json() as {
      configured: boolean;
	      status_counts: { submitted: number };
	      queues: { submitted_awaiting_confirmation: number };
	      telemetry: { avg_broadcast_latency_ms: number | null };
	      recent_attempts: Array<{
	        attempt_id: string;
	        binary_index_input_json?: string;
	        broadcast_latency_ms: number | null;
	      }>;
	    };
	    assert.equal(payload.configured, true);
	    assert.equal(payload.status_counts.submitted, 1);
	    assert.equal(payload.queues.submitted_awaiting_confirmation, 1);
	    assert.equal(payload.telemetry.avg_broadcast_latency_ms, 0);
	    assert.equal(payload.recent_attempts[0].attempt_id, attemptId);
	    assert.equal(payload.recent_attempts[0].binary_index_input_json, undefined);
	    assert.equal(payload.recent_attempts[0].broadcast_latency_ms, 0);
	  });

  await check("gateway tick confirms receipt and accepts sealed call", async () => {
    const result = await gateway.tick();
    assert.equal(result.confirmed, 1);
    assert.equal(result.accepted, 1);
	    const attempt = fhenixGatewayTxRepo.byId(db, attemptId);
	    assert.equal(attempt?.status, "accepted");
	    assert.equal(attempt?.call_id, "00000000-0000-4000-8000-000000000401");
	    assert.equal(attempt?.receipt_status, "success");
	    assert.equal(attempt?.receipt_block_number, 20);
	    assert.equal(attempt?.latest_block_number, 22);
	    assert.equal(attempt?.receipt_latency_ms, 0);
	    assert.equal(attempt?.latest_block_latency_ms, 0);
	    assert.equal(attempt?.confirmations_observed, 3);
	    assert.equal(attempt?.gas_used, "123456");
	    assert.equal(attempt?.effective_gas_price_wei, "1000000000");
	    const submission = submissionsRepo.loadResolverContext(db, attempt!.call_id!);
    assert.equal(submission?.agent_id, agentId);
    const sealed = fhenixSealedCallsRepo.byCallId(db, attempt!.call_id!);
    assert.equal(sealed?.submit_tx_hash, txHash);
    assert.equal(sealed?.submit_log_index, 4);
    assert.deepEqual(consumedSealedCallIds, [
      "00000000-0000-4000-8000-000000000401",
    ]);
  });

  await check("gateway submit is idempotent after acceptance", async () => {
    const res = await fetch(`${baseUrl}/v2/gateway/calls`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Murmur-Runtime-Key": runtimeKey.secret,
      },
      body: JSON.stringify(body),
    });
    assert.equal(res.status, 200);
    const payload = await res.json() as {
      attempt_id: string;
      status: string;
      idempotent_hit: boolean;
    };
    assert.equal(payload.attempt_id, attemptId);
    assert.equal(payload.status, "accepted");
    assert.equal(payload.idempotent_hit, true);
    assert.equal(writes, 1);
    assert.deepEqual(consumedSealedCallIds, [
      "00000000-0000-4000-8000-000000000401",
    ]);
  });

  await check("runtime key gateway feed packet submit broadcasts relayer transaction", async () => {
    const res = await fetch(`${baseUrl}/v2/gateway/feeds/${feedId}/packets`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Murmur-Runtime-Key": runtimeKey.secret,
      },
      body: JSON.stringify(feedBody),
    });
    assert.equal(res.status, 202);
    const payload = await res.json() as {
      attempt_id: string;
      status: string;
      tx_hash: string;
      sequence: number;
    };
    assert.equal(payload.attempt_id, "gateway-smoke-attempt-2");
    feedAttemptId = payload.attempt_id;
    assert.equal(payload.status, "submitted");
    assert.equal(payload.tx_hash, feedTxHash);
    assert.equal(payload.sequence, 1);
    assert.deepEqual(attemptIds, [
      "gateway-smoke-attempt-1",
      "gateway-smoke-attempt-2",
    ]);
    assert.deepEqual(claimTokens, [
      "gateway-smoke-claim-1",
      "gateway-smoke-claim-2",
    ]);
    const attempt = fhenixGatewayFeedPacketTxRepo.byId(db, payload.attempt_id);
    assert.equal(attempt?.feed_id_hash, feedIdHash);
    assert.equal(attempt?.broadcast_latency_ms, 0);
    // The contract's uint64 revealAfter arg must be the stored
    // reveal_after epoch — pins the feed lane's contractWrite mapping.
    assert.ok(attempt?.reveal_after, "feed attempt must persist reveal_after");
    assert.equal(
      lastFeedRevealAfterArg,
      BigInt(Math.floor(Date.parse(attempt!.reveal_after) / 1000)),
    );
    assert.deepEqual(consumedFeedPacketIds, []);
  });

  await check("gateway tick confirms and records feed packet SLA", async () => {
    const result = await gateway.tick();
    assert.equal(result.confirmed, 1);
    assert.equal(result.accepted, 1);
    const packet = feedPacketsRepo.byFhenixEvent(db, {
      chain_id: chainId,
      contract_address: contract,
      onchain_packet_id: onchainFeedPacketId,
    });
    assert.equal(packet?.packet_id, "gateway-smoke-packet-1");
    assert.equal(packet?.feed_id, feedId);
    assert.equal(packet?.sequence, 1);
    assert.equal(packet?.sla_status, "on_time");
    assert.equal(packet?.packet_ct_hash, feedActionCtHash);
    assert.equal(packet?.confidence_ct_hash, feedSignalCtHash);
    assert.deepEqual(consumedFeedPacketIds, ["gateway-smoke-packet-1"]);
    const attempt = fhenixGatewayFeedPacketTxRepo.listRecent(db, { limit: 1 })[0];
    assert.equal(attempt?.receipt_status, "success");
    assert.equal(attempt?.receipt_latency_ms, 0);
    assert.equal(attempt?.latest_block_latency_ms, 0);
    assert.equal(attempt?.gas_used, "234567");
  });

  await check("gateway feed packet acceptance is idempotent by event", async () => {
    fhenixGatewayFeedPacketTxRepo.markConfirmed(db, {
      attempt_id: feedAttemptId,
      submit_log_index: 5,
      submit_block_number: 21,
      onchain_packet_id: onchainFeedPacketId,
      action_ct_hash: feedActionCtHash,
      signal_ct_hash: feedSignalCtHash,
      accepted_at: acceptedAt,
      updated_at: "2026-05-14T12:06:00Z",
    });
    const result = await gateway.tick();
    assert.equal(result.confirmed, 0);
    assert.equal(result.accepted, 1);
    assert.deepEqual(consumedFeedPacketIds, ["gateway-smoke-packet-1"]);
    const attempt = fhenixGatewayFeedPacketTxRepo.byId(db, feedAttemptId);
    assert.equal(attempt?.status, "accepted");
    assert.equal(attempt?.packet_id, "gateway-smoke-packet-1");
  });

  await check("admin gateway retry submits only retryable attempts", async () => {
    const retryAttemptId = randomUUID();
    fhenixGatewayTxRepo.insert(db, {
      attempt_id: retryAttemptId,
      status: "failed_retryable",
      runtime_key_id: runtimeKey.runtime_key_id,
      runtime_key_policy_hash: runtimePolicyHash,
      runtime_key_policy_json: runtimePolicyJson,
      account_id: account.account_id,
      agent_id: agentId,
      chain_id: chainId,
      contract_address: contract,
      relayer_address: relayer,
      agent_wallet_address: wallet,
      market_id: marketId,
      market_id_hash: fhenixMarketIdForMurmurMarket(marketId),
      market_ref_protocol: "polymarket-gamma",
      market_config_version: 1,
      client_order_id: "gateway-smoke-order-retry",
      client_nonce: retryClientNonce,
      submitted_at: acceptedAt,
      rationale: null,
      strategy_tag: "momentum",
      binary_index_input_json: JSON.stringify(body.binary_index_input),
      confidence_input_json: JSON.stringify(body.confidence_input),
      next_attempt_at: "2026-05-14T13:05:00Z",
      created_at: acceptedAt,
      updated_at: acceptedAt,
    });
    const res = await fetch(`${baseUrl}/v1/admin/fhenix/gateway/attempts/${retryAttemptId}/retry`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Admin-Token": "gateway-admin-token",
      },
      body: "{}",
    });
    assert.equal(res.status, 202);
    const payload = await res.json() as { status: string; tx_hash: string };
    assert.equal(payload.status, "submitted");
    assert.equal(payload.tx_hash, retryTxHash);
    assert.equal(writes, 3);
    assert.deepEqual(attemptIds, [
      "gateway-smoke-attempt-1",
      "gateway-smoke-attempt-2",
    ]);
    assert.deepEqual(claimTokens, [
      "gateway-smoke-claim-1",
      "gateway-smoke-claim-2",
      "gateway-smoke-claim-3",
    ]);

    const acceptedRetry = await fetch(`${baseUrl}/v1/admin/fhenix/gateway/attempts/${attemptId}/retry`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Admin-Token": "gateway-admin-token",
      },
      body: "{}",
    });
    assert.equal(acceptedRetry.status, 409);
  });

  await check("admin gateway retry covers feed lane and audits both payload shapes", async () => {
    const feedRetryAttemptId = randomUUID();
    fhenixGatewayFeedPacketTxRepo.insert(db, {
      attempt_id: feedRetryAttemptId,
      status: "failed_retryable",
      runtime_key_id: runtimeKey.runtime_key_id,
      runtime_key_policy_hash: runtimePolicyHash,
      runtime_key_policy_json: runtimePolicyJson,
      account_id: account.account_id,
      agent_id: agentId,
      chain_id: chainId,
      contract_address: contract,
      relayer_address: relayer,
      agent_wallet_address: wallet,
      feed_id: feedId,
      feed_id_hash: feedIdHash,
      market_id: marketId,
      market_id_hash: fhenixMarketIdForMurmurMarket(marketId),
      packet_kind: "verdict",
      sequence: 2,
      payload_schema: "murmur.feed-packet.v1",
      client_order_id: "gateway-feed-smoke-order-retry",
      client_nonce: feedRetryClientNonce,
      submitted_at: acceptedAt,
      delivery_deadline_at: null,
      reveal_after: revealOpenAt,
      action_input_json: JSON.stringify(feedBody.action_input),
      signal_input_json: JSON.stringify(feedBody.signal_input),
      next_attempt_at: "2026-05-14T13:05:00Z",
      created_at: acceptedAt,
      updated_at: acceptedAt,
    });
    const res = await fetch(`${baseUrl}/v1/admin/fhenix/gateway/attempts/${feedRetryAttemptId}/retry`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Admin-Token": "gateway-admin-token",
      },
      body: "{}",
    });
    assert.equal(res.status, 202);
    const payload = await res.json() as { status: string; tx_hash: string; sequence: number };
    assert.equal(payload.status, "submitted");
    assert.equal(payload.tx_hash, feedRetryTxHash);
    assert.equal(payload.sequence, 2);

    // Both lanes' admin_fhenix_gateway_retry audit payloads must keep their
    // historical shapes (payload_json key order is the persisted contract):
    // sealed carries market_id, feed carries feed_id_hash. The audit row
    // must also attach agent_id so the retry shows up on the agent's own
    // security timeline.
    const auditRows = db.prepare(
      `SELECT agent_id, payload_json FROM agent_security_events
       WHERE kind = 'admin_fhenix_gateway_retry'
       ORDER BY created_at`,
    ).all() as { agent_id: string | null; payload_json: string }[];
    const audits = auditRows.map((row) => ({
      agent_id: row.agent_id,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
      keys: Object.keys(JSON.parse(row.payload_json) as Record<string, unknown>),
    }));
    const sealedAudit = audits.find((a) => a.payload.attempt_type === "sealed_call");
    assert.ok(sealedAudit, "sealed retry must emit an audit event");
    assert.equal(sealedAudit.agent_id, agentId);
    assert.deepEqual(sealedAudit.keys, [
      "attempt_id",
      "attempt_type",
      "previous_status",
      "previous_attempt_count",
      "previous_next_attempt_at",
      "previous_last_error",
      "chain_id",
      "contract_address",
      "agent_wallet_address",
      "client_nonce",
      "market_id",
    ]);
    assert.equal(sealedAudit.payload.market_id, marketId);
    assert.equal(sealedAudit.payload.agent_wallet_address, wallet);
    assert.equal(sealedAudit.payload.client_nonce, retryClientNonce);
    const feedAudit = audits.find((a) => a.payload.attempt_type === "feed_packet");
    assert.ok(feedAudit, "feed retry must emit an audit event");
    assert.equal(feedAudit.agent_id, agentId);
    assert.deepEqual(feedAudit.keys, [
      "attempt_id",
      "attempt_type",
      "previous_status",
      "previous_attempt_count",
      "previous_next_attempt_at",
      "previous_last_error",
      "chain_id",
      "contract_address",
      "agent_wallet_address",
      "feed_id_hash",
      "client_nonce",
    ]);
    assert.equal(feedAudit.payload.feed_id_hash, feedIdHash);
    assert.equal(feedAudit.payload.agent_wallet_address, wallet);
    assert.equal(feedAudit.payload.client_nonce, feedRetryClientNonce);
    assert.equal(feedAudit.payload.previous_status, "failed_retryable");
  });

  await check("murmur-owned sealing route encrypts before gateway relay", async () => {
    const res = await fetch(`${baseUrl}/v2/gateway/calls/seal`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Murmur-Runtime-Key": runtimeKey.secret,
      },
      body: JSON.stringify({
        marketRef: {
          protocol: "polymarket-gamma",
          sourceId: marketId,
          configVersion: 1,
        },
        client_order_id: "owned-seal-smoke-order-001",
        client_nonce: ownedSealClientNonce,
        privacy_mode: "murmur_sealed_fhenix",
        verdict: {
          binary_index: 1,
          confidence_bps: 7400,
        },
        public_strategy_tag: "momentum",
      }),
    });
    assert.equal(res.status, 202);
    assert.deepEqual(fakeMurmurOwnedSealer.calls, [
      { binary_index: 1, confidence_bps: 7400 },
    ]);
    const payload = await res.json() as { status: string; tx_hash: string };
    assert.equal(payload.status, "submitted");
    assert.equal(payload.tx_hash, txHash);
  });

  db.close();
} finally {
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server!.close((err) => (err ? reject(err) : resolve()));
    });
  }
  rmSync(tmp, { recursive: true, force: true });
}

if (failures > 0) {
  process.stdout.write(`fhenix gateway smoke failed: ${failures} failure(s)\n`);
  process.exit(1);
}

process.stdout.write("fhenix gateway smoke ok\n");
