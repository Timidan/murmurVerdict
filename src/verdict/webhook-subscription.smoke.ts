import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  WEBHOOK_BODY_TO_SIGN,
  WEBHOOK_SECRET_HEADER,
  WEBHOOK_SIGNATURE_ALGORITHM,
  WEBHOOK_SIGNATURE_HEADER,
  deleteWebhookSubscription,
  loadWebhookSubscription,
  makeWebhookSubscription,
  publicWebhookRow,
  registerWebhookSubscription,
  sendDeleteWebhookSubscriptionResponse,
  sendWebhookSubscriptionJsonResponse,
  verifyWebhookSignature,
  webhookSignatureHeader,
  webhookVerificationInstructions,
} from "./webhook-subscription.js";
import { agentsRepo, openDb } from "./db.js";
import { webhooksRepo } from "./repos/webhooks-repo.js";
import type { WebhookRow } from "./repos/webhooks-repo.js";
import type { WebhookDnsLookup } from "./webhook-url.js";

const subscription = makeWebhookSubscription({
  agent_slug: "maya",
  url: "https://hooks.example/murmur",
  newSubscriptionId: () => "webhook-subscription-smoke-id",
  newSubscriptionSecret: () => "webhook-subscription-smoke-secret",
  now: () => new Date("2026-01-02T03:04:05.678Z"),
});
assert.equal(subscription.id, "webhook-subscription-smoke-id");
assert.equal(subscription.agent_slug, "maya");
assert.equal(subscription.url, "https://hooks.example/murmur");
assert.equal(subscription.secret, "webhook-subscription-smoke-secret");
assert.equal(subscription.created_at, "2026-01-02T03:04:05Z");

const row: WebhookRow = {
  ...subscription,
  last_delivery_at: null,
  last_status: null,
  delivery_count: 0,
  failure_count: 0,
  disabled: 0,
};
assert.deepEqual(publicWebhookRow(row), {
  id: subscription.id,
  agent_slug: "maya",
  url: "https://hooks.example/murmur",
  created_at: "2026-01-02T03:04:05Z",
  last_delivery_at: null,
  last_status: null,
  delivery_count: 0,
  failure_count: 0,
  disabled: 0,
});

const rawBody = JSON.stringify({ schema_version: 1, ok: true });
const signatureHeader = webhookSignatureHeader({
  secret: subscription.secret,
  rawBody,
});
assert.match(signatureHeader, /^sha256=[0-9a-f]{64}$/);
assert.equal(
  verifyWebhookSignature({
    secret: subscription.secret,
    rawBody,
    signatureHeader,
  }),
  true,
);
assert.equal(
  verifyWebhookSignature({
    secret: subscription.secret,
    rawBody: `${rawBody}\n`,
    signatureHeader,
  }),
  false,
);
assert.equal(
  verifyWebhookSignature({
    secret: subscription.secret,
    rawBody,
    signatureHeader: "sha512=bad",
  }),
  false,
);

assert.deepEqual(webhookVerificationInstructions(), {
  algorithm: WEBHOOK_SIGNATURE_ALGORITHM,
  header: WEBHOOK_SIGNATURE_HEADER,
  format: "sha256=<hex>",
  body_to_sign: WEBHOOK_BODY_TO_SIGN,
});
assert.equal(WEBHOOK_SECRET_HEADER, "X-Murmur-Webhook-Secret");

