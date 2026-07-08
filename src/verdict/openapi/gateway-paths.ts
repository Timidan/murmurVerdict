import { FEED_PACKET_KINDS } from "../schema.js";
import type { OpenApiPathMap } from "./types.js";

export function gatewayOpenApiPaths(): OpenApiPathMap {
  return {
    "/v2/gateway/calls/seal": {
      post: {
        tags: ["calls"],
        summary:
          "Canonical Murmur-owned sealing path for a hidden agent market call.",
        description:
          "Runtime-Key-only path. The provider agent submits prediction intent only. Murmur validates policy, seals binary outcome and confidence through its configured CoFHE sealer, broadcasts `submitSealedFor` as the allowlisted relayer, confirms the tx, and indexes only ciphertext handles before reveal.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: [
                  "marketRef",
                  "client_order_id",
                  "client_nonce",
                  "privacy_mode",
                  "verdict",
                ],
                properties: {
                  marketRef: {
                    type: "object",
                    required: ["protocol", "sourceId", "configVersion"],
                    properties: {
                      protocol: { type: "string", example: "polymarket-gamma" },
                      sourceId: { type: "string", example: "0x19525413b8f2e0f8a2f0b7df6c7a62bd75a8d3638d2f3f2fe9c2fb80c9f3b7f0" },
                      configVersion: { type: "integer", minimum: 0 },
                    },
                    additionalProperties: false,
                  },
                  client_order_id: {
                    type: "string",
                    minLength: 8,
                    maxLength: 128,
                  },
                  client_nonce: {
                    type: "string",
                    pattern: "^0x[0-9a-fA-F]{64}$",
                  },
                  submitted_at: {
                    type: "string",
                    format: "date-time",
                  },
                  privacy_mode: {
                    type: "string",
                    enum: ["murmur_sealed_fhenix"],
                  },
                  verdict: {
                    type: "object",
                    required: ["binary_index", "confidence_bps"],
                    properties: {
                      binary_index: { type: "integer", minimum: 0, maximum: 255 },
                      confidence_bps: { type: "integer", minimum: 0, maximum: 10000 },
                    },
                    additionalProperties: false,
                  },
                  public_strategy_tag: {
                    type: "string",
                    minLength: 2,
                    maxLength: 32,
                  },
                },
                additionalProperties: false,
              },
            },
          },
        },
        responses: {
          "200": { description: "Idempotent accepted call." },
          "202": { description: "Gateway attempt queued or submitted." },
          "400": { description: "Schema invalid, policy invalid, or market unsupported by the runtime key." },
          "401": { description: "Missing or invalid Runtime Key." },
          "403": { description: "Runtime Key is not authorized for Gateway submission." },
          "404": { description: "marketRef.sourceId not in markets registry." },
          "409": { description: "Duplicate or conflicting Gateway attempt." },
          "429": { description: "Runtime Key policy/rate limit exceeded." },
          "503": { description: "Gateway broadcaster, RPC, relayer, or Murmur-owned sealer not configured." },
        },
        security: [{ runtimeKeyAuth: [] }],
      },
    },
    "/v2/gateway/calls": {
      post: {
        tags: ["calls"],
        summary:
          "Advanced compatibility relay for a Fhenix-sealed market call.",
        description:
          "Advanced compatibility path for clients that already created CoFHE encrypted inputs. Not the canonical hidden-output path. Murmur verifies key status and policy, broadcasts `submitSealedFor` as the allowlisted relayer, confirms the tx, and indexes the accepted sealed call. Public submit-event metadata backfill is retired; operator recovery is admin-only.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: [
                  "marketRef",
                  "client_order_id",
                  "client_nonce",
                  "privacy_mode",
                  "binary_index_input",
                  "confidence_input",
                ],
                properties: {
                  marketRef: {
                    type: "object",
                    required: ["protocol", "sourceId", "configVersion"],
                    properties: {
                      protocol: { type: "string", example: "polymarket-gamma" },
                      sourceId: { type: "string", example: "0x19525413b8f2e0f8a2f0b7df6c7a62bd75a8d3638d2f3f2fe9c2fb80c9f3b7f0" },
                      configVersion: { type: "integer", minimum: 0 },
                    },
                    additionalProperties: false,
                  },
                  client_order_id: {
                    type: "string",
                    minLength: 8,
                    maxLength: 128,
                  },
                  client_nonce: {
                    type: "string",
                    pattern: "^0x[0-9a-fA-F]{64}$",
                  },
                  rationale: { type: "string", maxLength: 240 },
                  strategy_tag: {
                    type: "string",
                    minLength: 2,
                    maxLength: 32,
                  },
                  submitted_at: {
                    type: "string",
                    format: "date-time",
                  },
                  privacy_mode: {
                    type: "string",
                    enum: ["sealed_fhenix"],
                  },
                  binary_index_input: {
                    type: "object",
                    required: ["ct_hash", "security_zone", "utype", "signature"],
                    properties: {
                      ct_hash: { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" },
                      security_zone: { type: "integer", minimum: 0, maximum: 255 },
                      utype: { type: "integer", enum: [2] },
                      signature: { type: "string", pattern: "^0x[0-9a-fA-F]+$" },
                    },
                    additionalProperties: false,
                  },
                  confidence_input: {
                    type: "object",
                    required: ["ct_hash", "security_zone", "utype", "signature"],
                    properties: {
                      ct_hash: { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" },
                      security_zone: { type: "integer", minimum: 0, maximum: 255 },
                      utype: { type: "integer", enum: [3] },
                      signature: { type: "string", pattern: "^0x[0-9a-fA-F]+$" },
                    },
                    additionalProperties: false,
                  },
                },
                additionalProperties: false,
              },
            },
          },
        },
        responses: {
          "200": { description: "Idempotent accepted call." },
          "202": { description: "Gateway attempt queued or submitted." },
          "400": { description: "Schema invalid, policy invalid, or market unsupported by the runtime key." },
          "401": { description: "Missing or invalid Runtime Key." },
          "403": { description: "Runtime Key is not authorized for Gateway submission." },
          "404": { description: "marketRef.sourceId not in markets registry." },
          "409": { description: "Duplicate or conflicting Gateway attempt." },
          "429": { description: "Runtime Key policy/rate limit exceeded." },
          "503": { description: "Gateway broadcaster, RPC, or relayer not configured." },
        },
        security: [{ runtimeKeyAuth: [] }],
      },
    },
    "/v2/gateway/feeds/{feed_id}/packets": {
      post: {
        tags: ["feeds"],
        summary:
          "Canonical Gateway relay for a Fhenix-sealed long-running feed packet.",
        description:
          "Runtime-Key-only feed delivery path. The agent creates CoFHE encrypted packet inputs client-side, then Murmur verifies feed ownership, feed status, Runtime Key policy, market coverage, and SLA metadata before broadcasting `submitFeedPacketFor` as the allowlisted relayer. Murmur confirms the tx and records the feed packet/SLA row without seeing plaintext feed contents pre-reveal.",
        parameters: [
          { name: "feed_id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: [
                  "packet_kind",
                  "client_order_id",
                  "client_nonce",
                  "privacy_mode",
                  "action_input",
                  "signal_input",
                ],
                properties: {
                  packet_kind: { type: "string", enum: FEED_PACKET_KINDS },
                  market_id: { type: "string" },
                  sequence: { type: "integer", minimum: 1 },
                  payload_schema: { type: "string", default: "murmur-feed-packet-v1" },
                  client_order_id: {
                    type: "string",
                    minLength: 8,
                    maxLength: 128,
                  },
                  client_nonce: {
                    type: "string",
                    pattern: "^0x[0-9a-fA-F]{64}$",
                  },
                  submitted_at: { type: "string", format: "date-time" },
                  delivery_deadline_at: { type: "string", format: "date-time" },
                  reveal_after: { type: "string", format: "date-time" },
                  privacy_mode: { type: "string", enum: ["sealed_fhenix"] },
                  action_input: {
                    type: "object",
                    required: ["ct_hash", "security_zone", "utype", "signature"],
                    properties: {
                      ct_hash: { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" },
                      security_zone: { type: "integer", minimum: 0, maximum: 255 },
                      utype: { type: "integer", enum: [2] },
                      signature: { type: "string", pattern: "^0x[0-9a-fA-F]+$" },
                    },
                    additionalProperties: false,
                  },
                  signal_input: {
                    type: "object",
                    required: ["ct_hash", "security_zone", "utype", "signature"],
                    properties: {
                      ct_hash: { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" },
                      security_zone: { type: "integer", minimum: 0, maximum: 255 },
                      utype: { type: "integer", enum: [3] },
                      signature: { type: "string", pattern: "^0x[0-9a-fA-F]+$" },
                    },
                    additionalProperties: false,
                  },
                },
                additionalProperties: false,
              },
            },
          },
        },
        responses: {
          "200": { description: "Idempotent accepted packet." },
          "202": { description: "Gateway feed-packet attempt queued or submitted." },
          "400": { description: "Schema invalid, policy invalid, or market unsupported by the Runtime Key/feed." },
          "401": { description: "Missing or invalid Runtime Key." },
          "403": { description: "Runtime Key is not authorized for this feed." },
          "404": { description: "Feed or market not found." },
          "409": { description: "Duplicate or conflicting Gateway feed attempt." },
          "429": { description: "Runtime Key policy/rate limit exceeded." },
          "503": { description: "Gateway broadcaster, RPC, or relayer not configured." },
        },
        security: [{ runtimeKeyAuth: [] }],
      },
    },
    "/v2/calls": {
      post: {
        tags: ["calls"],
        deprecated: true,
        summary:
          "RETIRED. Returns 410 Gone. Submit via /v2/gateway/calls/seal with a Runtime Key instead.",
        description:
          "The public submit-event metadata backfill path has been removed from agent flows. Agents submit prediction intent through the Murmur-owned sealing Gateway path. Operator recovery uses /v1/admin/fhenix/backfill/calls.",
        responses: {
          "410": { description: "Endpoint removed; use /v2/gateway/calls/seal" },
        },
      },
    },
  };
}
