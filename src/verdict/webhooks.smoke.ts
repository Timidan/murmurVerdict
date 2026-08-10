import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CallAcceptedEvent } from "./events.js";
import { VerdictEventBus } from "./events.js";
import { openDb } from "./db.js";
import { webhooksRepo } from "./repos/webhooks-repo.js";
import type { WebhookDeliveryInput } from "./webhook-delivery.js";
import { startWebhookDispatcher } from "./webhooks.js";

const tmp = mkdtempSync(join(tmpdir(), "murmur-webhooks-"));
const dbPath = join(tmp, "test.db");

try {
  process.stdout.write("murmur Webhook Dispatcher smoke\n");
  const db = openDb({ path: dbPath });
  const events = new VerdictEventBus();
  const delivered: WebhookDeliveryInput[] = [];
  const now = () => new Date("2026-06-12T09:30:00Z");

  webhooksRepo.insert(db, {
    id: "webhook-1",
    agent_slug: "agent-one",
    url: "https://hooks.example/murmur",
    secret: "webhook-secret",
    created_at: "2026-06-12T09:00:00Z",
  });

  const dispatcher = startWebhookDispatcher(db, events, {
    now,
    deliver: (input) => {
      delivered.push(input);
    },
  });
  assert.equal(events.subscriberCount(), 1);

  const event: CallAcceptedEvent = {
    type: "call.accepted",
    call_id: "call-1",
    agent_id: "agent-1",
    agent_slug: "agent-one",
    privacy_mode: "sealed_fhenix",
    accepted_at: "2026-06-12T09:29:00Z",
  };
  events.emit(event);
  assert.equal(dispatcher.deliveryCount(), 1);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0]?.event, event);
  assert.equal(delivered[0]?.target.id, "webhook-1");
  assert.equal(
    delivered[0]?.deliveredAt.toISOString(),
    "2026-06-12T09:30:00.000Z",
  );

  events.emit({
    type: "leaderboard.update",
    served_at: "2026-06-12T09:31:00Z",
    rows: [],
  });
  assert.equal(dispatcher.deliveryCount(), 1);
  assert.equal(delivered.length, 1);

  dispatcher.stop();
  assert.equal(events.subscriberCount(), 0);
  events.emit(event);
  assert.equal(dispatcher.deliveryCount(), 1);
  assert.equal(delivered.length, 1);

  const deliveryErrors: Array<{ error: unknown; webhookId: string }> = [];
  const failingDispatcher = startWebhookDispatcher(db, events, {
    now,
    deliver: async () => {
      throw new Error("simulated webhook delivery failure");
    },
    onDeliveryError: (error, target) => {
      deliveryErrors.push({ error, webhookId: target.id });
    },
  });
  events.emit(event);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(deliveryErrors.length, 1);
  assert.equal(deliveryErrors[0]?.webhookId, "webhook-1");
  assert.match(String(deliveryErrors[0]?.error), /simulated webhook delivery failure/);
  failingDispatcher.stop();

  db.close();
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

process.stdout.write("Webhook Dispatcher smoke ok\n");
