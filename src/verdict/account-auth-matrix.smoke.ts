import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import express from "express";

import { openDb } from "./db.js";
import { createVerdictErrorHandler } from "./verdict-error-surface.js";
import { accountRouter } from "./routes/account.js";
import { adminPayoutsRouter } from "./routes/admin-payouts.js";
import { webhookRouter } from "./routes/webhooks.js";
import { createAdminRouteAuth } from "./admin-route-auth.js";
import type { PrivyAuthVerifier, PrivyClaims } from "./auth/privy.js";
import { feedContractsRouter } from "./routes/feed-contracts.js";

// ─── Privacy is an invariant, not a habit ───────────────────────────────────
//
// WHY THIS EXISTS. Murmur has two kinds of read surface and they are governed
// by opposite rules.
//
//   PUBLIC BY DESIGN — the leaderboard, markets, the sellable list, the venue
//   ticker, the archive, a granted subscriber's entitlement view. These are
//   the product. They are meant to be readable, and several are meant to be
//   readable with no credential at all.
//
//   PRIVATE BY CONSTRUCTION — everything under /v1/account/*. Every route
//   there is somebody's money, somebody's keys, or somebody's duty list. There
//   is no such thing as a "harmless" account route.
//
// The failure this suite is built against is not a bad route; it is a
// FORGOTTEN one. Auth applied per-handler holds until the day a route lands
// without it, and that route is then the single hole in an otherwise private
// surface. So the check does not read a hand-written list: it ENUMERATES the
// live express router and asserts against what is actually mounted. Adding a
// route without updating EXPECTED_ACCOUNT_ROUTES below fails this smoke, which
// is the point — the failure arrives at the moment the route is written,
// rather than the moment somebody's earnings leak.
//
// ONE DELIBERATE EXEMPTION: GET /v1/account/session. It still requires a valid
// Privy bearer — it is in the 401 sweep like every other route — but it is the
// only route a CLOSED account may still call, because a client that only ever
// receives 403 cannot tell "your account is closed" from "the server is down".
//
// TWO STATUS CODES THIS SUITE ASSERTS AS THE CODEBASE ALREADY CHOSE THEM,
// rather than as it might prefer them:
//
//   · cross-tenant on an agent-scoped route → 403 `agent_not_authorized`.
//     requireOwnedAgentBySlug 404s an unknown slug and 403s a known one that
//     belongs to somebody else. What matters, and what is asserted, is that it
//     NEVER returns 200 and never returns the other account's data.
//   · admin routes → 403 `admin_forbidden` / 503 `admin_disabled`, from
//     createAdminRouteAuth. What is asserted is that a Privy session — however
//     valid — can never satisfy an admin route.
process.stdout.write("murmur account auth matrix smoke\n");

const NOW = new Date("2026-08-11T09:00:00.000Z");
const NOW_ISO = "2026-08-11T09:00:00Z";
const ADMIN_TOKEN = "admin-token-for-the-matrix";

/**
 * Every route the account router mounts, as `METHOD path`.
 *
 * Kept adjacent to the assertion on purpose. This list is not the source of
 * truth — the router is — and the smoke fails if the two disagree in EITHER
 * direction. A new private route must be added here consciously, and that is
 * the moment to ask whether it is covered by the sweeps below.
 */
