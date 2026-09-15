import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";

import { agentsRepo } from "./repos/agents-repo.js";
import { getAccountForAgent } from "./auth/account-ownership.js";
import type {
  WebhookInsertRow,
  WebhookRow,
} from "./repos/webhooks-repo.js";
import { webhooksRepo } from "./repos/webhooks-repo.js";
import { SCHEMA_VERSION } from "./schema.js";
import { nowIso } from "./time.js";
import {
  validateWebhookUrl,
  type WebhookDnsLookup,
  type WebhookUrlPolicy,
} from "./webhook-url.js";

export const WEBHOOK_SIGNATURE_ALGORITHM = "sha256";
export const WEBHOOK_SIGNATURE_HEADER = "X-Murmur-Signature";
export const WEBHOOK_SECRET_HEADER = "X-Murmur-Webhook-Secret";
export const WEBHOOK_BODY_TO_SIGN = "raw request body";

export interface WebhookSubscriptionInput {
  agent_slug: string | null;
  url: string;
  newSubscriptionId?: () => string;
  newSubscriptionSecret?: () => string;
  now: () => Date;
}

export type PublicWebhookRow = Omit<WebhookRow, "secret">;

export interface RegisterWebhookSubscriptionInput {
  db: Database.Database;
  body: unknown;
  now: () => Date;
  newSubscriptionId?: () => string;
  newSubscriptionSecret?: () => string;
  urlPolicy: WebhookUrlPolicy;
  urlDnsLookup?: WebhookDnsLookup;
  /**
   * Verified caller account. When set, unknown and unowned slugs return the
   * same 403 so slug existence doesn't leak. Unit smokes may omit it, which
   * skips the ownership check.
   */
  auth?: { account_id: string };
}

export interface DeleteWebhookSubscriptionInput {
  db: Database.Database;
  id: string;
  providedSecret: string | undefined | null;
  secretEquals: (
    provided: string | undefined | null,
    expected: string | undefined | null,
  ) => boolean;
}

export interface LoadWebhookSubscriptionInput {
  db: Database.Database;
  id: string;
  providedSecret: string | undefined;
  secretEquals: (provided: string | undefined, stored: string) => boolean;
}

export const WEBHOOK_SUBSCRIPTION_CAP_PER_AGENT = 10;

export type RegisterWebhookSubscriptionResult =
  | {
      status: 201;
      body: {
        id: string;
        agent_slug: string | null;
        url: string;
        secret: string;
        created_at: string;
        verify_signature: ReturnType<typeof webhookVerificationInstructions>;
      };
    }
  | {
      status: 400 | 403 | 404 | 409;
      body: {
        code:
          | "invalid_url"
          | "unknown_agent"
          | "global_subscription_forbidden"
          | "subscription_cap_reached"
          | "forbidden";
        message: string;
      };
    };

export type DeleteWebhookSubscriptionResult =
  | { status: 204 }
  | {
      status: 403 | 404;
      body: {
        code: "forbidden" | "not_found";
        message: string;
      };
    };

export type LoadWebhookSubscriptionResult =
  | {
      status: 200;
      body: {
        schema_version: typeof SCHEMA_VERSION;
        webhook: PublicWebhookRow;
      };
    }
  | {
      status: 404;
      body: {
        code: "not_found";
        message: string;
      };
    }
  | {
      status: 403;
      body: {
        code: "forbidden";
        message: string;
      };
    };

export interface WebhookSubscriptionStatusJsonResponseTarget {
  status(code: number): { json(body: unknown): unknown };
}

export interface DeleteWebhookSubscriptionResponseTarget {
  status(code: number): {
    end(): unknown;
    json(body: unknown): unknown;
  };
}

export function sendWebhookSubscriptionJsonResponse(
  res: WebhookSubscriptionStatusJsonResponseTarget,
  result: RegisterWebhookSubscriptionResult | LoadWebhookSubscriptionResult,
): void {
  res.status(result.status).json(result.body);
}

export function sendDeleteWebhookSubscriptionResponse(
  res: DeleteWebhookSubscriptionResponseTarget,
  result: DeleteWebhookSubscriptionResult,
): void {
  if (result.status === 204) {
    res.status(204).end();
    return;
  }
  res.status(result.status).json(result.body);
}

