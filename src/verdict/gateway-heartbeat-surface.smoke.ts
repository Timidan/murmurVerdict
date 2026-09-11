import { strict as assert } from "node:assert";
import { createHash, generateKeyPairSync, randomUUID, sign as edSign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalHash, canonicalize } from "../receipts/canonical.js";
import { listAccountRuntimeKeysResponse } from "./account-runtime-key-surface.js";
import { bindControllerWallet, getOrCreateAccount, linkAgentToAccount, mintRuntimeKey } from "./auth/accounts.js";
import { POP_HEADER_NONCE, POP_HEADER_SIGNATURE, POP_HEADER_TIMESTAMP } from "./auth/runtime-key-pop.js";
import { openDb } from "./db.js";
import { agentsRepo } from "./repos/agents-repo.js";
import { gatewayHeartbeatResponse } from "./gateway-heartbeat-surface.js";

process.stdout.write("murmur gateway heartbeat surface smoke\n");

const tmp = mkdtempSync(join(tmpdir(), "murmur-heartbeat-"));
let clock = new Date("2026-09-04T12:00:00Z");
const now = () => clock;

try {
  const db = openDb({ path: join(tmp, "test.db") });
  const agentId = randomUUID();
  const wallet = `0x${"ab".repeat(20)}`;
  agentsRepo.insert(db, {
    agent_id: agentId,
    display_slug: "heartbeat-smoke",
    kind: "agent",
    display_name: "Heartbeat Smoke",
    created_at: "2026-09-04T11:00:00Z",
  });
  const account = getOrCreateAccount(db, {
    privy_user_id: "did:privy:heartbeat-smoke",
    session_id: "heartbeat-smoke-session",
    expires_at: "2026-09-04T18:00:00Z",
  }, { resolvedAt: new Date("2026-09-04T11:00:00Z") });
  linkAgentToAccount(db, account.account_id, agentId, { linkedAt: new Date("2026-09-04T11:00:00Z") });
  bindControllerWallet(db, {
    account_id: account.account_id,
    agent_id: agentId,
    wallet_address: wallet,
    chain_id: "eip155:84532",
    wallet_kind: "embedded",
    provider: "smoke",
    binding_message: "heartbeat smoke binding",
    binding_signature: `0x${"11".repeat(65)}`,
    createdAt: new Date("2026-09-04T11:00:00Z"),
  });
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const signingPubkey = spki.subarray(-32).toString("hex");
  const policy = { signing_pubkey: signingPubkey };
  const key = mintRuntimeKey(db, {
    account_id: account.account_id,
    agent_id: agentId,
    policy_json: canonicalize(policy),
    policy_hash: canonicalHash(policy),
    controller_wallet_address: wallet,
    controller_chain_id: "eip155:84532",
    authorization_nonce: "heartbeat-smoke-key",
    authorization_message: "heartbeat smoke key authorization",
    authorization_signature: `0x${"12".repeat(65)}`,
    createdAt: clock,
  });

  const request = (agent_slug: string) => {
    const body = JSON.stringify({ agent_slug });
    const timestamp = Math.floor(clock.getTime() / 1000);
    const nonce = randomUUID().replace(/-/g, "");
    const bodyHash = createHash("sha256").update(body).digest("hex");
    const signingString = [
      "murmur-rk-v2", "murmur-gateway", key.runtime_key_id, String(timestamp), nonce,
      "POST", "/v2/gateway/heartbeat", bodyHash,
    ].join("\n");
    const signature = edSign(null, Buffer.from(signingString), privateKey).toString("hex");
    const headers = new Map(Object.entries({
      "X-Murmur-Runtime-Key": key.secret,
      [POP_HEADER_TIMESTAMP]: String(timestamp),
      [POP_HEADER_NONCE]: nonce,
      [POP_HEADER_SIGNATURE]: signature,
    }).map(([name, value]) => [name.toLowerCase(), value]));
    return {
      bodyJson: JSON.parse(body),
      req: {
        header: (name: string) => headers.get(name.toLowerCase()),
        method: "POST",
        originalUrl: "/v2/gateway/heartbeat",
        murmurRawBodySha256: bodyHash,
      },
    };
  };

  const acceptedRequest = request("heartbeat-smoke");
  const accepted = await gatewayHeartbeatResponse({ ...acceptedRequest, deps: { db, now } });
  assert.deepEqual(accepted, {
    status: 200,
    body: {
      pong: true,
      nonce: acceptedRequest.req.header(POP_HEADER_NONCE)!,
      agent_slug: "heartbeat-smoke",
      runtime_key_id: key.runtime_key_id,
      server_time: "2026-09-04T12:00:00Z",
      heartbeat_interval_seconds: 60,
      stale_after_seconds: 180,
    },
  });
  let listing = listAccountRuntimeKeysResponse({ db, accountId: account.account_id, slug: "heartbeat-smoke", operationInstant: clock });
  assert.equal(listing.body.keys[0]?.connection.status, "connected");
  assert.equal(listing.body.connection.status, "connected");

  await assert.rejects(
    () => gatewayHeartbeatResponse({ ...request("other-agent"), deps: { db, now } }),
    (error) => (error as { httpStatus?: number }).httpStatus === 403,
    "a signed key may not claim another agent slug",
  );
  await assert.rejects(
    () => gatewayHeartbeatResponse({
      ...request("heartbeat-smoke"),
      deps: {
        db,
        now,
        dispatchAuth: async () => ({
          tier: "casual",
          auth_mode: "runtime_key",
          agent_id: agentId,
          account_id: account.account_id,
          runtime_key: {
            runtime_key_id: key.runtime_key_id,
            account_id: account.account_id,
            agent_id: agentId,
            runtime_key_prefix: key.runtime_key_prefix,
            policy_json: canonicalize({}),
            policy_hash: canonicalHash({}),
            controller_wallet_address: wallet,
            controller_chain_id: "eip155:84532",
            expires_at: null,
            signature_verified: false,
          },
        }),
      },
    }),
    (error) => (error as { httpStatus?: number }).httpStatus === 401,
    "bearer-only Runtime Keys cannot heartbeat",
  );
  clock = new Date("2026-09-04T12:03:01Z");
  listing = listAccountRuntimeKeysResponse({ db, accountId: account.account_id, slug: "heartbeat-smoke", operationInstant: clock });
  assert.equal(listing.body.keys[0]?.connection.status, "stale");
  db.prepare("UPDATE agent_runtime_keys SET revoked_at=? WHERE runtime_key_id=?")
    .run(clock.toISOString(), key.runtime_key_id);
  listing = listAccountRuntimeKeysResponse({ db, accountId: account.account_id, slug: "heartbeat-smoke", operationInstant: clock });
  assert.equal(listing.body.keys[0]?.connection.status, "authorization_required");
  assert.equal(listing.body.keys[0]?.connection.reason, "runtime_key_revoked");
  db.close();
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

process.stdout.write("gateway heartbeat surface smoke ok\n");
