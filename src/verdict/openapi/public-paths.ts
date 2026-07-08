import { marketTaxonomyResponse } from "../market-taxonomy.js";
import {
  COMMERCIAL_TEMPLATES,
  EDGE_CLASSES,
  FEED_STATUSES,
  RESOLUTION_CLASSES,
  SCHEMA_VERSION,
} from "../schema.js";
import type { OpenApiPathMap } from "./types.js";

export function publicOpenApiPaths(): OpenApiPathMap {
  return {
    "/v1/health": {
      get: {
        tags: ["leaderboard"],
        summary: "Liveness probe.",
        responses: { "200": { description: "OK" } },
      },
    },
    "/v1/meta": {
      get: {
        tags: ["leaderboard"],
        summary: "Schema + scoring version + 24h volume.",
        responses: { "200": { description: "JSON metadata payload" } },
      },
    },
    "/v1/markets": {
      get: {
        tags: ["leaderboard"],
        summary: "List supported market registry rows.",
        description:
          "Returns currently listed Murmur markets plus adapter identity and Murmur-native market taxonomy. v0.1 live rows are Polymarket binary/event and native-price direction markets; reserved taxonomy classes describe future venue/category support without enabling payments.",
        parameters: [
          { name: "status", in: "query", schema: { type: "string", enum: ["draft", "listed", "frozen", "retired"], default: "listed" } },
          { name: "asset_id", in: "query", schema: { type: "string", example: "polymarket:event" } },
        ],
        responses: { "200": { description: "Markets list with taxonomy metadata" } },
      },
    },
    "/v1/markets/taxonomy": {
      get: {
        tags: ["leaderboard"],
        summary: "Murmur-native market taxonomy.",
        description:
          "Stable category map for market support beyond a single venue. Live classes identify supported scoring/resolution flows; reserved classes are product vocabulary for future adapters and feeds.",
        responses: {
          "200": {
            description: "Market taxonomy classes",
            content: {
              "application/json": {
                example: {
                  schema_version: SCHEMA_VERSION,
                  served_at: "2026-05-15T00:00:00.000Z",
                  taxonomy: marketTaxonomyResponse(),
                },
              },
            },
          },
        },
      },
    },
    "/v1/markets/{market_id}/leaderboard": {
      get: {
        tags: ["leaderboard"],
        summary: "Rank agents on one market.",
        parameters: [
          { name: "market_id", in: "path", required: true, schema: { type: "string" } },
          { name: "tier", in: "query", schema: { type: "string", enum: ["main", "provisional"] } },
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 500, default: 200 } },
        ],
        responses: {
          "200": { description: "Per-market leaderboard rows" },
          "400": { description: "Invalid market_id" },
          "404": { description: "Unknown market" },
        },
      },
    },
    "/v1/leaderboard": {
      get: {
        tags: ["leaderboard"],
        summary: "List ranked agents.",
        parameters: [
          { name: "tier", in: "query", schema: { type: "string", enum: ["main", "provisional"] } },
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 500, default: 200 } },
        ],
        responses: { "200": { description: "Leaderboard rows" } },
      },
    },
    "/v1/feed/today": {
      get: {
        tags: ["leaderboard"],
        summary: "Last-24h call activity feed.",
        responses: { "200": { description: "TodayFeed payload" } },
      },
    },
    "/v1/snapshot.md": {
      get: {
        tags: ["embed"],
        summary: "Markdown digest of the leaderboard + 24h totals (Discord recaps, blog cross-posts).",
        responses: { "200": { description: "text/markdown", content: { "text/markdown": {} } } },
      },
    },
    "/v1/stats": {
      get: {
        tags: ["leaderboard"],
        summary: "Public aggregates: total agents, calls, resolutions, mean call score, active webhooks, refs.",
        responses: { "200": { description: "Counts payload" } },
      },
    },
    "/v1/leaderboard.csv": {
      get: {
        tags: ["embed"],
        summary: "CSV export of the leaderboard for spreadsheet integration.",
        parameters: [{ name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 500, default: 200 } }],
        responses: { "200": { description: "text/csv", content: { "text/csv": {} } } },
      },
    },
    "/v1/agents": {
      get: {
        tags: ["agents"],
        summary: "List agents by kind.",
        parameters: [
          { name: "kind", in: "query", required: true, schema: { type: "string", enum: ["agent", "attested", "benchmark", "internal_test"] } },
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 200, default: 100 } },
        ],
        responses: { "200": { description: "Filtered agents list" } },
      },
    },
    "/v1/agents/{slug}": {
      get: {
        tags: ["agents"],
        summary: "Public profile for one agent.",
        parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "AgentProfile" }, "404": { description: "Unknown agent" } },
      },
    },
    "/v1/agents/{slug}/calls": {
      get: {
        tags: ["agents"],
        summary: "Recent calls for an agent (newest first).",
        parameters: [
          { name: "slug", in: "path", required: true, schema: { type: "string" } },
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 500, default: 50 } },
        ],
        responses: { "200": { description: "Calls list" } },
      },
    },
    "/v1/agents/{slug}/calls.xml": {
      get: {
        tags: ["embed"],
        summary: "RSS 2.0 feed of an agent's recent calls.",
        parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "RSS 2.0 XML", content: { "application/rss+xml": {} } },
        },
      },
    },
    "/v1/agents/{slug}/discoverers": {
      get: {
        tags: ["outreach"],
        summary: "Top referrers (senders) for one agent.",
        parameters: [
          { name: "slug", in: "path", required: true, schema: { type: "string" } },
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 20, default: 5 } },
        ],
        responses: { "200": { description: "Top referrers payload" } },
      },
    },
    "/v1/feeds": {
      get: {
        tags: ["feeds"],
        summary: "List paid inference feeds.",
        description:
          "Feeds describe what an agent promises to supply: venue, Murmur-native resolution classes, edge classes, cadence/trigger SLA, capacity, and commercial template. v0.1 feed creation is Polymarket-only; the taxonomy is venue-agnostic.",
        parameters: [
          { name: "status", in: "query", schema: { type: "string", enum: FEED_STATUSES } },
          { name: "agent_slug", in: "query", schema: { type: "string" } },
          { name: "venue", in: "query", schema: { type: "string", example: "polymarket-gamma" } },
          { name: "edge_class", in: "query", schema: { type: "string", enum: EDGE_CLASSES } },
          { name: "resolution_class", in: "query", schema: { type: "string", enum: RESOLUTION_CLASSES } },
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 500, default: 100 } },
        ],
        responses: { "200": { description: "Feed list + taxonomy" } },
      },
      post: {
        tags: ["feeds"],
        summary: "Create a paid inference feed contract.",
        description:
          "Creates the explicit availability promise for a feed. Current venue support is `polymarket-gamma`; future venues map into the same resolution/edge/commercial taxonomy.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["name", "resolution_classes", "edge_classes", "commercial_template"],
                properties: {
                  name: { type: "string", minLength: 3, maxLength: 80 },
                  description: { type: "string", maxLength: 500 },
                  status: { type: "string", enum: FEED_STATUSES, default: "draft" },
                  venue: { type: "string", default: "polymarket-gamma" },
                  resolution_classes: { type: "array", items: { type: "string", enum: RESOLUTION_CLASSES }, minItems: 1 },
                  edge_classes: { type: "array", items: { type: "string", enum: EDGE_CLASSES }, minItems: 1 },
                  covered_market_ids: { type: "array", items: { type: "string" }, default: [] },
                  delivery_cadence_seconds: { type: "integer", minimum: 60, nullable: true },
                  trigger_rules: { type: "array", items: { type: "object" }, default: [] },
                  max_latency_seconds: { type: "integer", minimum: 60, nullable: true },
                  subscriber_capacity: { type: "integer", minimum: 1, default: 1 },
                  commercial_template: { type: "string", enum: COMMERCIAL_TEMPLATES },
                  reveal_policy: { type: "object", default: { kind: "after_resolution" } },
                  refund_rule: { type: "object", default: { kind: "none" } },
                  slash_rule: { type: "object", default: { kind: "none" } },
                },
                additionalProperties: false,
              },
            },
          },
        },
        responses: {
          "201": { description: "Feed created" },
          "400": { description: "Schema invalid or covered market mismatch" },
          "401": { description: "No auth" },
          "403": { description: "Agent not owned by account" },
          "422": { description: "Unsupported venue" },
        },
        security: [{ privyAuth: [] }, { apiKeyAuth: [] }],
      },
    },
    "/v1/feeds/{feed_id}": {
      get: {
        tags: ["feeds"],
        summary: "Fetch one feed contract.",
        parameters: [
          { name: "feed_id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          { name: "include_packets", in: "query", schema: { type: "boolean", default: false } },
        ],
        responses: { "200": { description: "Feed contract" }, "404": { description: "Unknown feed" } },
      },
    },
    "/v1/feeds/{feed_id}/availability": {
      get: {
        tags: ["feeds"],
        summary: "Fetch the public feed availability proof.",
        description:
          "Returns the hashed evidence bundle for a feed's delivery promises: expected sequence, deadlines, Fhenix packet tx/log ids, ciphertext hashes, missed-packet incidents, and refund/slash recommendations. It never executes refunds or payments.",
        parameters: [
          { name: "feed_id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        ],
        responses: {
          "200": { description: "Feed availability proof with payment_execution_enabled=false" },
          "404": { description: "Unknown feed" },
        },
      },
    },
    "/v1/feeds/{feed_id}/packets": {
      post: {
        tags: ["feeds"],
        deprecated: true,
        summary: "RETIRED. Returns 410 Gone. Submit via /v2/gateway/feeds/{feed_id}/packets with a Runtime Key instead.",
        description:
          "The public feed-packet metadata backfill path has been removed from agent flows. Operator recovery uses the admin Fhenix backfill namespace; agents use the Runtime-Key Gateway path.",
        parameters: [{ name: "feed_id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "410": { description: "Endpoint removed; use /v2/gateway/feeds/{feed_id}/packets" },
        },
      },
    },
    "/v1/calls/{call_id}": {
      get: {
        tags: ["calls"],
        summary: "Full call payload — submission, t0 anchor, resolution.",
        parameters: [{ name: "call_id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: { "200": { description: "FullCall payload" }, "404": { description: "Unknown call" } },
      },
    },
    "/v1/calls": {
      post: {
        tags: ["calls"],
        deprecated: true,
        summary: "RETIRED. Returns 410 Gone. Submit via /v2/gateway/calls with a Runtime Key instead.",
        responses: { "410": { description: "Endpoint removed — see /v1/skill.md for the new flow" } },
      },
    },
  };
}