const EXPECTED_ACCOUNT_ROUTES = [
  "POST /v1/account/session",
  "GET /v1/account/session",
  "POST /v1/account/deactivate",
  "POST /v1/account/agents",
  "GET /v1/account/agents",
  "GET /v1/account/agents/:slug/provider-terms",
  "PUT /v1/account/agents/:slug/provider-terms",
  "DELETE /v1/account/agents/:slug/provider-terms",
  "GET /v1/account/agents/:slug/market-registrations",
  "POST /v1/account/agents/:slug/market-registrations",
  "DELETE /v1/account/agents/:slug/market-registrations/:venueSeriesId",
  "GET /v1/account/agents/:slug/earnings",
  "GET /v1/account/agents/:slug/payouts",
  // The only route in murmur that can cause money to leave. It is ownership
  // gated like every other agent-scoped write, and it reserves rather than
  // sends — the payout worker does the transfer.
  "GET /v1/account/agents/:slug/withdrawals",
  "POST /v1/account/agents/:slug/withdrawals",
  "GET /v1/account/agents/:slug/reveals",
  "PATCH /v1/account/agents/:slug/profile",
  "POST /v1/account/agents/:slug/retire",
  "POST /v1/account/agents/:slug/unretire",
  "POST /v1/account/agents/:slug/delete",
  "GET /v1/account/webhooks",
  "DELETE /v1/account/webhooks/:id",
  "POST /v1/account/agents/:slug/wallet/challenge",
  "PATCH /v1/account/agents/:slug/wallet",
  "POST /v1/account/agents/:slug/wallet/reattest/challenge",
  "POST /v1/account/agents/:slug/wallet/reattest",
  "GET /v1/account/agents/:slug/runtime-keys",
  "POST /v1/account/agents/:slug/runtime-keys/challenge",
  "POST /v1/account/agents/:slug/runtime-keys",
  "DELETE /v1/account/runtime-keys/:key_id",
  "POST /v1/account/runtime-keys/:key_id/delete",
  "GET /v1/account/kill-switch",
  "POST /v1/account/kill-switch",
  "POST /v1/account/kill-switch/release",
  "GET /v1/account/activity",
  "GET /v1/account/agents/:slug/api-keys",
  "POST /v1/account/agents/:slug/api-keys",
  "DELETE /v1/account/api-keys/:key_id",
  "POST /v1/account/api-keys/:key_id/delete",
  "PATCH /v1/account/agents/:slug/destination-address",
  "POST /v1/account/events",
].sort();

// ── Harness ────────────────────────────────────────────────────────────────

const tmp = mkdtempSync(join(tmpdir(), "account-auth-matrix-"));
const db = openDb({ path: join(tmp, `${randomUUID()}.db`) });

interface Tenant {
  accountId: string;
  agentId: string;
  slug: string;
  token: string;
}

function seedTenant(label: string): Tenant {
  const accountId = randomUUID();
  const agentId = randomUUID();
  const slug = `${label}-${agentId.slice(0, 8)}`;
  db.prepare(
    `INSERT INTO agents (agent_id, display_slug, kind, display_name, bio, created_at)
     VALUES (?, ?, 'agent', ?, NULL, ?)`,
  ).run(agentId, slug, `${label} agent`, NOW_ISO);
  db.prepare(
    `INSERT INTO accounts (account_id, privy_user_id, created_at, last_seen_at)
     VALUES (?, ?, ?, ?)`,
  ).run(accountId, `did:privy:${label}`, NOW_ISO, NOW_ISO);
  db.prepare(
    "INSERT INTO account_agents (account_id, agent_id, created_at) VALUES (?, ?, ?)",
  ).run(accountId, agentId, NOW_ISO);
  return { accountId, agentId, slug, token: `token-${label}` };
}

const alice = seedTenant("alice");
const bob = seedTenant("bob");

const claimsByToken: Record<string, PrivyClaims> = {
  [alice.token]: {
    privy_user_id: "did:privy:alice",
    session_id: "s-alice",
    expires_at: "2026-12-01T00:00:00Z",
  },
  [bob.token]: {
    privy_user_id: "did:privy:bob",
    session_id: "s-bob",
    expires_at: "2026-12-01T00:00:00Z",
  },
};

const privyAuth: PrivyAuthVerifier = {
  isEnabled: () => true,
  async verify(token: string) {
    return claimsByToken[token] ?? null;
  },
  async hydrateProfile() {
    return {};
  },
};

