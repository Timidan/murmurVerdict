// ─── Privy inbound webhook verification (login-method transfer) ──────────────
// Verifies the raw JSON body + svix headers and normalizes `user.transferred_account`.
// DIDs come from event.fromUser.id / event.toUser.id. Pass the signing secret unchanged,
// `whsec_` prefix included. Dynamic import, as in privy.ts.

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

  // Cache the client, but drop a failed build so the next delivery retries.
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

      // Throws on bad signature / stale timestamp; the route maps that to 400.
      const event = client.webhooks().verify({
        payload: rawBodyUtf8,
        headers: {
          "svix-id": headers.svixId,
          "svix-timestamp": headers.svixTimestamp,
          "svix-signature": headers.svixSignature,
        },
      });

      if (event.type === "user.transferred_account") {
        // Validate at runtime: a signed payload with an empty DID must not reach reparent.
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
