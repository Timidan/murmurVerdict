import assert from "node:assert/strict";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../verdict/db-bootstrap.js";
import { VerdictEventBus } from "../verdict/events.js";
import type { LiveCanaryProvider } from "../integrations/live-canaries.js";
import type { PrivyAuthVerifier } from "../verdict/auth/privy.js";
import { loadDaemonRuntimeConfig } from "./daemon-config.js";
import { createDaemonHttpSurface } from "./daemon-http.js";

const priorAdminToken = process.env.VERDICT_ADMIN_TOKEN;
const priorPublicUrl = process.env.MURMUR_PUBLIC_URL;
const priorFhenixRevealGraceSec = process.env.FHENIX_REVEAL_GRACE_SEC;
const priorOperatorAlertWebhookUrl = process.env.MURMUR_OPERATOR_ALERT_WEBHOOK_URL;
const priorOperatorAlertSecret = process.env.MURMUR_OPERATOR_ALERT_SECRET;
const priorPrivyAppId = process.env.PRIVY_APP_ID;
const priorPrivyAppSecret = process.env.PRIVY_APP_SECRET;
const priorPrivyVerificationKey = process.env.PRIVY_VERIFICATION_KEY;
process.env.VERDICT_ADMIN_TOKEN = "ambient-admin-token-0123456789abcdef";
process.env.MURMUR_PUBLIC_URL = "https://ambient-public.invalid";
process.env.FHENIX_REVEAL_GRACE_SEC = "999";
process.env.MURMUR_OPERATOR_ALERT_WEBHOOK_URL = "https://ambient-alert.invalid";
process.env.MURMUR_OPERATOR_ALERT_SECRET = "ambient-alert-secret";
process.env.PRIVY_APP_ID = "ambient-privy-app";
process.env.PRIVY_APP_SECRET = "ambient-privy-secret";
process.env.PRIVY_VERIFICATION_KEY = "ambient-invalid-pem";

const tmp = mkdtempSync(join(tmpdir(), "murmur-daemon-http-smoke-"));
const db = openDb({ path: join(tmp, "verdict.db") });
let server: Server | null = null;
let dbClosed = false;
const errors: unknown[][] = [];
const logger = {
  error: (...args: unknown[]) => errors.push(args),
};

const liveCanaries: LiveCanaryProvider = {
  hasEnabledChecks: () => false,
  snapshot: () => ({
    schema_version: 1,
    served_at: "2026-05-15T12:00:00Z",
    ok: true,
    checks: [],
  }),
  runNow: async () => ({
    schema_version: 1,
    served_at: "2026-05-15T12:00:00Z",
    ok: true,
    checks: [],
  }),
};

const privyAuth: PrivyAuthVerifier = {
  isEnabled: () => true,
  hydrateProfile: async () => ({}),
  verify: async (token) =>
    token === "configured-privy-token"
      ? {
          privy_user_id: "did:privy:configured",
          session_id: "session-configured",
          expires_at: "2026-05-15T13:00:00Z",
        }
      : null,
};
const accountIds: string[] = [];
const newAccountId = () => {
  const id = `daemon-http-account-id-${accountIds.length + 1}`;
  accountIds.push(id);
  return id;
};
const usageEventIds: string[] = [];
const newUsageEventId = () => {
  const id = `00000000-0000-4000-8000-${
    String(usageEventIds.length + 1).padStart(12, "0")
  }`;
  usageEventIds.push(id);
  return id;
};
const feedIds: string[] = [];
const newFeedId = () => {
  const id = `daemon-http-feed-id-${feedIds.length + 1}`;
  feedIds.push(id);
  return id;
};
const agentSecurityEventIds: string[] = [];
const newAgentSecurityEventId = () => {
  const id = `00000000-0000-4000-8000-${
    String(agentSecurityEventIds.length + 1).padStart(12, "0")
  }`;
  agentSecurityEventIds.push(id);
  return id;
};
const marketRegistrationConditionId = `0x${"56".repeat(32)}`;
const marketRegistrationGammaCalls: string[] = [];
const marketRegistrationGammaLookup = {
  fetchMarketByConditionId: async (conditionId: string) => {
    marketRegistrationGammaCalls.push(conditionId);
    return {
      snapshot: {
        conditionId,
        slug: "daemon-http-polymarket",
        outcomes: JSON.stringify(["Yes", "No"]),
        outcomePrices: JSON.stringify(["0.4", "0.6"]),
        umaResolutionStatus: "active",
        umaResolutionStatuses: JSON.stringify(["active"]),
        closed: false,
        active: true,
        archived: false,
        endDate: "2026-05-15T13:00:00Z",
      },
      error: null,
    };
  },
};

