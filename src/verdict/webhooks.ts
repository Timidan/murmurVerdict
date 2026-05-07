// Webhook dispatch — subscribes to the in-process VerdictEventBus and
// fires HTTP POST to every matching subscription on call.accepted /
// call.resolved. Each delivery is signed HMAC-SHA256(secret, body) and
// carries an X-Murmur-Signature header subscribers can verify.
//
// No retries in v0.1. Failures bump failure_count so the operator can
// see them via GET /v1/webhooks/:id; sustained failures should be
// handled out-of-band (disable the row, talk to the subscriber).

import { createHmac, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";
import { webhooksRepo, type WebhookRow } from "./db.js";
import type { VerdictEvent, VerdictEventBus } from "./events.js";

const DELIVERY_TIMEOUT_MS = 5_000;

export interface WebhookDispatcher {
  stop(): void;
  deliveryCount: () => number;
}

export function startWebhookDispatcher(
  db: Database.Database,
  events: VerdictEventBus,
): WebhookDispatcher {
  let total = 0;

  const unsubscribe = events.subscribe((event) => {
    // We only fan out per-agent events. stats.tick / leaderboard.update are
    // SSE-only — pushing them to every webhook would be loud and useless.
    if (event.type !== "call.accepted" && event.type !== "call.resolved") return;
    const targets = webhooksRepo.matchAgent(db, event.agent_slug);
    if (targets.length === 0) return;

    for (const target of targets) {
      total++;
      void deliver(db, target, event);
    }
  });

  return {
    stop: unsubscribe,
    deliveryCount: () => total,
  };
}

async function deliver(
  db: Database.Database,
  target: WebhookRow,
  event: VerdictEvent,
): Promise<void> {
  const body = JSON.stringify({
    schema_version: 1,
    delivered_at: nowIso(),
    event,
  });
  const signature = createHmac("sha256", target.secret).update(body).digest("hex");

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), DELIVERY_TIMEOUT_MS);

  let status = 0;
  let failed = false;
  try {
    const res = await fetch(target.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "murmur-verdict-webhook/0.1",
        "X-Murmur-Webhook-Id": target.id,
        "X-Murmur-Event": event.type,
        "X-Murmur-Signature": `sha256=${signature}`,
      },
      body,
      signal: ac.signal,
    });
    status = res.status;
    failed = !res.ok;
    // Drain the body so the connection can be reused / closed cleanly.
    await res.text().catch(() => "");
  } catch {
    failed = true;
  } finally {
    clearTimeout(t);
  }

  webhooksRepo.bumpDelivery(db, target.id, nowIso(), status, failed);
}

/**
 * Constant-time HMAC verification helper exported for tests / docs.
 * Subscribers should run this against the X-Murmur-Signature header.
 */
export function verifyWebhookSignature(args: {
  secret: string;
  rawBody: string;
  signatureHeader: string;
}): boolean {
  const expected = createHmac("sha256", args.secret).update(args.rawBody).digest();
  const m = /^sha256=([0-9a-fA-F]{64})$/.exec(args.signatureHeader);
  if (!m) return false;
  const provided = Buffer.from(m[1], "hex");
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}