export function makeWebhookSubscription(
  input: WebhookSubscriptionInput,
): WebhookInsertRow {
  return {
    id: (input.newSubscriptionId ?? randomUUID)(),
    agent_slug: input.agent_slug,
    url: input.url,
    secret: (input.newSubscriptionSecret ?? newWebhookSubscriptionSecret)(),
    created_at: nowIso(input.now()),
  };
}

export async function registerWebhookSubscription(
  input: RegisterWebhookSubscriptionInput,
): Promise<RegisterWebhookSubscriptionResult> {
  const body = webhookRegistrationBody(input.body);
  if (typeof body.url !== "string") {
    return invalidWebhookUrl("url must be a string");
  }
  if (body.url.length > 2048) {
    return invalidWebhookUrl("url too long");
  }

  // Cheap rejections run before the DNS lookup in validateWebhookUrl. The cap
  // pre-check is advisory; the transaction below re-checks it.
  let agentSlug: string;
  if (typeof body.agent_slug === "string" && body.agent_slug.length > 0) {
    agentSlug = body.agent_slug.slice(0, 64);
  } else {
    return {
      status: 400,
      body: {
        code: "global_subscription_forbidden",
        message:
          "agent_slug is required; global subscriptions are not accepted via this route",
      },
    };
  }

  // Authenticated: unknown and foreign slugs get the same 403, before the cap
  // check, so neither slug existence nor other accounts' cap state leaks.
  // Unauthenticated (unit smokes only; routes/webhooks.ts always passes auth)
  // keeps the 404 shape.
  //
  // bySlug is case-insensitive but webhook matching is case-sensitive, so
  // always swap in the canonical display_slug; otherwise "alice"/"Alice" could
  // exceed the cap and strand subscriptions fanout never matches.
  if (input.auth) {
    const agentRow = agentsRepo.bySlug(input.db, agentSlug);
    const owner = agentRow ? getAccountForAgent(input.db, agentRow.agent_id) : null;
    if (!agentRow || owner !== input.auth.account_id) {
      return {
        status: 403,
        body: {
          code: "forbidden",
          message: "agent_slug does not match authenticated account",
        },
      };
    }
    agentSlug = agentRow.display_slug;
  } else {
    const agentRow = agentsRepo.bySlug(input.db, agentSlug);
    if (!agentRow) {
      return {
        status: 404,
        body: { code: "unknown_agent", message: "agent_slug not found" },
      };
    }
    agentSlug = agentRow.display_slug;
  }
  const preCount = webhooksRepo.countActiveForAgentSlug(input.db, agentSlug);
  if (preCount >= WEBHOOK_SUBSCRIPTION_CAP_PER_AGENT) {
    return capReachedResult();
  }

  // SSRF/URL validation runs last because it does DNS. Must stay outside the
  // transaction: better-sqlite3 transactions are synchronous; an await breaks them.
  const validation = await validateWebhookUrl(body.url, input.urlPolicy, {
    dnsLookup: input.urlDnsLookup,
  });
  if (!validation.ok) {
    return invalidWebhookUrl(validation.reason);
  }

  const subscription = makeWebhookSubscription({
    agent_slug: agentSlug,
    url: validation.url,
    newSubscriptionId: input.newSubscriptionId,
    newSubscriptionSecret: input.newSubscriptionSecret,
    now: input.now,
  });

  // Re-check the cap inside a tx so a writer racing through the DNS window
  // can't exceed it. A competing writer may throw SQLITE_BUSY instead: recount,
  // and return 409 if the cap is now full, else re-throw.
  let committed: boolean;
  try {
    committed = input.db.transaction((): boolean => {
      const liveCount = webhooksRepo.countActiveForAgentSlug(input.db, agentSlug);
      if (liveCount >= WEBHOOK_SUBSCRIPTION_CAP_PER_AGENT) {
        return false;
      }
      webhooksRepo.insert(input.db, subscription);
      return true;
    })();
  } catch (err) {
    if (isSqliteBusy(err)) {
      const postCount = webhooksRepo.countActiveForAgentSlug(
        input.db,
        agentSlug,
      );
      if (postCount >= WEBHOOK_SUBSCRIPTION_CAP_PER_AGENT) {
        return capReachedResult();
      }
    }
    throw err;
  }

  if (!committed) {
    return capReachedResult();
  }

  return {
    status: 201,
    body: {
      id: subscription.id,
      agent_slug: subscription.agent_slug,
      url: subscription.url,
      secret: subscription.secret,
      created_at: subscription.created_at,
      verify_signature: webhookVerificationInstructions(),
    },
  };
}

