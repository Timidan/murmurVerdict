#!/usr/bin/env tsx
/**
 * Prints the deploy-time addresses derived from the keys already in `.env`,
 * as shell exports.
 *
 * The Foundry deploy scripts read RELAYER_ADDRESS / GRANTOR_ADDRESS /
 * REVEAL_ADDRESS via `vm.envAddress`, and Solidity cannot derive an address
 * from a private key — so somebody has to compute them. Until now that was the
 * operator, by hand, from a documented snippet that referenced `$GRANT_ADDRESS`
 * — a variable defined nowhere in this repo. Copying it exported an empty
 * grantor and the deploy reverted.
 *
 * Each address here is derived from the key that will actually control it, so
 * they cannot disagree with the running daemon's identity.
 *
 * Usage:
 *   set -a; . ./.env; set +a
 *   eval "$(npx tsx tools/print-deploy-env.ts)"
 *   npm run deploy:contracts
 */
import "dotenv/config";

import { deriveAddressFromKey } from "../src/integrations/derived-addresses.js";

interface Derived {
  envVar: string;
  keyVar: string;
  required: boolean;
}

const DERIVED: Derived[] = [
  // Authorized to relay submitSealedFor. Same key the daemon's gateway signs
  // with, so deriving it here guarantees the deploy authorizes the account
  // that will actually be submitting.
  { envVar: "RELAYER_ADDRESS", keyVar: "FHENIX_GATEWAY_RELAYER_PRIVATE_KEY", required: true },
  // Authorized to broker paid decrypt access. Deliberately a different key.
  { envVar: "GRANTOR_ADDRESS", keyVar: "FHENIX_GRANT_PRIVATE_KEY", required: true },
  // Optional at deploy time; when present the script enforces that all three
  // roles are distinct.
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

// The deployer signs; it is a key, not a derived address, so it passes through.
if (process.env.FHENIX_GATEWAY_RELAYER_PRIVATE_KEY) {
  lines.push(`export DEPLOY_PRIVATE_KEY=${process.env.FHENIX_GATEWAY_RELAYER_PRIVATE_KEY}`);
}

console.log(lines.join("\n"));
