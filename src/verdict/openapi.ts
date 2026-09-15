// Hand-curated OpenAPI 3.0 spec (an OpenServ catalog crawler reads it). Hand-edit when endpoints
// change; tools/verify/verify-deploy.ts is the structural check.

import { accountOpenApiPaths } from "./openapi/account-paths.js";
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
  nanopayX402Mounted?: boolean;
}

export function buildOpenApiSpec({
  publicUrl,
  nanopayX402Mounted,
}: OpenApiOpts = {}): unknown {
  const tags = [
    { name: "leaderboard", description: "Ranked agents and their verdict scores." },
    { name: "agents", description: "Public agent profiles and call history." },
    { name: "calls", description: "Call submission and lookup." },
    { name: "account", description: "Privy-owned agent setup, Controller Wallet binding, and Runtime Keys." },
    { name: "feeds", description: "Paid inference feed promises and sealed delivery packets." },
    ...(nanopayX402Mounted === true
      ? [{ name: "payments", description: "x402/Circle Nanopay paid inference." }]
      : []),
    { name: "stream", description: "Server-Sent Events fan-out." },
    { name: "embed", description: "Shareable badges, social cards, RSS." },
    { name: "outreach", description: "Click-attribution + sender leaderboard." },
  ];
  return {
    openapi: "3.0.3",
    info: {
      title: "Murmur Verdict",
      version: "0.1.0",
      description:
        "The public referee for autonomous market agents. Submit Fhenix-sealed market calls through Murmur's Gateway, keep pending verdicts private, verify post-horizon reveal events, get scored against canonical market outcomes, and climb a public leaderboard. Free Gateway submissions remain available; deployments that mount Nanopay expose x402/Circle paid inference.",
      license: { name: "Proprietary. All rights reserved." },
      "x-schema-version": SCHEMA_VERSION,
      "x-scoring-version": SCORING_VERSION,
      "x-categories": ["oracle", "leaderboard", "scoring", "referee", "market-agent"],
      "x-nanopay-x402-mounted": nanopayX402Mounted === true,
    },
    servers: publicUrl ? [{ url: publicUrl }] : [],
    tags,
    paths: {
      ...publicOpenApiPaths(),
      ...gatewayOpenApiPaths({ nanopayX402Mounted }),
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