function capReachedResult(): RegisterWebhookSubscriptionResult {
  return {
    status: 409,
    body: {
      code: "subscription_cap_reached",
      message: `agent already has ${WEBHOOK_SUBSCRIPTION_CAP_PER_AGENT} active webhook subscriptions; delete one before registering another`,
    },
  };
}

function isSqliteBusy(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  return code === "SQLITE_BUSY" || code === "SQLITE_BUSY_SNAPSHOT";
}

export function deleteWebhookSubscription(
  input: DeleteWebhookSubscriptionInput,
): DeleteWebhookSubscriptionResult {
  const row = webhooksRepo.byId(input.db, input.id);
  if (!row) {
    return {
      status: 404,
      body: { code: "not_found", message: "webhook not found" },
    };
  }
  if (!input.secretEquals(input.providedSecret, row.secret)) {
    return {
      status: 403,
      body: { code: "forbidden", message: "secret mismatch" },
    };
  }
  webhooksRepo.delete(input.db, input.id);
  return { status: 204 };
}

export function loadWebhookSubscription(
  input: LoadWebhookSubscriptionInput,
): LoadWebhookSubscriptionResult {
  const row = webhooksRepo.byId(input.db, input.id);
  if (!row) {
    return {
      status: 404,
      body: { code: "not_found", message: "webhook not found" },
    };
  }
  // Same secret DELETE requires: the row discloses its delivery URL and
  // failure counts.
  if (!input.secretEquals(input.providedSecret, row.secret)) {
    return {
      status: 403,
      body: { code: "forbidden", message: "webhook secret does not match" },
    };
  }
  return {
    status: 200,
    body: {
      schema_version: SCHEMA_VERSION,
      webhook: publicWebhookRow(row),
    },
  };
}

export function publicWebhookRow(row: WebhookRow): PublicWebhookRow {
  const { secret: _secret, ...publicRow } = row;
  void _secret;
  return publicRow;
}

export function webhookVerificationInstructions() {
  return {
    algorithm: WEBHOOK_SIGNATURE_ALGORITHM,
    header: WEBHOOK_SIGNATURE_HEADER,
    format: `${WEBHOOK_SIGNATURE_ALGORITHM}=<hex>`,
    body_to_sign: WEBHOOK_BODY_TO_SIGN,
  };
}

export function webhookSignatureHeader(args: {
  secret: string;
  rawBody: string;
}): string {
  return `${WEBHOOK_SIGNATURE_ALGORITHM}=${webhookSignatureHex(args)}`;
}

export function verifyWebhookSignature(args: {
  secret: string;
  rawBody: string;
  signatureHeader: string;
}): boolean {
  const expected = Buffer.from(webhookSignatureHex(args), "hex");
  const m = /^sha256=([0-9a-fA-F]{64})$/.exec(args.signatureHeader);
  if (!m) return false;
  const provided = Buffer.from(m[1], "hex");
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

function webhookSignatureHex(args: {
  secret: string;
  rawBody: string;
}): string {
  return createHmac(WEBHOOK_SIGNATURE_ALGORITHM, args.secret)
    .update(args.rawBody)
    .digest("hex");
}

function newWebhookSubscriptionSecret(): string {
  return randomBytes(24).toString("base64url");
}

function webhookRegistrationBody(body: unknown): { url?: unknown; agent_slug?: unknown } {
  return body && typeof body === "object"
    ? body as { url?: unknown; agent_slug?: unknown }
    : {};
}

function invalidWebhookUrl(message: string): RegisterWebhookSubscriptionResult {
  return {
    status: 400,
    body: { code: "invalid_url", message },
  };
}