try {
  const config = loadDaemonRuntimeConfig({
    VERDICT_ADMIN_TOKEN: "configured-admin-token-0123456789abcdef",
    OPENSERV_API_KEY: "configured-openserv-api-key",
    MURMUR_PUBLIC_URL: "https://configured-public.example",
    MURMUR_OPERATOR_ALERT_WEBHOOK_URL: "https://configured-alert.example",
    MURMUR_OPERATOR_ALERT_SECRET: "configured-alert-secret",
    FHENIX_REVEAL_GRACE_SEC: "123",
    PORT: "0",
  });
  const app = createDaemonHttpSurface({
    db,
    config,
    logger,
    events: new VerdictEventBus(),
    fhenixVerifier: null,
    fhenixGateway: null,
    privyAuth,
    fhenixChainId: null,
    fhenixSealedVerdictsAddress: null,
    liveCanaries,
    marketRegistrationGammaLookup,
    newAccountId,
    newAgentId: () => "daemon-http-agent-id-1",
    newAgentSecurityEventId,
    newFeedId,
    newUsageEventId,
    now: () => new Date("2026-05-15T12:00:00Z"),
    operatorAlertSink: null,
  });
  assert.equal(app.get("trust proxy"), false);

  const started = await listen(app);
  server = started.server;
  const baseUrl = `http://127.0.0.1:${started.port}`;

  const ambientDenied = await fetch(`${baseUrl}/v1/admin/canaries`, {
    headers: { "X-Admin-Token": "ambient-admin-token-0123456789abcdef" },
  });
  assert.equal(ambientDenied.status, 403);

  const configuredAllowed = await fetch(`${baseUrl}/v1/admin/canaries`, {
    headers: { "X-Admin-Token": "configured-admin-token-0123456789abcdef" },
  });
  assert.equal(configuredAllowed.status, 200);

  const embed = await fetch(`${baseUrl}/embed.js`);
  assert.equal(embed.status, 200);
  const embedJs = await embed.text();
  assert.match(embedJs, /https:\/\/configured-public\.example/);
  assert.doesNotMatch(embedJs, /ambient-public\.invalid/);

  const lifecycle = await fetch(`${baseUrl}/v1/admin/fhenix/lifecycle`, {
    headers: { "X-Admin-Token": "configured-admin-token-0123456789abcdef" },
  });
  assert.equal(lifecycle.status, 200);
  const lifecycleBody = await lifecycle.json() as {
    configured?: { reveal_grace_seconds?: number };
  };
  assert.equal(lifecycleBody.configured?.reveal_grace_seconds, 123);

  const alerts = await fetch(`${baseUrl}/v1/admin/alerts`, {
    headers: { "X-Admin-Token": "configured-admin-token-0123456789abcdef" },
  });
  assert.equal(alerts.status, 200);
  const alertsBody = await alerts.json() as { sink_configured?: boolean };
  assert.equal(alertsBody.sink_configured, false);

  const accountSession = await fetch(`${baseUrl}/v1/account/session`, {
    method: "POST",
    headers: { Authorization: "Bearer configured-privy-token" },
  });
  assert.equal(accountSession.status, 200);
  const accountSessionBody = await accountSession.json() as {
    account_id?: string;
    created?: boolean;
    privy_user_id?: string;
  };
  assert.equal(accountSessionBody.account_id, "daemon-http-account-id-1");
  assert.equal(accountSessionBody.privy_user_id, "did:privy:configured");
  assert.equal(accountSessionBody.created, true);
  assert.deepEqual(accountIds, ["daemon-http-account-id-1"]);

  const createdAgent = await fetch(`${baseUrl}/v1/account/agents`, {
    method: "POST",
    headers: {
      Authorization: "Bearer configured-privy-token",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      display_slug: "daemon-http-agent",
      display_name: "Daemon HTTP Agent",
    }),
  });
  assert.equal(createdAgent.status, 201);
  const createdAgentBody = await createdAgent.json() as {
    agent_id?: string;
    display_slug?: string;
    created_at?: string;
  };
  assert.equal(createdAgentBody.agent_id, "daemon-http-agent-id-1");
  assert.equal(createdAgentBody.display_slug, "daemon-http-agent");
  assert.equal(createdAgentBody.created_at, "2026-05-15T12:00:00Z");
  assert.deepEqual(accountIds, ["daemon-http-account-id-1"]);

  const createdFeed = await fetch(`${baseUrl}/v1/feeds`, {
    method: "POST",
    headers: {
      Authorization: "Bearer configured-privy-token",
      "Content-Type": "application/json",
      "X-Murmur-Agent-Slug": "daemon-http-agent",
    },
    body: JSON.stringify(feedBody()),
  });
  assert.equal(createdFeed.status, 201);
  const createdFeedBody = await createdFeed.json() as {
    feed?: {
      feed_id?: string;
      agent_slug?: string;
      delivery_cadence_seconds?: number | null;
    };
  };
  assert.equal(createdFeedBody.feed?.feed_id, "daemon-http-feed-id-1");
  assert.equal(createdFeedBody.feed?.agent_slug, "daemon-http-agent");
  assert.equal(createdFeedBody.feed?.delivery_cadence_seconds, 300);
  assert.deepEqual(feedIds, ["daemon-http-feed-id-1"]);

  const registeredMarket = await fetch(`${baseUrl}/v1/admin/markets/polymarket`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Admin-Token": "configured-admin-token-0123456789abcdef",
    },
    body: JSON.stringify({
      conditionId: marketRegistrationConditionId,
      resolution_class: "event_binary",
      // An admin registration carries no series schedule, so it may only
      // create a draft — a listed market without an embargo stamp would
      // reject every submission to it.
      status: "draft",
    }),
  });
  assert.equal(registeredMarket.status, 201);
  const registeredMarketBody = await registeredMarket.json() as {
    market?: { market_id?: string; horizon_seconds?: number; status?: string };
  };
  assert.equal(registeredMarketBody.market?.market_id, marketRegistrationConditionId);
  assert.equal(registeredMarketBody.market?.horizon_seconds, 3_600);
  assert.equal(registeredMarketBody.market?.status, "draft");
  assert.deepEqual(marketRegistrationGammaCalls, [marketRegistrationConditionId]);

  const securityRows = db.prepare(
    "SELECT event_id, kind, actor FROM agent_security_events ORDER BY event_id",
  ).all() as Array<{ event_id: string; kind: string; actor: string }>;
  assert.deepEqual(securityRows, [
    {
      event_id: "00000000-0000-4000-8000-000000000001",
      kind: "admin_polymarket_upsert",
      actor: "admin_token",
    },
  ]);
  assert.deepEqual(agentSecurityEventIds, [
    "00000000-0000-4000-8000-000000000001",
  ]);

  const funnelEvent = await fetch(`${baseUrl}/v1/account/events`, {
    method: "POST",
    headers: {
      Authorization: "Bearer configured-privy-token",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      kind: "destination.set",
      attributes: { source: "daemon-http-smoke" },
    }),
  });
  assert.equal(funnelEvent.status, 204);

  const destinationUpdate = await fetch(
    `${baseUrl}/v1/account/agents/daemon-http-agent/destination-address`,
    {
      method: "PATCH",
      headers: {
        Authorization: "Bearer configured-privy-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        destination_address: "0x1111111111111111111111111111111111111111",
      }),
    },
  );
  assert.equal(destinationUpdate.status, 200);
  const destinationUpdateBody = await destinationUpdate.json() as {
    destination_address?: string;
  };
  assert.equal(
    destinationUpdateBody.destination_address,
    "0x1111111111111111111111111111111111111111",
  );

  const usageRows = db.prepare(
    "SELECT event_id, kind, agent_id FROM usage_events ORDER BY event_id",
  ).all() as Array<{
    event_id: string;
    kind: string;
    agent_id: string | null;
  }>;
  assert.deepEqual(usageRows, [
    {
      event_id: "00000000-0000-4000-8000-000000000001",
      kind: "destination.set",
      agent_id: null,
    },
    {
      event_id: "00000000-0000-4000-8000-000000000002",
      kind: "destination_address_updated",
      agent_id: "daemon-http-agent-id-1",
    },
  ]);
  assert.deepEqual(usageEventIds, [
    "00000000-0000-4000-8000-000000000001",
    "00000000-0000-4000-8000-000000000002",
  ]);
  assert.deepEqual(accountIds, ["daemon-http-account-id-1"]);

  db.close();
  dbClosed = true;
  const routeFailure = await fetch(`${baseUrl}/v1/meta`);
  assert.equal(routeFailure.status, 500);
  assert.equal(errors.length, 1);
  assert.equal(errors[0][0], "[verdict-api]");
} finally {
  if (server) await closeServer(server);
  if (!dbClosed) db.close();
  rmSync(tmp, { recursive: true, force: true });
  if (priorAdminToken === undefined) delete process.env.VERDICT_ADMIN_TOKEN;
  else process.env.VERDICT_ADMIN_TOKEN = priorAdminToken;
  if (priorPublicUrl === undefined) delete process.env.MURMUR_PUBLIC_URL;
  else process.env.MURMUR_PUBLIC_URL = priorPublicUrl;
  if (priorFhenixRevealGraceSec === undefined) {
    delete process.env.FHENIX_REVEAL_GRACE_SEC;
  } else {
    process.env.FHENIX_REVEAL_GRACE_SEC = priorFhenixRevealGraceSec;
  }
  if (priorOperatorAlertWebhookUrl === undefined) {
    delete process.env.MURMUR_OPERATOR_ALERT_WEBHOOK_URL;
  } else {
    process.env.MURMUR_OPERATOR_ALERT_WEBHOOK_URL = priorOperatorAlertWebhookUrl;
  }
  if (priorOperatorAlertSecret === undefined) {
    delete process.env.MURMUR_OPERATOR_ALERT_SECRET;
  } else {
    process.env.MURMUR_OPERATOR_ALERT_SECRET = priorOperatorAlertSecret;
  }
  if (priorPrivyAppId === undefined) delete process.env.PRIVY_APP_ID;
  else process.env.PRIVY_APP_ID = priorPrivyAppId;
  if (priorPrivyAppSecret === undefined) delete process.env.PRIVY_APP_SECRET;
  else process.env.PRIVY_APP_SECRET = priorPrivyAppSecret;
  if (priorPrivyVerificationKey === undefined) {
    delete process.env.PRIVY_VERIFICATION_KEY;
  } else {
    process.env.PRIVY_VERIFICATION_KEY = priorPrivyVerificationKey;
  }
}

console.log("daemon-http smoke ok");

function listen(app: express.Express): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const s = app.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      if (typeof addr !== "object" || addr === null) {
        reject(new Error("server did not bind tcp address"));
        return;
      }
      resolve({ server: s, port: addr.port });
    });
    s.once("error", reject);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

function feedBody() {
  return {
    name: "Daemon HTTP Feed",
    description: "Daemon HTTP feed contract",
    status: "listed",
    venue: "polymarket-gamma",
    resolution_classes: ["event_binary"],
    edge_classes: ["latency"],
    covered_market_ids: [],
    delivery_cadence_seconds: 300,
    trigger_rules: [],
    max_latency_seconds: 60,
    subscriber_capacity: 5,
    commercial_template: "per_alert",
    reveal_policy: { kind: "after_resolution" },
    refund_rule: { kind: "credit", missed_delivery_grace: 1 },
    slash_rule: { kind: "none" },
  };
}
