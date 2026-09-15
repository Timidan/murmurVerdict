import { strict as assert } from "node:assert";

import { loadPayoutConfig, PayoutConfigError } from "./payout-config.js";

// The rail is off unless everything is present, and it refuses to boot when
// the configuration is present but WRONG — chiefly when the payout key is not
// the wallet sales actually land in.
process.stdout.write("murmur payout config smoke\n");

// anvil account #0, and its address.
const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const ADDR = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const base = {
  MURMUR_PAYOUT_ENABLED: "true",
  MURMUR_PAYOUT_PRIVATE_KEY: KEY,
  MURMUR_PAYOUT_RPC_URL: "https://rpc.example",
  MURMUR_PAYOUT_TOKEN_ADDRESS: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  MURMUR_PAYOUT_CHAIN_ID: "84532",
  MURMUR_NANOPAY_SELLER_ADDRESS: ADDR,
} as NodeJS.ProcessEnv;

// Off by default, and off is not an error.
assert.equal(loadPayoutConfig({}).enabled, false);
assert.equal(loadPayoutConfig({ ...base, MURMUR_PAYOUT_ENABLED: "false" }).enabled, false);
assert.equal(loadPayoutConfig({ ...base, MURMUR_PAYOUT_PRIVATE_KEY: "" }).enabled, false);

// Fully configured.
{
  const r = loadPayoutConfig(base);
  assert.equal(r.enabled, true);
  assert.ok(r.enabled && r.config.senderAddress === ADDR);
  assert.ok(r.enabled && r.config.currency === "USDC");
  assert.ok(r.enabled && r.config.confirmations === 2);
}

// THE preflight: a key that is not the seller must never start the rail.
assert.throws(
  () =>
    loadPayoutConfig({
      ...base,
      MURMUR_NANOPAY_SELLER_ADDRESS: "0x000000000000000000000000000000000000dEaD",
    }),
  (e: unknown) =>
    e instanceof PayoutConfigError && /not the seller address/.test(e.message),
  "a payout key for the wrong wallet is refused at boot, not at withdrawal time",
);

// The payout wallet must be DEDICATED. The same key under another writer's
// name is refused by derived address, whichever name it hides behind.
for (const other of [
  "FHENIX_GATEWAY_RELAYER_PRIVATE_KEY",
  "FHENIX_GRANT_PRIVATE_KEY",
  "FHENIX_REVEAL_PRIVATE_KEY",
]) {
  assert.throws(
    () => loadPayoutConfig({ ...base, [other]: KEY }),
    (e: unknown) => e instanceof PayoutConfigError && e.message.includes(other),
    `${other} sharing the payout wallet is refused at boot`,
  );
}
// A DIFFERENT wallet under those names is fine.
assert.equal(
  loadPayoutConfig({
    ...base,
    FHENIX_GATEWAY_RELAYER_PRIVATE_KEY:
      "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  }).enabled,
  true,
);

// A seller address that was never configured is the same refusal.
assert.throws(
  () => loadPayoutConfig({ ...base, MURMUR_NANOPAY_SELLER_ADDRESS: "" }),
  PayoutConfigError,
);

// Malformed values are errors, not silent defaults.
assert.throws(() => loadPayoutConfig({ ...base, MURMUR_PAYOUT_PRIVATE_KEY: "0xabc" }), PayoutConfigError);
assert.throws(() => loadPayoutConfig({ ...base, MURMUR_PAYOUT_CHAIN_ID: "0" }), PayoutConfigError);
assert.throws(() => loadPayoutConfig({ ...base, MURMUR_PAYOUT_CONFIRMATIONS: "0" }), PayoutConfigError);
assert.throws(() => loadPayoutConfig({ ...base, MURMUR_PAYOUT_TOKEN_ADDRESS: "nope" }), PayoutConfigError);

process.stdout.write("OK payout config smoke\n");
