import assert from "node:assert/strict";

import {
  PrivyAuthConfigError,
  createPrivyAuthVerifier,
  loadPrivyAuthConfig,
} from "./privy.js";

// ── Disabled: nothing set ────────────────────────────────────────────────
const disabled = loadPrivyAuthConfig({});
assert.equal(disabled.appId, null);
assert.equal(disabled.appSecret, null);
assert.equal(disabled.jwtVerificationKey, null);
assert.equal(createPrivyAuthVerifier(disabled).isEnabled(), false);

// ── Enabled, JWKS-by-default: APP_ID + APP_SECRET only ───────────────────
const jwksOnly = loadPrivyAuthConfig({
  PRIVY_APP_ID: " app-id ",
  PRIVY_APP_SECRET: " app-secret ",
});
assert.equal(jwksOnly.appId, "app-id");
assert.equal(jwksOnly.appSecret, "app-secret");
assert.equal(jwksOnly.jwtVerificationKey, null);
assert.equal(createPrivyAuthVerifier(jwksOnly).isEnabled(), true);

// ── Enabled, pinned: all three set ───────────────────────────────────────
const pinned = loadPrivyAuthConfig({
  PRIVY_APP_ID: " app-id ",
  PRIVY_APP_SECRET: " app-secret ",
  PRIVY_VERIFICATION_KEY: " pem-key ",
});
assert.equal(pinned.appId, "app-id");
assert.equal(pinned.appSecret, "app-secret");
assert.equal(pinned.jwtVerificationKey, "pem-key");
assert.equal(createPrivyAuthVerifier(pinned).isEnabled(), true);

// ── Misconfig: APP_SECRET set without APP_ID → throws on APP_ID ─────────
assert.throws(
  () =>
    loadPrivyAuthConfig({
      PRIVY_APP_SECRET: "app-secret",
    }),
  (err) =>
    err instanceof PrivyAuthConfigError &&
    err.key === "PRIVY_APP_ID",
);

// ── Misconfig: APP_ID set without APP_SECRET → throws on APP_SECRET ─────
assert.throws(
  () =>
    loadPrivyAuthConfig({
      PRIVY_APP_ID: "app-id",
    }),
  (err) =>
    err instanceof PrivyAuthConfigError &&
    err.key === "PRIVY_APP_SECRET",
);

// ── Misconfig: VERIFICATION_KEY alone → throws on APP_ID (nonsense) ─────
assert.throws(
  () =>
    loadPrivyAuthConfig({
      PRIVY_VERIFICATION_KEY: "pem-key",
    }),
  (err) =>
    err instanceof PrivyAuthConfigError &&
    err.key === "PRIVY_APP_ID",
);

// ── Misconfig: APP_SECRET + VERIFICATION_KEY without APP_ID ─────────────
assert.throws(
  () =>
    loadPrivyAuthConfig({
      PRIVY_APP_SECRET: "app-secret",
      PRIVY_VERIFICATION_KEY: "pem-key",
    }),
  (err) =>
    err instanceof PrivyAuthConfigError &&
    err.key === "PRIVY_APP_ID",
);

// ── Misconfig: APP_ID + VERIFICATION_KEY without APP_SECRET ─────────────
assert.throws(
  () =>
    loadPrivyAuthConfig({
      PRIVY_APP_ID: "app-id",
      PRIVY_VERIFICATION_KEY: "pem-key",
    }),
  (err) =>
    err instanceof PrivyAuthConfigError &&
    err.key === "PRIVY_APP_SECRET",
);

console.log("privy smoke ok");
