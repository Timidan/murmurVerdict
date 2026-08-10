import type { OpenApiPathMap } from "./types.js";

export function adminOpenApiPaths(): OpenApiPathMap {
  return {
    "/v1/admin/fhenix/backfill/calls": {
      post: {
        tags: ["admin"],
        summary: "Admin-only verified Fhenix submit-event metadata backfill.",
        description:
          "Operator recovery route for indexing a Fhenix submit event that already exists onchain. Requires X-Admin-Token and X-Murmur-Agent-Slug. Agents must use /v2/gateway/calls.",
        responses: {
          "200": { description: "Idempotent hit" },
          "201": { description: "Backfilled sealed call metadata" },
          "400": { description: "Schema invalid or Fhenix event mismatch" },
          "403": { description: "Admin token required" },
          "404": { description: "Agent or market not found" },
          "409": { description: "Duplicate or conflicting event" },
        },
      },
    },
    "/v1/admin/fhenix/backfill/feeds/{feed_id}/packets": {
      post: {
        tags: ["admin"],
        summary: "Admin-only TRUSTED feed-packet metadata backfill (unverified).",
        description:
          "Operator recovery route for indexing a Fhenix feed packet. The " +
          "supplied event metadata is INGESTED AS GIVEN — this route performs " +
          "no receipt, log, address or chain verification, so what it records " +
          "is exactly as trustworthy as the admin token and the operator " +
          "typing it. It can fulfil an SLA incident, so a mistake here " +
          "publishes delivery evidence for a packet that may not exist. It " +
          "was previously described as 'verified', which it has never been. " +
          "Agents must use /v2/gateway/feeds/{feed_id}/packets.",
        parameters: [{ name: "feed_id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "503": {
            description:
              "Feed acceptance is off: MURMUR_ACK_FEED_REVEAL_MANUAL is not set. " +
              "Murmur has no feed reveal path, so a packet recorded here could " +
              "never be revealed.",
          },
          "200": { description: "Idempotent hit" },
          "201": { description: "Backfilled feed packet metadata" },
          "400": { description: "Schema invalid or market outside feed coverage" },
          "403": { description: "Admin token required" },
          "404": { description: "Feed or market not found" },
          "409": { description: "Retired feed or duplicate packet" },
        },
      },
    },
    "/v1/admin/fhenix/reveals": {
      post: {
        tags: ["calls"],
        summary: "Admin/indexer hook for verified Fhenix reveal events.",
        description:
          "Verifies and attaches the post-horizon public binary outcome index/confidence reveal to a sealed_fhenix call. This route is bearer-admin only; agents do not call it directly.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: [
                  "call_id",
                  "binary_index",
                  "confidence_bps",
                  "revealed_at",
                  "reveal_tx_hash",
                  "reveal_log_index",
                ],
                properties: {
                  call_id: { type: "string", format: "uuid" },
                  binary_index: { type: "integer", enum: [0, 1] },
                  confidence_bps: { type: "integer", minimum: 5100, maximum: 9500 },
                  revealed_at: { type: "string", format: "date-time" },
                  reveal_tx_hash: { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" },
                  reveal_log_index: { type: "integer", minimum: 0 },
                },
                additionalProperties: false,
              },
            },
          },
        },
        responses: {
          "200": { description: "Reveal attached or idempotent hit" },
          "400": { description: "Schema invalid or reveal before reveal_open_at" },
          "403": { description: "Admin bearer token required" },
          "404": { description: "Call not found" },
          "409": { description: "Call is not sealed_fhenix or reveal conflicts" },
        },
      },
    },
    "/v1/admin/fhenix/invalid-reveals": {
      post: {
        tags: ["calls"],
        summary: "Admin/indexer hook for verified invalid Fhenix reveal events.",
        description:
          "Verifies and terminalizes a Fhenix reveal whose decrypted values are public but outside Murmur's scoring domain. Invalid reveals do not create market-score rows.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: [
                  "call_id",
                  "binary_index",
                  "confidence_bps",
                  "invalid_reason",
                  "revealed_at",
                  "reveal_tx_hash",
                  "reveal_log_index",
                ],
                properties: {
                  call_id: { type: "string", format: "uuid" },
                  binary_index: { type: "integer", minimum: 0, maximum: 255 },
                  confidence_bps: { type: "integer", minimum: 0, maximum: 65535 },
                  invalid_reason: { type: "string", enum: ["binary_index", "confidence", "unknown"] },
                  revealed_at: { type: "string", format: "date-time" },
                  reveal_tx_hash: { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" },
                  reveal_log_index: { type: "integer", minimum: 0 },
                },
                additionalProperties: false,
              },
            },
          },
        },
        responses: {
          "200": { description: "Invalid reveal attached or idempotent hit" },
          "400": { description: "Schema invalid or reveal before reveal_open_at" },
          "403": { description: "Admin bearer token required" },
          "404": { description: "Call not found" },
          "409": { description: "Call is not sealed_fhenix or reveal conflicts" },
        },
      },
    },
    "/v1/admin/fhenix/lifecycle": {
      get: {
        tags: ["admin"],
        summary: "Admin Fhenix reveal lifecycle monitoring: status counts, overdue reveals, watcher cursors, and recent terminal rows.",
        parameters: [
          { name: "status", in: "query", schema: { type: "string", enum: ["pending", "revealed", "invalid", "missed"] } },
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } },
          { name: "grace_sec", in: "query", schema: { type: "integer", minimum: 0, default: 3600 } },
        ],
        responses: {
          "200": { description: "Reveal lifecycle operator snapshot" },
          "400": { description: "Invalid status, limit, or grace query" },
          "403": { description: "Admin token required" },
          "503": { description: "Admin token not configured" },
        },
      },
    },
    "/v1/admin/fhenix/gateway": {
      get: {
        tags: ["calls"],
        summary: "Admin Fhenix Gateway relayer health, queue, gas/RPC telemetry, retry, and stuck-attempt view for sealed calls and feed packets.",
        parameters: [
          { name: "status", in: "query", schema: { type: "string", enum: ["queued", "submitted", "confirmed", "accepted", "failed_retryable", "failed_terminal"] } },
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } },
          { name: "stuck_after_sec", in: "query", schema: { type: "integer", minimum: 60, default: 600 } },
        ],
        responses: {
          "200": { description: "Gateway operator snapshot with queue, stuck-attempt, receipt, gas, latency, confirmation, and RPC-error telemetry" },
          "403": { description: "Admin token required" },
          "503": { description: "Admin token not configured" },
        },
      },
    },
    "/v1/admin/fhenix/gateway/tick": {
      post: {
        tags: ["calls"],
        summary: "Admin-trigger one Gateway worker tick for queued broadcasts, confirmations, and acceptance indexing.",
        responses: {
          "200": { description: "Tick result plus fresh operator snapshot" },
          "403": { description: "Admin token required" },
          "503": { description: "Gateway broadcaster or admin token not configured" },
        },
      },
    },
    "/v1/admin/fhenix/gateway/attempts/{attempt_id}/retry": {
      post: {
        tags: ["calls"],
        summary: "Admin-trigger an immediate retry for a queued or retryable Fhenix Gateway attempt.",
        parameters: [{ name: "attempt_id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": { description: "Attempt accepted by a previous retry" },
          "202": { description: "Retry submitted or queued again" },
          "403": { description: "Admin token required" },
          "404": { description: "Unknown attempt" },
          "409": { description: "Attempt status is not safely retryable" },
          "503": { description: "Gateway broadcaster or admin token not configured" },
        },
      },
    },
    "/v1/admin/canaries": {
      get: {
        tags: ["admin"],
        summary: "Admin live canary snapshot for Fhenix RPC/contract reachability and Polymarket Gamma live data.",
        responses: {
          "200": { description: "Latest cached canary snapshot" },
          "403": { description: "Admin token required" },
          "503": { description: "Admin token or live canary runner not configured" },
        },
      },
    },
    "/v1/admin/canaries/tick": {
      post: {
        tags: ["admin"],
        summary: "Admin-trigger immediate live canary checks.",
        responses: {
          "200": { description: "Fresh canary snapshot" },
          "403": { description: "Admin token required" },
          "503": { description: "Admin token or live canary runner not configured" },
        },
      },
    },
    "/v1/admin/alerts": {
      get: {
        tags: ["admin"],
        summary: "Admin operator alerts for Gateway, Fhenix lifecycle, live canaries, feed SLA, and identity health.",
        parameters: [
          { name: "status", in: "query", schema: { type: "string", enum: ["open", "resolved"] } },
          { name: "source", in: "query", schema: { type: "string" } },
          { name: "delivery_status", in: "query", schema: { type: "string", enum: ["pending", "delivered", "failed"] } },
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 500, default: 100 } },
        ],
        responses: {
          "200": { description: "Operator alert snapshot" },
          "400": { description: "Invalid status, delivery_status, or limit" },
          "403": { description: "Admin token required" },
          "503": { description: "Admin token not configured" },
        },
      },
    },
    "/v1/admin/alerts/tick": {
      post: {
        tags: ["admin"],
        summary: "Admin-trigger operator alert scan and optional webhook delivery.",
        description:
          "Persists deduplicated operator alerts and, when MURMUR_OPERATOR_ALERT_WEBHOOK_URL is configured, POSTs pending alerts to the operator sink. This is admin/operator plumbing only and does not touch payment rails.",
        responses: {
          "200": { description: "Scan, delivery result, and fresh alert snapshot" },
          "400": { description: "Schema invalid" },
          "403": { description: "Admin token required" },
          "503": { description: "Admin token not configured" },
        },
      },
    },
    "/v1/admin/identity/controllers": {
      get: {
        tags: ["admin"],
        summary: "Admin Controller Wallet re-attestation health for agent identity non-transferability.",
        parameters: [
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } },
          { name: "due_soon_hours", in: "query", schema: { type: "integer", minimum: 1, maximum: 720, default: 24 } },
        ],
        responses: {
          "200": { description: "Controller Wallet identity health snapshot" },
          "403": { description: "Admin token required" },
          "503": { description: "Admin token not configured" },
        },
      },
    },
    "/v1/admin/feeds/sla": {
      get: {
        tags: ["feeds"],
        summary: "Admin list of long-running feed SLA incidents.",
        parameters: [
          { name: "feed_id", in: "query", schema: { type: "string", format: "uuid" } },
          { name: "status", in: "query", schema: { type: "string", enum: ["open", "fulfilled_late"] } },
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 500, default: 100 } },
        ],
        responses: {
          "200": { description: "Feed SLA incident list plus feed health/proof-hash summaries and refund/slash recommendations" },
          "400": { description: "Invalid status or limit" },
          "403": { description: "Admin token required" },
          "503": { description: "Admin token not configured" },
        },
      },
    },
    "/v1/admin/feeds/sla/tick": {
      post: {
        tags: ["feeds"],
        summary: "Admin-trigger one feed SLA tick to record missed cadence packets.",
        description:
          "Records missed-packet incidents for listed cadence feeds after deadline plus grace. This creates reliability/refund/slash recommendations only; it does not execute payment refunds.",
        responses: {
          "200": { description: "Tick result plus current open incidents" },
          "400": { description: "Schema invalid" },
          "403": { description: "Admin token required" },
          "503": { description: "Admin token not configured" },
        },
      },
    },
  };
}