// One of Bob's webhook subscriptions, for the cross-tenant webhook check.
const bobWebhookId = randomUUID();
db.prepare(
  `INSERT INTO webhooks (id, agent_slug, url, secret, created_at)
   VALUES (?, ?, ?, ?, ?)`,
).run(bobWebhookId, bob.slug, "https://bob.example/hook", "bob-secret", NOW_ISO);

const app = express();
// Distinct X-Forwarded-For per phase keeps the per-IP route throttles out of
// the way. This suite is about who may call what, not about how often.
app.set("trust proxy", 1);
const adminAuth = createAdminRouteAuth(ADMIN_TOKEN);
app.use(accountRouter({ db, accountAuth: privyAuth, now: () => NOW }));
app.use(
  adminPayoutsRouter({ db, requireAdmin: adminAuth.requireAdmin, now: () => NOW }),
);
app.use(
  webhookRouter({
    db,
    now: () => NOW,
    secretEquals: (a, b) => a === b,
    urlPolicy: { allowHttp: false },
    privyAuth,
  }),
);
app.use(
  feedContractsRouter({ db, privyAuth, now: () => NOW }),
);
app.use(createVerdictErrorHandler({ error: () => {} }));

const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", () => resolve()));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

interface Probe {
  method: string;
  path: string;
}

async function call(
  probe: Probe,
  opts: { token?: string; adminToken?: string; ip: string; body?: unknown } = {
    ip: "10.0.0.1",
  },
): Promise<{ status: number; body: string }> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-forwarded-for": opts.ip,
  };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.adminToken) headers["x-admin-token"] = opts.adminToken;
  const init: RequestInit = { method: probe.method, headers };
  if (probe.method !== "GET" && probe.method !== "HEAD") {
    init.body = JSON.stringify(opts.body ?? {});
  }
  const res = await fetch(`${base}${probe.path}`, init);
  return { status: res.status, body: await res.text() };
}

// ── 1. ENUMERATE the live router; the list is checked in both directions ───

function collectRoutes(node: unknown, out: string[]): void {
  const stack = (node as { stack?: unknown[] } | undefined)?.stack;
  if (!Array.isArray(stack)) return;
  for (const raw of stack) {
    const layer = raw as {
      route?: { path?: string; methods?: Record<string, boolean> };
      handle?: unknown;
    };
    if (layer.route?.path) {
      for (const [method, on] of Object.entries(layer.route.methods ?? {})) {
        if (on) out.push(`${method.toUpperCase()} ${layer.route.path}`);
      }
      continue;
    }
    collectRoutes(layer.handle, out);
  }
}

const mounted: string[] = [];
collectRoutes(
  (app as unknown as { router?: unknown; _router?: unknown }).router ??
    (app as unknown as { _router?: unknown })._router,
  mounted,
);
const accountRoutes = mounted
  .filter((r) => r.includes(" /v1/account/"))
  .sort();

assert.deepEqual(
  accountRoutes,
  EXPECTED_ACCOUNT_ROUTES,
  "the account route list drifted. Every /v1/account/* route is private by " +
    "construction — add it to EXPECTED_ACCOUNT_ROUTES and make sure the " +
    "sweeps below cover it.",
);
// The new surfaces are here, explicitly, so a rename cannot silently drop them.
for (const route of [
  "GET /v1/account/agents/:slug/payouts",
  "GET /v1/account/agents/:slug/reveals",
  "PATCH /v1/account/agents/:slug/profile",
  "POST /v1/account/agents/:slug/retire",
  "POST /v1/account/agents/:slug/unretire",
  "GET /v1/account/agents/:slug/market-registrations",
  "POST /v1/account/agents/:slug/market-registrations",
  "DELETE /v1/account/agents/:slug/market-registrations/:venueSeriesId",
  "POST /v1/account/deactivate",
  "GET /v1/account/webhooks",
  "DELETE /v1/account/webhooks/:id",
]) {
  assert.ok(accountRoutes.includes(route), `missing route: ${route}`);
}

