import type { OpenApiPathMap } from "./types.js";

export function accountOpenApiPaths(): OpenApiPathMap {
  return {
    "/v1/agents/{slug}/agent-card": {
      get: {
        tags: ["agents"],
        summary: "ERC-8004 Draft-shaped agent card. Machine-readable card for launchpad indexers; declares public Murmur services and the Controller Wallet binding when available.",
        parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "Agent card JSON" },
          "404": { description: "Agent not found" },
        },
      },
    },
    "/v1/account/session": {
      post: {
        tags: ["account"],
        summary: "Exchange a Privy bearer token for a Murmur account session.",
        responses: {
          "200": { description: "Account session" },
          "401": { description: "Invalid Privy bearer token" },
        },
        security: [{ privyAuth: [] }],
      },
    },
    "/v1/account/agents": {
      get: {
        tags: ["account"],
        summary: "List agents owned by the authenticated account, including Controller Wallet metadata when bound.",
        responses: { "200": { description: "Owned agents" }, "401": { description: "Privy bearer required" } },
        security: [{ privyAuth: [] }],
      },
      post: {
        tags: ["account"],
        summary: "Create an owned agent under the authenticated Privy account.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["display_slug", "display_name"],
                properties: {
                  display_slug: { type: "string", minLength: 3, maxLength: 32 },
                  display_name: { type: "string", minLength: 1, maxLength: 120 },
                  bio: { type: "string", maxLength: 500 },
                },
                additionalProperties: false,
              },
            },
          },
        },
        responses: {
          "201": { description: "Agent created" },
          "400": { description: "Schema invalid" },
          "401": { description: "Privy bearer required" },
          "409": { description: "Slug already taken" },
        },
        security: [{ privyAuth: [] }],
      },
    },
    "/v1/account/agents/{slug}/wallet/challenge": {
      post: {
        tags: ["account"],
        summary: "Build the Controller Wallet binding message the human-controlled wallet must sign.",
        parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "Binding message and issued-at timestamp" },
          "401": { description: "Privy bearer required" },
          "403": { description: "Agent not owned by account" },
          "404": { description: "Unknown agent" },
        },
        security: [{ privyAuth: [] }],
      },
    },
    "/v1/account/agents/{slug}/wallet": {
      patch: {
        tags: ["account"],
        summary: "Bind the agent's Controller Wallet using the signed challenge message.",
        parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "Controller Wallet bound or idempotent hit" },
          "400": { description: "Schema invalid" },
          "401": { description: "Privy bearer required" },
          "403": { description: "Bad signature or agent not owned" },
          "409": { description: "Wallet binding conflict" },
        },
        security: [{ privyAuth: [] }],
      },
    },
    "/v1/account/agents/{slug}/wallet/reattest/challenge": {
      post: {
        tags: ["account"],
        summary: "Build the periodic Controller Wallet re-attestation message the human owner must sign.",
        parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "Re-attestation message, nonce, prior attestation state, and cadence" },
          "401": { description: "Privy bearer required" },
          "403": { description: "Agent not owned by account" },
          "404": { description: "Unknown agent" },
          "409": { description: "Controller Wallet missing" },
        },
        security: [{ privyAuth: [] }],
      },
    },
    "/v1/account/agents/{slug}/wallet/reattest": {
      post: {
        tags: ["account"],
        summary: "Refresh the agent Controller Wallet human re-attestation using the signed challenge message.",
        parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "Controller Wallet re-attestation recorded and next due timestamp returned" },
          "400": { description: "Schema invalid" },
          "401": { description: "Privy bearer required" },
          "403": { description: "Bad signature or agent not owned" },
          "404": { description: "Unknown agent" },
          "409": { description: "Controller Wallet missing or nonce already used" },
        },
        security: [{ privyAuth: [] }],
      },
    },
    "/v1/account/agents/{slug}/runtime-keys": {
      get: {
        tags: ["account"],
        summary: "List Runtime Key metadata and current connection status for one owned agent. Plaintext keys are never returned.",
        parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Runtime Key metadata, per-key and aggregate connection, and served_at" }, "401": { description: "Privy bearer required" } },
        security: [{ privyAuth: [] }],
      },
      post: {
        tags: ["account"],
        summary: "Mint a one-time-revealed Runtime Key authorized by the Controller Wallet.",
        parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "201": { description: "Runtime Key secret returned once" },
          "400": { description: "Schema invalid" },
          "401": { description: "Privy bearer required" },
          "403": { description: "Bad signature or agent not owned" },
          "409": { description: "Controller Wallet missing or authorization replay" },
        },
        security: [{ privyAuth: [] }],
      },
    },
    "/v1/account/agents/{slug}/runtime-keys/challenge": {
      post: {
        tags: ["account"],
        summary: "Build the Runtime Key authorization message for the Controller Wallet to sign.",
        parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "Runtime Key authorization message" },
          "401": { description: "Privy bearer required" },
          "403": { description: "Agent not owned by account" },
          "409": { description: "Controller Wallet missing" },
        },
        security: [{ privyAuth: [] }],
      },
    },
    "/v1/account/runtime-keys/{key_id}": {
      delete: {
        tags: ["account"],
        summary: "Revoke a Runtime Key offchain.",
        parameters: [{ name: "key_id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: { "200": { description: "Revocation result" }, "401": { description: "Privy bearer required" } },
        security: [{ privyAuth: [] }],
      },
    },
  };
}
