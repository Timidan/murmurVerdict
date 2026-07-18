import { request as requestHttp } from "node:http";
import { request as requestHttps } from "node:https";
import type { LookupFunction } from "node:net";
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
import {
  resolveWebhookDestination,
  type WebhookDestinationValidation,
  type WebhookDnsLookup,
  type WebhookUrlPolicy,
} from "./webhook-url.js";

export const WEBHOOK_DELIVERY_TIMEOUT_MS = 5_000;

export type WebhookDeliveryFetchResponse = OutboundJsonDeliveryFetchResponse;
export type WebhookDeliveryFetch = OutboundJsonDeliveryFetch;
export type WebhookDeliveryTimers = OutboundJsonDeliveryTimers;
type ResolvedWebhookDestination = Extract<WebhookDestinationValidation, { ok: true }>;

export type WebhookPinnedTransport = (
  destination: ResolvedWebhookDestination,
  url: string,
  init: RequestInit,
) => Promise<WebhookDeliveryFetchResponse>;

export interface WebhookDeliveryInput {
  db: Database.Database;
  target: WebhookRow;
  event: WebhookDeliverableEvent;
  fetch?: WebhookDeliveryFetch;
  /** DNS and transport hooks are injectable for deterministic security smokes. */
  dnsLookup?: WebhookDnsLookup;
  pinnedTransport?: WebhookPinnedTransport;
  urlPolicy?: WebhookUrlPolicy;
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
  const destination = await resolveWebhookDestination(
    input.target.url,
    input.urlPolicy ?? { allowHttp: false },
    { dnsLookup: input.dnsLookup },
  );
  const result = destination.ok
    ? await deliverOutboundJson({
        url: destination.url,
        body,
        headers: webhookDeliveryHeaders({
          target: input.target,
          event: input.event,
          body,
        }),
        timeoutMs: input.timeoutMs ?? WEBHOOK_DELIVERY_TIMEOUT_MS,
        fetch: input.fetch ?? ((url, init) =>
          (input.pinnedTransport ?? pinnedWebhookTransport)(destination, url, init)),
        timers: input.timers,
      })
    : {
        ok: false as const,
        status: null,
        error: destination.reason,
      };

  webhooksRepo.bumpDelivery(
    input.db,
    input.target.id,
    deliveredAt,
    result.status ?? 0,
    !result.ok,
  );
}

/**
 * Connect through a one-shot native HTTP(S) request whose DNS lookup is
 * replaced with the already validated public address. The URL hostname stays
 * intact for the Host header and TLS certificate/SNI checks.
 */
const pinnedWebhookTransport: WebhookPinnedTransport = async (
  destination,
  urlString,
  init,
) => {
  const url = new URL(urlString);
  const request = url.protocol === "https:" ? requestHttps : requestHttp;
  const lookup: LookupFunction = (_hostname, _options, callback) => {
    callback(null, destination.address, destination.family);
  };

  return new Promise<WebhookDeliveryFetchResponse>((resolve, reject) => {
    const req = request(
      url,
      {
        method: init.method ?? "POST",
        headers: init.headers as Record<string, string>,
        signal: init.signal ?? undefined,
        lookup,
        // Do not reuse a socket selected for a previous delivery; every
        // dispatch must use the address validated in this invocation.
        agent: false,
        ...(url.protocol === "https:" ? { servername: url.hostname } : {}),
      },
      (res) => {
        const status = res.statusCode ?? 0;
        // Delivery does not consume subscriber bodies. Drain without buffering
        // so a large response cannot amplify memory use.
        res.resume();
        res.once("end", () => {
          resolve({
            status,
            ok: status >= 200 && status < 300,
            text: async () => "",
          });
        });
        res.once("error", reject);
      },
    );
    req.once("error", reject);
    req.end(typeof init.body === "string" ? init.body : undefined);
  });
};

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