// ── 2. UNAUTH: every account route refuses, and none of them crashes ───────

/** Fill path params with values that EXIST, so a 404 can only come from auth. */
function concretePath(path: string): string {
  return path
    .replace(":slug", encodeURIComponent(alice.slug))
    .replace(":key_id", "some-key-id")
    .replace(":id", bobWebhookId);
}

for (const route of accountRoutes) {
  const [method, path] = route.split(" ") as [string, string];
  const res = await call(
    { method, path: concretePath(path) },
    { ip: "10.0.1.1" },
  );
  assert.equal(
    res.status,
    401,
    `${route} must refuse an unauthenticated caller with 401, got ${res.status}`,
  );
  assert.ok(res.status < 500, `${route} must not 500 on an unauthenticated call`);
}

// A malformed / unknown bearer is the same refusal, not a 500.
for (const route of accountRoutes) {
  const [method, path] = route.split(" ") as [string, string];
  const res = await call(
    { method, path: concretePath(path) },
    { token: "not-a-real-token", ip: "10.0.2.1" },
  );
  assert.equal(res.status, 401, `${route} must refuse an unknown bearer`);
}

// ── 3. CROSS-TENANT: Alice may never touch Bob's agent ─────────────────────

const crossTenant: Array<{ method: string; path: string; body?: unknown }> = [
  { method: "GET", path: `/v1/account/agents/${bob.slug}/earnings` },
  { method: "GET", path: `/v1/account/agents/${bob.slug}/payouts` },
  { method: "GET", path: `/v1/account/agents/${bob.slug}/reveals` },
  { method: "GET", path: `/v1/account/agents/${bob.slug}/provider-terms` },
  {
    method: "PATCH",
    path: `/v1/account/agents/${bob.slug}/profile`,
    body: { display_name: "hijacked" },
  },
  { method: "POST", path: `/v1/account/agents/${bob.slug}/retire` },
  { method: "POST", path: `/v1/account/agents/${bob.slug}/unretire` },
  { method: "POST", path: `/v1/account/agents/${bob.slug}/delete`, body: { confirm: bob.slug } },
  { method: "GET", path: `/v1/account/agents/${bob.slug}/market-registrations` },
  {
    method: "POST",
    path: `/v1/account/agents/${bob.slug}/market-registrations`,
    body: { venue_series_id: "polymarket:btc-up-or-down-5m" },
  },
  {
    method: "DELETE",
    path: `/v1/account/agents/${bob.slug}/market-registrations/polymarket:btc-up-or-down-5m`,
  },
];

for (const probe of crossTenant) {
  const res = await call(probe, {
    token: alice.token,
    ip: "10.0.3.1",
    ...(probe.body ? { body: probe.body } : {}),
  });
  assert.ok(
    res.status === 403 || res.status === 404,
    `${probe.method} ${probe.path} must refuse a cross-tenant caller, got ${res.status}`,
  );
  assert.ok(
    !res.body.includes(bob.agentId),
    `${probe.method} ${probe.path} leaked another account's agent id`,
  );
  assert.ok(
    !res.body.includes("bob agent"),
    `${probe.method} ${probe.path} leaked another account's data`,
  );
}

// The refusal is real, not cosmetic: Bob's agent is untouched.
{
  const bobRow = db
    .prepare("SELECT display_name, retired_at FROM agents WHERE agent_id = ?")
    .get(bob.agentId) as { display_name: string; retired_at: string | null };
  assert.equal(bobRow.display_name, "bob agent");
  assert.equal(bobRow.retired_at, null);
}

