// ─── Privy inbound webhook verification (Login method transfer) ──────────────
//
// Privy's "Login method transfer" (dashboard: Users → transfer login method)
// fires a signed `user.transferred_account` webhook and DELETES the source
// Privy user. This adapter receives the raw request body + svix headers, runs
// them through the official @privy-io/node SDK's svix signature check, and
// normalizes the one event Murmur cares about into a tiny transfer descriptor.
//
// SDK shape (verified against @privy-io/node@0.18.0 in this worktree — see
// node_modules/@privy-io/node/public-api/services/webhooks.d.ts and
// node_modules/@privy-io/node/public-api/PrivyClient.d.ts):
//
//   const privy = new PrivyClient({ appId, appSecret, webhookSigningSecret });
//   const event = privy.webhooks().verify({
//     payload: rawBodyUtf8String,            // MUST be the raw JSON string
//     headers: {                             // svix headers, unchanged casing
//       "svix-id": ...,
//       "svix-timestamp": ...,
//       "svix-signature": ...,
//     },
//   });
//   // throws InvalidWebhookError on bad signature / stale timestamp
//   //   (svix enforces a 5-minute timestamp tolerance)
//   // event: WebhookPayload (a discriminated union on `type`).
//
// For a transfer the payload is UserTransferredAccountWebhookPayload:
//   { type: "user.transferred_account", account, deletedUser: true,
//     fromUser: { id }, toUser: User }
// We read event.fromUser.id (source DID) and event.toUser.id (destination DID).
// There is NO `transferred_account` field.
//
// Signing secret: the dashboard endpoint secret is `whsec_<base64>`. Pass it
// UNCHANGED — the SDK's svix.Webhook strips the `whsec_` prefix and base64-
// decodes internally. Do not pre-strip or pre-decode it here.
//
// Dynamic import: mirrors auth/privy.ts. Keeping @privy-io/node (and its
// hpke / jose / svix transitive deps) out of the static import graph means a
// deploy that never enables the transfer receiver doesn't pay to load them.

import type { PrivyClient as PrivyClientType } from "@privy-io/node";

/** Normalized non-transfer event. Route turns this into a 204 no-op. */
export interface PrivyWebhookOtherEvent {
  type: "other";
}

/** Normalized `user.transferred_account` event carrying both Privy DIDs. */
export interface PrivyWebhookTransferEvent {
  type: "user.transferred_account";
  fromPrivyUserId: string;
  toPrivyUserId: string;
}

export type PrivyWebhookEvent =
  | PrivyWebhookTransferEvent
  | PrivyWebhookOtherEvent;

export interface PrivyWebhookVerifier {
  /** True only when appId + appSecret + signingSecret are all present. */
  enabled(): boolean;
  /**
   * Verify the svix signature and normalize the payload. Returns the transfer
   * descriptor for `user.transferred_account`, or `{ type: "other" }` for any
   * other event type. THROWS on a bad signature / stale timestamp, or when a
   * transfer payload is missing a non-empty fromUser.id / toUser.id.
   */
  verify(
    rawBodyUtf8: string,
    headers: {
      svixId: string;
      svixTimestamp: string;
      svixSignature: string;
    },
  ): Promise<PrivyWebhookEvent>;
}

export interface PrivyWebhookVerifierConfig {
  appId?: string | null;
  appSecret?: string | null;
  signingSecret?: string | null;
}

export function createPrivyWebhookVerifier(
  cfg: PrivyWebhookVerifierConfig,
): PrivyWebhookVerifier {
  const enabled = (): boolean =>
    Boolean(cfg.appId && cfg.appSecret && cfg.signingSecret);

  // Cache the constructed client. A rejected build is NOT cached permanently:
  // we null the promise on failure so the next delivery retries construction
  // (e.g. a transiently-unresolvable dynamic import) rather than wedging the
  // receiver into a permanent 400 loop.
  let clientPromise: Promise<PrivyClientType> | null = null;

  const buildClient = (): Promise<PrivyClientType> => {
    if (!clientPromise) {
      clientPromise = (async () => {
        const mod = (await import("@privy-io/node")) as {
          PrivyClient: typeof PrivyClientType;
        };
        return new mod.PrivyClient({
          appId: cfg.appId as string,
          appSecret: cfg.appSecret as string,
          webhookSigningSecret: cfg.signingSecret as string,
        });
      })().catch((err: unknown) => {
        clientPromise = null;
        throw err;
      });
    }
    return clientPromise;
  };

  return {
    enabled,
    async verify(rawBodyUtf8, headers): Promise<PrivyWebhookEvent> {
      const client = await buildClient();

      // Throws InvalidWebhookError on bad signature / stale timestamp. We let
      // that propagate — the route maps a throw to HTTP 400.
      const event = client.webhooks().verify({
        payload: rawBodyUtf8,
        headers: {
          "svix-id": headers.svixId,
          "svix-timestamp": headers.svixTimestamp,
          "svix-signature": headers.svixSignature,
        },
      });

      if (event.type === "user.transferred_account") {
        // Runtime-validate the two DIDs even though the SDK types them — a
        // signature-valid but structurally-degenerate payload must not reach
        // the reparent core with an empty DID.
        const fromPrivyUserId = event.fromUser?.id;
        const toPrivyUserId = event.toUser?.id;
        if (typeof fromPrivyUserId !== "string" || fromPrivyUserId.length === 0) {
          throw new Error(
            "privy webhook: user.transferred_account missing fromUser.id",
          );
        }
        if (typeof toPrivyUserId !== "string" || toPrivyUserId.length === 0) {
          throw new Error(
            "privy webhook: user.transferred_account missing toUser.id",
          );
        }
        return { type: "user.transferred_account", fromPrivyUserId, toPrivyUserId };
      }

      return { type: "other" };
    },
  };
}
