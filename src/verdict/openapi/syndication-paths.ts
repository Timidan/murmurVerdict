import type { OpenApiPathMap } from "./types.js";

export function syndicationOpenApiPaths(): OpenApiPathMap {
  return {
    "/v1/refs/{ref}/click": {
      post: {
        tags: ["outreach"],
        summary: "Bump the click counter for a sender (called by the share page).",
        parameters: [{ name: "ref", in: "path", required: true, schema: { type: "string", maxLength: 32 } }],
        requestBody: { content: { "application/json": { schema: { type: "object", properties: { agent_slug: { type: "string" } } } } } },
        responses: { "204": { description: "Counted" } },
      },
    },
    "/v1/refs/top": {
      get: {
        tags: ["outreach"],
        summary: "Top senders across all agents.",
        parameters: [{ name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 50, default: 20 } }],
        responses: { "200": { description: "Senders ranked by clicks × agents touched" } },
      },
    },
    "/v1/webhooks": {
      post: {
        tags: ["stream"],
        summary:
          "Subscribe a URL to call.accepted / call.resolved events for one of the authenticated account's agents. agent_slug is required and must be owned by the caller (global all-agents subscriptions are not accepted via this route).",
        security: [{ privyAuth: [] }, { apiKeyAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["url", "agent_slug"],
                properties: {
                  url: { type: "string", format: "uri" },
                  agent_slug: {
                    type: "string",
                    description:
                      "Slug of one of the authenticated account's agents. Comparison is case-insensitive; the canonical case is stored.",
                  },
                },
              },
            },
          },
        },
        responses: {
          "201": {
            description:
              "Subscription created. Response includes the one-time secret used to sign deliveries — store it (it is not retrievable later).",
          },
          "400": {
            description:
              "`invalid_url` (URL parse failed or host rejected by SSRF policy) or `global_subscription_forbidden` (agent_slug missing or empty).",
          },
          "401": {
            description:
              "Missing or invalid `Authorization: Bearer <privy>` and `X-Murmur-Api-Key`. Runtime Keys are rejected for this route (`agent_not_authorized`).",
          },
          "403": {
            description:
              "agent_slug does not match the authenticated account. Unknown slugs and unowned slugs collapse into this same response (`forbidden`) so existence is not leaked.",
          },
          "409": {
            description:
              "Per-agent active-subscription cap reached (`subscription_cap_reached`).",
          },
          "429": {
            description:
              "Rate limited. Two-stage limiter: 30 reqs/hr per source IP pre-auth, 10 reqs/hr per authenticated account post-auth.",
          },
        },
      },
    },
    "/v1/webhooks/{id}": {
      get: {
        tags: ["stream"],
        summary: "Inspect a subscription (no secret returned).",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: { "200": { description: "WebhookRow without secret" }, "404": { description: "Unknown id" } },
      },
      delete: {
        tags: ["stream"],
        summary: "Unsubscribe. Requires the secret returned at creation in the X-Murmur-Webhook-Secret header.",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          {
            name: "X-Murmur-Webhook-Secret",
            in: "header",
            required: true,
            schema: { type: "string" },
            description:
              "The one-time secret returned in the POST /v1/webhooks 201 response. Owner-of-secret proves authority to delete.",
          },
        ],
        responses: { "204": { description: "Unsubscribed" }, "403": { description: "Secret mismatch" }, "404": { description: "Unknown id" } },
      },
    },
    "/v1/badge/{slug}.svg": {
      get: {
        tags: ["embed"],
        summary: "Live SVG badge — Nothing-canonical, 320×80, 30s ETag-cached.",
        parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "SVG", content: { "image/svg+xml": {} } } },
      },
    },
    "/v1/badge/{slug}.png": {
      get: {
        tags: ["embed"],
        summary: "Live PNG badge — same layout as SVG, 640px wide.",
        parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "PNG", content: { "image/png": {} } } },
      },
    },
    "/v1/og/{slug}.svg": {
      get: {
        tags: ["embed"],
        summary: "Social card SVG — 1200×630, 120s ETag-cached.",
        parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "SVG", content: { "image/svg+xml": {} } } },
      },
    },
    "/v1/og/{slug}.png": {
      get: {
        tags: ["embed"],
        summary: "Social card PNG — for X/Discord/Slack OG previews.",
        parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "PNG", content: { "image/png": {} } } },
      },
    },
    "/share/{slug}": {
      get: {
        tags: ["embed"],
        summary: "OG-meta interceptor for hash-routed SPA. Renders proper og:image + redirects to dashboard share page.",
        parameters: [
          { name: "slug", in: "path", required: true, schema: { type: "string" } },
          { name: "ref", in: "query", schema: { type: "string", maxLength: 32 } },
          { name: "dashboard", in: "query", schema: { type: "string", format: "uri" } },
        ],
        responses: { "200": { description: "HTML with og:image meta + meta-refresh" } },
      },
    },
    "/embed.js": {
      get: {
        tags: ["embed"],
        summary: "Drop-in JS that installs a live badge wherever the script tag sits.",
        responses: { "200": { description: "JavaScript", content: { "application/javascript": {} } } },
      },
    },
    "/v1/stream": {
      get: {
        tags: ["stream"],
        summary: "Server-Sent Events fan-out: leaderboard.update, call.accepted, call.resolved, stats.tick.",
        responses: { "200": { description: "text/event-stream", content: { "text/event-stream": {} } } },
      },
    },
  };
}