// And the same routes DO work for their own owner — a matrix that refuses
// everybody proves nothing.
for (const path of [
  "earnings",
  "payouts",
  "reveals",
  "provider-terms",
  "market-registrations",
]) {
  // provider-terms is per venue series now (migration 075): a read names one.
  // Without it the owner is authorized but the request is malformed (400), so
  // the auth check here supplies a series to prove the 200 path.
  const suffix =
    path === "provider-terms" ? "?series=polymarket:btc-up-or-down-5m" : "";
  const res = await call(
    { method: "GET", path: `/v1/account/agents/${alice.slug}/${path}${suffix}` },
    { token: alice.token, ip: "10.0.4.1" },
  );
  assert.equal(res.status, 200, `owner read of ${path} must succeed`);
}

// ── 4. WEBHOOKS: create is account-authed; list and delete are ownership-scoped

{
  const unauthCreate = await fetch(`${base}/v1/webhooks`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "10.0.5.1" },
    body: JSON.stringify({ agent_slug: alice.slug, url: "https://a.example/hook" }),
  });
  assert.equal(unauthCreate.status, 401, "POST /v1/webhooks must refuse unauth");

  const unauthRead = await fetch(`${base}/v1/account/webhooks`, {
    headers: { "x-forwarded-for": "10.0.5.1" },
  });
  assert.equal(unauthRead.status, 401);

  // Alice lists her own — Bob's subscription must not be in it.
  const aliceList = await call(
    { method: "GET", path: "/v1/account/webhooks" },
    { token: alice.token, ip: "10.0.5.2" },
  );
  assert.equal(aliceList.status, 200);
  assert.ok(
    !aliceList.body.includes(bobWebhookId),
    "Alice's webhook list leaked Bob's subscription",
  );
  assert.ok(
    !aliceList.body.includes("bob-secret"),
    "a webhook list must never carry the delivery secret",
  );

  // Alice cannot delete Bob's, and it survives.
  const aliceDelete = await call(
    { method: "DELETE", path: `/v1/account/webhooks/${bobWebhookId}` },
    { token: alice.token, ip: "10.0.5.3" },
  );
  assert.equal(aliceDelete.status, 404);
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM webhooks WHERE id = ?").get(bobWebhookId) as {
      n: number;
    }).n,
    1,
  );

  // Bob can, and it goes.
  const bobList = await call(
    { method: "GET", path: "/v1/account/webhooks" },
    { token: bob.token, ip: "10.0.5.4" },
  );
  assert.ok(bobList.body.includes(bobWebhookId));
  const bobDelete = await call(
    { method: "DELETE", path: `/v1/account/webhooks/${bobWebhookId}` },
    { token: bob.token, ip: "10.0.5.5" },
  );
  assert.equal(bobDelete.status, 200);
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM webhooks WHERE id = ?").get(bobWebhookId) as {
      n: number;
    }).n,
    0,
  );
}

// ── 5. ADMIN: a Privy session is not an admin token ────────────────────────

