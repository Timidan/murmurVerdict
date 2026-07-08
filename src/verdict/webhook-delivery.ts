import type Database from "better-sqlite3";

import {
  deliverOutboundJson,
  outboundJsonDeliveryRequest,
  type OutboundJsonDeliveryFetch,
  type OutboundJsonDeliveryFetchResponse,
  type OutboundJsonDeliveryTimers,
} from "./outbound-json-delivery.js";
import type { WebhookDeliverableEvent } from "./public-event-fanout.js";
import {
  webhooksRepo,
  type WebhookRow,
} from "./repos/webhooks-repo.js";
import { nowIso } from "./time.js";
import {
  WEBHOOK_SIGNATURE_HEADER,
  webhookSignatureHeader,
} from "./webhook-subscription.js";

export const WEBHOOK_DELIVERY_TIMEOUT_MS = 5_000;

export type WebhookDeliveryFetchResponse = OutboundJsonDeliveryFetchResponse;
export type WebhookDeliveryFetch = OutboundJsonDeliveryFetch;
export type WebhookDeliveryTimers = OutboundJsonDeliveryTimers;

export interface WebhookDeliveryInput {
  db: Database.Database;
  target: WebhookRow;
  event: WebhookDeliverableEvent;
  fetch?: WebhookDeliveryFetch;
  deliveredAt: Date;
  timeoutMs?: number;
  timers?: WebhookDeliveryTimers;
}

export interface WebhookDeliveryRequest {
  url: string;
  body: string;
  init: RequestInit;
}

export async function deliverWebhook(input: WebhookDeliveryInput): Promise<void> {
  const deliveredAt = nowIso(input.deliveredAt);
  const body = webhookDeliveryBody({
    event: input.event,
    deliveredAt,
  });
  const result = await deliverOutboundJson({
    url: input.target.url,
    body,
    headers: webhookDeliveryHeaders({
      target: input.target,
      event: input.event,
      body,
    }),
    timeoutMs: input.timeoutMs ?? WEBHOOK_DELIVERY_TIMEOUT_MS,
    fetch: input.fetch,
    timers: input.timers,
  });

  webhooksRepo.bumpDelivery(
    input.db,
    input.target.id,
    deliveredAt,
    result.status ?? 0,
    !result.ok,
  );
}

export function webhookDeliveryRequest(input: {
  target: WebhookRow;
  event: WebhookDeliverableEvent;
  deliveredAt: string;
  signal: AbortSignal;
}): WebhookDeliveryRequest {
  const body = webhookDeliveryBody({
    event: input.event,
    deliveredAt: input.deliveredAt,
  });
  return outboundJsonDeliveryRequest({
    url: input.target.url,
    body,
    headers: webhookDeliveryHeaders({
      target: input.target,
      event: input.event,
      body,
    }),
    signal: input.signal,
  });
}

export function webhookDeliveryHeaders(input: {
  target: WebhookRow;
  event: WebhookDeliverableEvent;
  body: string;
}): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "User-Agent": "murmur-verdict-webhook/0.1",
    "X-Murmur-Webhook-Id": input.target.id,
    "X-Murmur-Event": input.event.type,
    [WEBHOOK_SIGNATURE_HEADER]: webhookSignatureHeader({
      secret: input.target.secret,
      rawBody: input.body,
    }),
  };
}

function webhookDeliveryBody(input: {
  event: WebhookDeliverableEvent;
  deliveredAt: string;
}): string {
  return JSON.stringify({
    schema_version: 1,
    delivered_at: input.deliveredAt,
    event: input.event,
  });
}