const tmp = mkdtempSync(join(tmpdir(), "murmur-webhook-subscription-"));
const dbPath = join(tmp, "test.db");
try {
  const db = openDb({ path: dbPath });
  agentsRepo.insert(db, {
    agent_id: randomUUID(),
    display_slug: "webhook-smoke",
    kind: "agent",
    display_name: "Webhook Smoke",
    created_at: "2026-05-27T12:00:00Z",
  });

  const dnsLookups: string[] = [];
  const publicDnsLookup: WebhookDnsLookup = async (hostname) => {
    dnsLookups.push(hostname);
    return [{ address: "93.184.216.34", family: 4 }];
  };
  const mintedIds: string[] = [];
  const mintedSecrets: string[] = [];
  const newSubscriptionId = () => {
    const id = `webhook-registration-id-${mintedIds.length + 1}`;
    mintedIds.push(id);
    return id;
  };
  const newSubscriptionSecret = () => {
    const secret = `webhook-registration-secret-${mintedSecrets.length + 1}`;
    mintedSecrets.push(secret);
    return secret;
  };

  const registered = await registerWebhookSubscription({
    db,
    body: {
      url: "https://hooks.example/murmur",
      agent_slug: "webhook-smoke-extra-text-that-should-not-matter-after-the-slug-limit",
    },
    now: () => new Date("2026-05-27T12:01:02.345Z"),
    newSubscriptionId,
    newSubscriptionSecret,
    urlPolicy: { allowHttp: false },
    urlDnsLookup: publicDnsLookup,
  });
  assert.equal(registered.status, 404);
  assert.deepEqual(registered.body, {
    code: "unknown_agent",
    message: "agent_slug not found",
  });
  const unknownAgentTarget = makeStatusJsonTarget();
  sendWebhookSubscriptionJsonResponse(unknownAgentTarget, registered);
  assert.equal(unknownAgentTarget.statusCode, 404);
  assert.equal(unknownAgentTarget.body, registered.body);
  assert.deepEqual(mintedIds, []);
  assert.deepEqual(mintedSecrets, []);

  const success = await registerWebhookSubscription({
    db,
    body: {
      url: "https://hooks.example/murmur",
      agent_slug: "webhook-smoke",
    },
    now: () => new Date("2026-05-27T12:01:02.345Z"),
    newSubscriptionId,
    newSubscriptionSecret,
    urlPolicy: { allowHttp: false },
    urlDnsLookup: publicDnsLookup,
  });
  assert.equal(success.status, 201);
  if (success.status !== 201) throw new Error("expected webhook registration success");
  assert.equal(success.body.id, "webhook-registration-id-1");
  assert.equal(success.body.agent_slug, "webhook-smoke");
  assert.equal(success.body.url, "https://hooks.example/murmur");
  assert.equal(success.body.created_at, "2026-05-27T12:01:02Z");
  assert.equal(success.body.secret, "webhook-registration-secret-1");
  assert.deepEqual(success.body.verify_signature, webhookVerificationInstructions());
  assert.equal(webhooksRepo.byId(db, success.body.id)?.secret, success.body.secret);
  assert.deepEqual(mintedIds, ["webhook-registration-id-1"]);
  assert.deepEqual(mintedSecrets, ["webhook-registration-secret-1"]);
  // Cheap rejections skip DNS, so only the success path looked up a host.
  assert.deepEqual(dnsLookups, ["hooks.example"]);
  const registerTarget = makeStatusJsonTarget();
  sendWebhookSubscriptionJsonResponse(registerTarget, success);
  assert.equal(registerTarget.statusCode, 201);
  assert.equal(registerTarget.body, success.body);

  // Reading requires the same secret DELETE does.
  const loaded = loadWebhookSubscription({
    db,
    id: success.body.id,
    providedSecret: success.body.secret,
    secretEquals: (a, b) => a === b,
  });
  assert.equal(loaded.status, 200);
  if (loaded.status !== 200) throw new Error("expected webhook load success");
  assert.equal(loaded.body.schema_version, 1);

  // A missing or wrong secret is refused; an unguessable id is not a gate.
  {
    const eq = (a: string | undefined, b: string) => a === b;
    const id = success.body.id;
    assert.equal(
      loadWebhookSubscription({ db, id, providedSecret: undefined, secretEquals: eq }).status,
      403,
      "reading a subscription must require its secret",
    );
    assert.equal(
      loadWebhookSubscription({ db, id, providedSecret: "not-it", secretEquals: eq }).status,
      403,
      "a wrong secret must refuse",
    );
  }
  assert.equal(loaded.body.webhook.id, success.body.id);
  assert.equal(loaded.body.webhook.agent_slug, "webhook-smoke");
  assert.equal(loaded.body.webhook.url, "https://hooks.example/murmur");
  assert.equal("secret" in loaded.body.webhook, false);
  const loadTarget = makeStatusJsonTarget();
  sendWebhookSubscriptionJsonResponse(loadTarget, loaded);
  assert.equal(loadTarget.statusCode, 200);
  assert.equal(loadTarget.body, loaded.body);

  const forbiddenDelete = deleteWebhookSubscription({
    db,
    id: success.body.id,
    providedSecret: "wrong",
    secretEquals: (provided, expected) => provided === expected,
  });
  assert.deepEqual(forbiddenDelete, {
    status: 403,
    body: { code: "forbidden", message: "secret mismatch" },
  });
  const forbiddenTarget = makeStatusJsonTarget();
  sendDeleteWebhookSubscriptionResponse(forbiddenTarget, forbiddenDelete);
  assert.equal(forbiddenTarget.statusCode, 403);
  assert.equal(forbiddenTarget.body, forbiddenDelete.body);
  assert.ok(webhooksRepo.byId(db, success.body.id));

  const deleted = deleteWebhookSubscription({
    db,
    id: success.body.id,
    providedSecret: success.body.secret,
    secretEquals: (provided, expected) => provided === expected,
  });
  assert.deepEqual(deleted, { status: 204 });
  const deleteTarget = makeStatusJsonTarget();
  sendDeleteWebhookSubscriptionResponse(deleteTarget, deleted);
  assert.equal(deleteTarget.statusCode, 204);
  assert.equal(deleteTarget.ended, true);
  assert.equal(webhooksRepo.byId(db, success.body.id), null);

  const missingDelete = deleteWebhookSubscription({
    db,
    id: success.body.id,
    providedSecret: success.body.secret,
    secretEquals: (provided, expected) => provided === expected,
  });
  assert.deepEqual(missingDelete, {
    status: 404,
    body: { code: "not_found", message: "webhook not found" },
  });
  assert.deepEqual(loadWebhookSubscription({
    db,
    id: success.body.id,
    providedSecret: success.body.secret,
    secretEquals: (a, b) => a === b,
  }), {
    status: 404,
    body: { code: "not_found", message: "webhook not found" },
  });

  const invalid = await registerWebhookSubscription({
    db,
    // Real slug, since slug checks run first; this hits the invalid_url branch.
    body: { url: "not-a-url", agent_slug: "webhook-smoke" },
    now: () => new Date("2026-05-27T12:02:00Z"),
    urlPolicy: { allowHttp: false },
  });
  assert.equal(invalid.status, 400);
  assert.deepEqual(invalid.body, {
    code: "invalid_url",
    message: "url must be a valid absolute URL",
  });
  db.close();
} finally {
  rmSync(tmp, { recursive: true, force: true });
}


console.log("webhook-subscription smoke ok");

function makeStatusJsonTarget() {
  return {
    statusCode: 0,
    body: undefined as unknown,
    ended: false,
    status(code: number) {
      this.statusCode = code;
      return {
        end: () => {
          this.ended = true;
        },
        json: (body: unknown) => {
          this.body = body;
        },
      };
    },
  };
}