{
  const payoutBody = {
    agent_slug: alice.slug,
    entry_type: "payout",
    currency: "USDC",
    amount_atoms: "1000000",
    tx_ref: "0xmatrix",
    payout_method: "usdc_base",
    destination_ref: "0xdead",
    earnings_cutoff_at: "2026-08-01T00:00:00Z",
  };

  const noAuth = await call(
    { method: "POST", path: "/v1/admin/payouts" },
    { ip: "10.0.6.1", body: payoutBody },
  );
  assert.ok(
    noAuth.status === 401 || noAuth.status === 403 || noAuth.status === 503,
    `admin payouts must refuse an unauthenticated write, got ${noAuth.status}`,
  );

  // The one that matters: a VALID account session must not satisfy an admin
  // route. Owners read their payouts; only the operator writes them.
  const withPrivy = await call(
    { method: "POST", path: "/v1/admin/payouts" },
    { token: alice.token, ip: "10.0.6.2", body: payoutBody },
  );
  assert.ok(
    withPrivy.status === 401 || withPrivy.status === 403 || withPrivy.status === 503,
    `a Privy session must not satisfy /v1/admin/payouts, got ${withPrivy.status}`,
  );
  const wrongToken = await call(
    { method: "POST", path: "/v1/admin/payouts" },
    { adminToken: "wrong", ip: "10.0.6.3", body: payoutBody },
  );
  assert.ok(wrongToken.status === 401 || wrongToken.status === 403);
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM provider_payouts").get() as { n: number }).n,
    0,
    "a refused admin write must not have written a journal row",
  );

  // With the real token it works, which is what makes the refusals meaningful.
  const authorized = await call(
    { method: "POST", path: "/v1/admin/payouts" },
    { adminToken: ADMIN_TOKEN, ip: "10.0.6.4", body: payoutBody },
  );
  assert.equal(authorized.status, 201);

  // And the owner — not the operator — reads it back.
  const ownerRead = await call(
    { method: "GET", path: `/v1/account/agents/${alice.slug}/payouts` },
    { token: alice.token, ip: "10.0.6.5" },
  );
  assert.equal(ownerRead.status, 200);
  assert.ok(ownerRead.body.includes("0xmatrix"));
  const notOwnerRead = await call(
    { method: "GET", path: `/v1/account/agents/${alice.slug}/payouts` },
    { token: bob.token, ip: "10.0.6.6" },
  );
  assert.ok(notOwnerRead.status === 403 || notOwnerRead.status === 404);
  assert.ok(!notOwnerRead.body.includes("0xmatrix"));
}

// ── Closed-account enforcement OUTSIDE /v1/account/ ─────────────────────
// The /v1/account/ prefix filter above cannot see these; any NEW Privy-authed
// route mounted under another prefix must join this section by hand (the
// dispatcher-level assertAccountActive covers dispatcher routes for free, but
// custom auth modules like the webhook one need their own check — that is
// exactly how security review R1 happened).
{
  const carol = seedTenant("carol");
  claimsByToken[carol.token] = {
    privy_user_id: "did:privy:carol",
    session_id: "s-carol",
    expires_at: "2026-12-01T00:00:00Z",
  };
  db.prepare("UPDATE accounts SET deactivated_at = ? WHERE account_id = ?")
    .run(NOW_ISO, carol.accountId);

  // Webhook CRUD (custom auth module): a closed account reads as no auth.
  const closedCreate = await call(
    { method: "POST", path: "/v1/webhooks" },
    { token: carol.token, ip: "10.0.7.1", body: { agent_slug: carol.slug, url: "https://x.example/h" } },
  );
  assert.ok(closedCreate.status === 401 || closedCreate.status === 403,
    `closed account must not create webhooks (got ${closedCreate.status})`);

  const closedList = await call(
    { method: "GET", path: "/v1/account/webhooks" },
    { token: carol.token, ip: "10.0.7.2" },
  );
  assert.equal(closedList.status, 403, "closed account webhook list must refuse");

  // Dispatcher-authed route outside /v1/account (feeds): refused by
  // assertAccountActive at the dispatcher, not by the route.
  const closedFeed = await call(
    { method: "POST", path: "/v1/feeds" },
    { token: carol.token, ip: "10.0.7.3", body: { agent_slug: carol.slug, cadence_seconds: 60 } },
  );
  assert.ok(closedFeed.status === 401 || closedFeed.status === 403,
    `closed account must not create feed contracts (got ${closedFeed.status})`);

  // And the no-touch rule: all those refused requests must not have moved
  // last_seen_at forward.
  const seen = db.prepare("SELECT last_seen_at FROM accounts WHERE account_id = ?")
    .get(carol.accountId) as { last_seen_at: string };
  assert.equal(seen.last_seen_at, NOW_ISO,
    "refused closed-account requests must not touch last_seen_at");
}

server.close();
db.close();
rmSync(tmp, { recursive: true, force: true });
process.stdout.write("account auth matrix smoke OK\n");
