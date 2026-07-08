import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import express from "express";
import { privateKeyToAccount } from "viem/accounts";

import { canonicalHash, canonicalize } from "../receipts/canonical.js";
import { createVerdictRouter } from "./api.js";
import {
  agentsRepo,
  openDb,
} from "./db.js";
import {
  bindControllerWallet,
  controllerWalletAttestationStatus,
  controllerWalletReattestationHealth,
  getControllerWalletForAgent,
  getOrCreateAccount,
  isControllerWalletAttestationCurrent,
  linkAgentToAccount,
  listRuntimeKeysForAccountAgent,
  mintRuntimeKey,
  recordControllerWalletReattestation,
  revokeRuntimeKey,
  verifyRuntimeKey,
} from "./auth/accounts.js";
import {
  buildControllerWalletBindingMessage,
  buildControllerWalletReattestationMessage,
  buildRuntimeKeyAuthorizationMessage,
  verifySignedMessageAddress,
} from "./controller-wallet.js";

const tmp = mkdtempSync(join(tmpdir(), "murmur-controller-wallet-smoke-"));
const dbPath = join(tmp, "test.db");

try {
  process.stdout.write("murmur controller wallet smoke\n");
  const db = openDb({ path: dbPath });
  const owner = privateKeyToAccount(`0x${"11".repeat(32)}`);
  const wallet = owner.address.toLowerCase();
  const now = "2026-05-15T09:30:00Z";
  const agentId = randomUUID();

  agentsRepo.insert(db, {
    agent_id: agentId,
    display_slug: "controller-smoke",
    kind: "agent",
    display_name: "Controller Smoke",
    created_at: now,
  });
  const account = getOrCreateAccount(db, {
    privy_user_id: "did:privy:controller-smoke",
    session_id: "controller-smoke-session",
    expires_at: "2026-05-15T12:00:00Z",
  }, {
    resolvedAt: new Date(now),
  });
  linkAgentToAccount(db, account.account_id, agentId, {
    linkedAt: new Date(now),
  });

  const bindingMessage = buildControllerWalletBindingMessage({
    agentSlug: "controller-smoke",
    walletAddress: wallet,
    chainId: "eip155:84532",
    walletKind: "embedded",
    provider: "privy",
    issuedAt: now,
  });
  const bindingSignature = await owner.signMessage({ message: bindingMessage });
  assert.equal(
    await verifySignedMessageAddress(wallet, bindingMessage, bindingSignature),
    true,
  );

  const bound = bindControllerWallet(db, {
    account_id: account.account_id,
    agent_id: agentId,
    wallet_address: wallet,
    chain_id: "eip155:84532",
    wallet_kind: "embedded",
    provider: "privy",
    binding_message: bindingMessage,
    binding_signature: bindingSignature,
    createdAt: new Date(now),
  });
  assert.equal(bound.idempotent_hit, false);
  assert.equal(getControllerWalletForAgent(db, agentId)?.wallet_address, wallet);
  assert.equal(agentsRepo.byId(db, agentId)?.wallet_address, wallet);
  assert.equal(
    controllerWalletAttestationStatus(
      { ...bound, reattestation_due_at: "not-a-date" },
      { checkedAt: new Date("2026-05-20T09:30:00Z") },
    ).reattestation_overdue,
    true,
  );
  const invalidBaseStatus = controllerWalletAttestationStatus(
    {
      ...bound,
      created_at: "not-a-date",
      last_attested_at: null,
      reattestation_due_at: null,
    },
    { checkedAt: new Date("2026-05-20T09:30:00Z") },
  );
  assert.equal(invalidBaseStatus.reattestation_due_at, "not-a-date");
  assert.equal(invalidBaseStatus.reattestation_overdue, true);
  const derivedCurrentHealth = controllerWalletReattestationHealth(
    { ...bound, reattestation_due_at: null },
    {
      checkedAt: new Date("2026-05-20T09:30:00Z"),
      dueSoonAt: "2026-05-21T09:30:00Z",
    },
  );
  assert.equal(derivedCurrentHealth.status, "current");
  assert.equal(derivedCurrentHealth.reattestation_due_soon, false);
  const dueSoonHealth = controllerWalletReattestationHealth(bound, {
    checkedAt: new Date("2026-05-20T09:30:00Z"),
    dueSoonAt: "2026-05-30T09:30:00Z",
  });
  assert.equal(dueSoonHealth.status, "due_soon");
  assert.equal(dueSoonHealth.reattestation_due_soon, true);
  assert.equal(
    controllerWalletReattestationHealth(
      { ...bound, reattestation_due_at: "not-a-date" },
      { checkedAt: new Date("2026-05-20T09:30:00Z") },
    ).status,
    "overdue",
  );

  const idempotent = bindControllerWallet(db, {
    account_id: account.account_id,
    agent_id: agentId,
    wallet_address: wallet,
    chain_id: "eip155:84532",
    wallet_kind: "embedded",
    provider: "privy",
    binding_message: bindingMessage,
    binding_signature: bindingSignature,
    createdAt: new Date(now),
  });
  assert.equal(idempotent.idempotent_hit, true);

  const policy = {
    allowed_market_ids: [`0x${"ab".repeat(32)}`],
    max_calls_per_hour: 12,
    feed_packets: true,
  };
  const policyHash = canonicalHash(policy);
  const authorizationNonce = "controller_smoke_nonce_001";
  const runtimeMessage = buildRuntimeKeyAuthorizationMessage({
    agentSlug: "controller-smoke",
    controllerWalletAddress: wallet,
    controllerChainId: "eip155:84532",
    policyHash,
    authorizationNonce,
    issuedAt: now,
    expiresAt: "2026-06-16T09:30:00Z",
  });
  const runtimeSignature = await owner.signMessage({ message: runtimeMessage });
  assert.equal(
    await verifySignedMessageAddress(wallet, runtimeMessage, runtimeSignature),
    true,
  );

  const minted = mintRuntimeKey(db, {
    account_id: account.account_id,
    agent_id: agentId,
    label: "smoke key",
    policy_json: canonicalize(policy),
    policy_hash: policyHash,
    controller_wallet_address: wallet,
    controller_chain_id: "eip155:84532",
    authorization_nonce: authorizationNonce,
    authorization_message: runtimeMessage,
    authorization_signature: runtimeSignature,
    expires_at: "2026-06-16T09:30:00Z",
    createdAt: new Date(now),
  });
  assert.match(minted.secret, /^mrt_[0-9a-f]{64}$/);
  assert.equal(minted.runtime_key_prefix, minted.secret.slice(0, 12));

  const keys = listRuntimeKeysForAccountAgent(
    db,
    account.account_id,
    agentId,
    true,
  );
  assert.equal(keys.length, 1);
  assert.equal(keys[0]?.runtime_key_prefix, minted.runtime_key_prefix);
  assert.equal(keys[0]?.policy_hash, policyHash);
  assert.equal(
    verifyRuntimeKey(db, {
      secret: minted.secret,
      verifiedAt: new Date("2026-05-20T09:30:00Z"),
    })?.runtime_key_id,
    minted.runtime_key_id,
  );
  assert.equal(
    verifyRuntimeKey(db, {
      secret: minted.secret,
      verifiedAt: new Date("2026-06-01T09:30:00Z"),
    }),
    null,
  );

  const attestationIssuedAt = "2026-05-28T09:30:00Z";
  const attestationNonce = "controller_smoke_reattest_001";
  const reattestationMessage = buildControllerWalletReattestationMessage({
    agentSlug: "controller-smoke",
    controllerWalletAddress: wallet,
    controllerChainId: "eip155:84532",
    attestationNonce,
    issuedAt: attestationIssuedAt,
  });
  const reattestationSignature = await owner.signMessage({
    message: reattestationMessage,
  });
  assert.equal(
    await verifySignedMessageAddress(
      wallet,
      reattestationMessage,
      reattestationSignature,
    ),
    true,
  );
  const attestation = recordControllerWalletReattestation(db, {
    account_id: account.account_id,
    agent_id: agentId,
    wallet_address: wallet,
    chain_id: "eip155:84532",
    attestation_nonce: attestationNonce,
    attestation_message: reattestationMessage,
    attestation_signature: reattestationSignature,
    attestedAt: new Date(attestationIssuedAt),
    newReattestationId: () => "controller-smoke-reattestation-id-1",
  });
  assert.equal(attestation.attestation_id, "controller-smoke-reattestation-id-1");
  assert.equal(attestation.next_due_at, "2026-06-11T09:30:00Z");
  const refreshedController = getControllerWalletForAgent(db, agentId);
  assert(refreshedController);
  assert.equal(
    controllerWalletAttestationStatus(refreshedController, {
      checkedAt: new Date("2026-06-01T09:30:00Z"),
    }).reattestation_overdue,
    false,
  );
  assert.equal(
    verifyRuntimeKey(db, {
      secret: minted.secret,
      verifiedAt: new Date("2026-06-01T09:30:00Z"),
    })?.runtime_key_id,
    minted.runtime_key_id,
  );

  const app = express();
  app.use(createVerdictRouter({
    db,
    adminToken: "admin-token",
    now: () => new Date("2026-06-12T09:30:00Z"),
  }));
  const { server, port } = await listen(app);
  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    const denied = await fetch(`${baseUrl}/v1/admin/identity/controllers`);
    assert.equal(denied.status, 403);

    const res = await fetch(`${baseUrl}/v1/admin/identity/controllers`, {
      headers: { "X-Admin-Token": "admin-token" },
    });
    assert.equal(res.status, 200);
    const body = await res.json() as {
      counts?: {
        controller_wallets?: number;
        overdue?: number;
        active_runtime_keys?: number;
      };
      needs_attention?: Array<{
        agent_slug?: string;
        status?: string;
      }>;
    };
    assert.equal(body.counts?.controller_wallets, 1);
    assert.equal(body.counts?.overdue, 1);
    assert.equal(body.counts?.active_runtime_keys, 1);
    assert.equal(body.needs_attention?.[0]?.agent_slug, "controller-smoke");
    assert.equal(body.needs_attention?.[0]?.status, "overdue");
  } finally {
    await closeServer(server);
  }

  assert.equal(
    revokeRuntimeKey(db, {
      account_id: account.account_id,
      runtime_key_id: minted.runtime_key_id,
      reason: "smoke revoke",
      revokedAt: new Date("2026-06-01T09:30:00Z"),
    }),
    true,
  );
  assert.equal(
    listRuntimeKeysForAccountAgent(db, account.account_id, agentId, false).length,
    0,
  );
  assert.equal(
    listRuntimeKeysForAccountAgent(db, account.account_id, agentId, true)[0]
      ?.revoke_reason,
    "smoke revoke",
  );
  db.prepare(
    "UPDATE agent_controller_wallets SET reattestation_due_at = ? WHERE agent_id = ?",
  ).run("not-a-date", agentId);
  assert.equal(
    isControllerWalletAttestationCurrent(db, {
      agent_id: agentId,
      checkedAt: new Date("2026-06-01T09:30:00Z"),
    }),
    false,
  );

  db.close();
  process.stdout.write("  ok controller wallet binding + runtime key lifecycle\n");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

function listen(app: express.Express): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (typeof addr !== "object" || addr === null) {
        reject(new Error("server did not bind tcp address"));
        return;
      }
      resolve({ server, port: addr.port });
    });
    server.once("error", reject);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}
