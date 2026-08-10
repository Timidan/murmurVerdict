import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CallAcceptedEvent } from "./events.js";
import { openDb } from "./db.js";
import {
  deliverWebhook,
  webhookDeliveryRequest,
  type WebhookDeliveryTimers,
} from "./webhook-delivery.js";
import { webhooksRepo } from "./repos/webhooks-repo.js";
import {
  WEBHOOK_SIGNATURE_HEADER,
  verifyWebhookSignature,
} from "./webhook-subscription.js";

const tmp = mkdtempSync(join(tmpdir(), "murmur-webhook-delivery-"));
const dbPath = join(tmp, "test.db");

try {
  process.stdout.write("murmur Webhook Delivery smoke\n");
  const db = openDb({ path: dbPath });
  webhooksRepo.insert(db, {
    id: "webhook-1",
    agent_slug: "agent-one",
    url: "https://hooks.example/murmur",
    secret: "webhook-secret",
    created_at: "2026-06-12T09:00:00Z",
  });
  const target = webhooksRepo.byId(db, "webhook-1");
  assert.ok(target);
  const event: CallAcceptedEvent = {
    type: "call.accepted",
    call_id: "call-1",
    agent_id: "agent-1",
    agent_slug: "agent-one",
    privacy_mode: "sealed_fhenix",
    accepted_at: "2026-06-12T09:29:00Z",
  };

  const request = webhookDeliveryRequest({
    target,
    event,
    deliveredAt: "2026-06-12T09:30:00Z",
    signal: new AbortController().signal,
  });
  assert.equal(request.url, "https://hooks.example/murmur");
  assert.equal(request.init.method, "POST");
  assert.equal(request.init.redirect, "error");
  const headers = request.init.headers as Record<string, string>;
  assert.equal(headers["X-Murmur-Webhook-Id"], "webhook-1");
  assert.equal(headers["X-Murmur-Event"], "call.accepted");
  assert.equal(
    verifyWebhookSignature({
      secret: "webhook-secret",
      rawBody: request.body,
      signatureHeader: headers[WEBHOOK_SIGNATURE_HEADER],
    }),
    true,
  );
  assert.deepEqual(JSON.parse(request.body), {
    schema_version: 1,
    delivered_at: "2026-06-12T09:30:00Z",
    event,
  });

  const captured: Array<{ url: string; init: RequestInit; address: string }> = [];
  const publicDnsLookup = async () => [{ address: "1.1.1.1", family: 4 }];
  const pinnedTransport = async (
    destination: { address: string },
    url: string,
    init: RequestInit,
  ) => {
    captured.push({ url, init, address: destination.address });
    return { status: 202, ok: true, text: async () => "accepted" };
  };
  await deliverWebhook({
    db,
    target,
    event,
    pinnedTransport,
    dnsLookup: publicDnsLookup,
    timers: fakeTimers(),
    deliveredAt: new Date("2026-06-12T09:30:00Z"),
  });
  assert.equal(captured[0]?.url, "https://hooks.example/murmur");
  assert.equal(captured[0]?.address, "1.1.1.1");
  assert.equal((captured[0]?.init.headers as Record<string, string>)["X-Murmur-Event"], "call.accepted");
  assert.equal(
    JSON.parse(String(captured[0]?.init.body)).delivered_at,
    "2026-06-12T09:30:00Z",
  );
  let stored = webhooksRepo.byId(db, "webhook-1");
  assert.equal(stored?.last_status, 202);
  assert.equal(stored?.last_delivery_at, "2026-06-12T09:30:00Z");
  assert.equal(stored?.delivery_count, 1);
  assert.equal(stored?.failure_count, 0);

  await deliverWebhook({
    db,
    target,
    event,
    fetch: async () => {
      throw new Error("network down");
    },
    dnsLookup: publicDnsLookup,
    timers: fakeTimers(),
    deliveredAt: new Date("2026-06-12T09:31:00Z"),
  });
  stored = webhooksRepo.byId(db, "webhook-1");
  assert.equal(stored?.last_status, 0);
  assert.equal(stored?.last_delivery_at, "2026-06-12T09:31:00Z");
  assert.equal(stored?.delivery_count, 2);
  assert.equal(stored?.failure_count, 1);

  let reboundFetchCalled = false;
  await deliverWebhook({
    db,
    target,
    event,
    fetch: async () => {
      reboundFetchCalled = true;
      return { status: 200, ok: true, text: async () => "" };
    },
    dnsLookup: async () => [{ address: "169.254.169.254", family: 4 }],
    timers: fakeTimers(),
    deliveredAt: new Date("2026-06-12T09:32:00Z"),
  });
  assert.equal(reboundFetchCalled, false, "delivery-time DNS rebinding must fail before transport");
  stored = webhooksRepo.byId(db, "webhook-1");
  assert.equal(stored?.last_status, 0);
  assert.equal(stored?.delivery_count, 3);
  assert.equal(stored?.failure_count, 2);

  db.close();
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

process.stdout.write("Webhook Delivery smoke ok\n");

function fakeTimers(): WebhookDeliveryTimers {
  return {
    setTimeout: () => "timeout",
    clearTimeout: () => undefined,
  };
}
