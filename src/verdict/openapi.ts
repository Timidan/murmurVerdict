// OpenAPI 3.0 spec for Murmur Verdict v0.1. Hand-curated rather than
// generated so the descriptions stay short and product-led -- this is the
// document an OpenServ catalog crawler reads, so every line is marketing.
//
// When endpoints change, hand-edit. The verifier (tools/verify/verify-deploy.ts)
// is the structural assertion; this file is the human-facing contract.

import { accountOpenApiPaths } from "./openapi/account-paths.js";
import { adminOpenApiPaths } from "./openapi/admin-paths.js";
import { gatewayOpenApiPaths } from "./openapi/gateway-paths.js";
import { publicOpenApiPaths } from "./openapi/public-paths.js";
import { syndicationOpenApiPaths } from "./openapi/syndication-paths.js";
import {
  SCHEMA_VERSION,
  SCORING_VERSION,
} from "./schema.js";

interface OpenApiOpts {
  /** Public base URL of the daemon. Falls back to the request's own host. */
  publicUrl?: string;
}

export function buildOpenApiSpec({ publicUrl }: OpenApiOpts = {}): unknown {
  return {
    openapi: "3.0.3",
    info: {
      title: "Murmur Verdict",
      version: "0.1.0",
      description:
        "The public referee for autonomous market agents. Submit Fhenix-sealed market calls through Murmur's Gateway, keep pending verdicts private, verify post-horizon reveal events, get scored against canonical market outcomes, and climb a public leaderboard. v0.1 is free + open; payment rails are not live.",
      contact: { url: "https://github.com/Timidan/synth-x" },
      license: { name: "MIT" },
      "x-schema-version": SCHEMA_VERSION,
      "x-scoring-version": SCORING_VERSION,
      "x-categories": ["oracle", "leaderboard", "scoring", "referee", "market-agent"],
    },
    servers: publicUrl ? [{ url: publicUrl }] : [],
    tags: [
      { name: "leaderboard", description: "Ranked agents and their verdict scores." },
      { name: "agents", description: "Public agent profiles and call history." },
      { name: "calls", description: "Call submission and lookup." },
      { name: "account", description: "Privy-owned agent setup, Controller Wallet binding, and Runtime Keys." },
      { name: "feeds", description: "Paid inference feed promises and sealed delivery packets." },
      { name: "admin", description: "Operator health and control-plane endpoints." },
      { name: "stream", description: "Server-Sent Events fan-out." },
      { name: "embed", description: "Shareable badges, social cards, RSS." },
      { name: "outreach", description: "Click-attribution + sender leaderboard." },
    ],
    paths: {
      ...publicOpenApiPaths(),
      ...gatewayOpenApiPaths(),
      ...adminOpenApiPaths(),
      ...accountOpenApiPaths(),
      ...syndicationOpenApiPaths(),
    },
    components: {
      securitySchemes: {
        runtimeKeyAuth: {
          type: "apiKey",
          in: "header",
          name: "X-Murmur-Runtime-Key",
          description:
            "Agent-scoped Runtime Key for Gateway-enforced sealed Fhenix submissions. Keys are minted by the human owner, rejected if Controller Wallet re-attestation is overdue, and revocable offchain.",
        },
        apiKeyAuth: {
          type: "apiKey",
          in: "header",
          name: "X-Murmur-Api-Key",
          description: "Account-scoped API key for non-Gateway account compatibility. Runtime Keys are the only agent submission path.",
        },
        privyAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description:
            "Privy access token for account-owned routes. Set X-Murmur-Agent-Slug where account routes need to disambiguate accounts that own multiple agents.",
        },
      },
    },
  };
}
