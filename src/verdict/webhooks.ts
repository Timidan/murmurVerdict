// Webhook dispatch — subscribes to the in-process VerdictEventBus and
// fires HTTP POST to every matching subscription on call.accepted /
// call.resolved. Each delivery is signed HMAC-SHA256(secret, body) and
// carries an X-Murmur-Signature header subscribers can verify.
//
// No retries in v0.1. Failures bump failure_count so the operator can
// see them via GET /v1/webhooks/:id; sustained failures should be
// handled out-of-band (disable the row, talk to the subscriber).

import type Database from "better-sqlite3";
import type { WebhookRow } from "./repos/webhooks-repo.js";
import type { VerdictEventBus } from "./events.js";
import { publicWebhookFanoutEvent } from "./public-event-fanout.js";
import {
  webhooksRepo,
} from "./repos/webhooks-repo.js";
import {
  deliverWebhook,
  type WebhookDeliveryInput,
} from "./webhook-delivery.js";
import type { WebhookDnsLookup, WebhookUrlPolicy } from "./webhook-url.js";

export { verifyWebhookSignature } from "./webhook-subscription.js";

export interface WebhookDispatcher {
  stop(): void;
  deliveryCount: () => number;
}

export type WebhookDispatcherDelivery = (
  input: WebhookDeliveryInput,
) => Promise<void> | void;

export interface WebhookDispatcherDeps {
  now: () => Date;
  deliver?: WebhookDispatcherDelivery;
  onDeliveryError?: (error: unknown, target: WebhookRow) => void;
  urlDnsLookup?: WebhookDnsLookup;
  urlPolicy?: WebhookUrlPolicy;
}

export function startWebhookDispatcher(
  db: Database.Database,
  events: VerdictEventBus,
  deps: WebhookDispatcherDeps,
): WebhookDispatcher {
  let total = 0;
  const deliver = deps.deliver ?? deliverWebhook;
  const now = deps.now;
  const onDeliveryError = deps.onDeliveryError ?? ((error, target) => {
    console.warn(`[murmur][webhooks] delivery ${target.id} failed:`, error);
  });

  const unsubscribe = events.subscribe((event) => {
    const fanout = publicWebhookFanoutEvent(event);
    if (!fanout) return;
    const targets = webhooksRepo.matchAgent(db, fanout.agent_slug);
    if (targets.length === 0) return;

    for (const target of targets) {
      total++;
      // Keep delivery invocation synchronous while containing both immediate
      // throws and rejected promises. An uncaught rejection here otherwise
      // reaches Node's unhandled-rejection policy and can take down the daemon
      // for a non-critical subscriber failure.
      let delivery: Promise<void> | void;
      try {
        delivery = deliver({
          db,
          target,
          event: fanout.event,
          deliveredAt: now(),
          dnsLookup: deps.urlDnsLookup,
          urlPolicy: deps.urlPolicy,
        });
      } catch (error) {
        onDeliveryError(error, target);
        continue;
      }
      void Promise.resolve(delivery).catch((error) => onDeliveryError(error, target));
    }
  });

  return {
    stop: unsubscribe,
    deliveryCount: () => total,
  };
}
