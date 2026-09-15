#!/usr/bin/env tsx
/**
 * Prints the deploy-time addresses derived from the keys in `.env`, as shell exports.
 * Foundry reads them via `vm.envAddress`; Solidity can't derive an address from a key.
 *
 * Usage:
 *   set -a; . ./.env; set +a
 *   eval "$(npx tsx tools/print-deploy-env.ts)"
 *   npm run deploy:contracts
 *
 * DEPLOY_PRIVATE_KEY must already be in your environment. This never prints a key.
 */
import "dotenv/config";

import { deriveAddressFromKey } from "../src/integrations/derived-addresses.js";

interface Derived {
  envVar: string;
  keyVar: string;
  required: boolean;
}

const DERIVED: Derived[] = [
  // Relays submitSealedFor; the same key the daemon's gateway signs with.
  { envVar: "RELAYER_ADDRESS", keyVar: "FHENIX_GATEWAY_RELAYER_PRIVATE_KEY", required: true },
  // Authorized to broker paid decrypt access. Deliberately a different key.
  { envVar: "GRANTOR_ADDRESS", keyVar: "FHENIX_GRANT_PRIVATE_KEY", required: true },
  // Optional; when present the deploy script enforces all three roles are distinct.
  { envVar: "REVEAL_ADDRESS", keyVar: "FHENIX_REVEAL_PRIVATE_KEY", required: false },
];

const lines: string[] = [];
const missing: string[] = [];

for (const { envVar, keyVar, required } of DERIVED) {
  const key = process.env[keyVar]?.trim();
  if (!key) {
    if (required) missing.push(keyVar);
    continue;
  }
  const address = deriveAddressFromKey({
    privateKey: key,
    configured: process.env[envVar],
    configuredName: envVar,
    keyName: keyVar,
  });
  lines.push(`export ${envVar}=${address}`);
}

if (missing.length > 0) {
  console.error(
    `[deploy-env] missing required key(s): ${missing.join(", ")}. ` +
      `Source .env first:  set -a; . ./.env; set +a`,
  );
  process.exit(1);
}


console.log(lines.join("\n"));
