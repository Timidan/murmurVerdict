import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";

import { canonicalize } from "../receipts/canonical.js";
import { VerdictError } from "../verdict/schema.js";
import {
  applyMigrations,
  LATEST_DB_MIGRATION_VERSION,
} from "../verdict/db-migrations.js";
import {
  assertGatewayFingerprintMatch,
  gatewayRequestFingerprint,
  gatewayRequestFingerprints,
  type GatewayFingerprintHmacKeyring,
} from "./gateway-request-fingerprint.js";

const body = {
  marketRef: {
    protocol: "polymarket-gamma",
    sourceId: "market-1",
    configVersion: 1,
  },
  client_order_id: "order-1",
  client_nonce: `0x${"ab".repeat(32)}`,
  privacy_mode: "murmur_sealed_fhenix",
  verdict: { binary_index: 1, confidence_bps: 7400 },
};
const oldKey = {
  id: "2026-07",
  key: Buffer.from("11".repeat(32), "hex"),
};
const activeKey = {
  id: "2026-08",
  key: Buffer.from("22".repeat(32), "hex"),
};
const oldRing: GatewayFingerprintHmacKeyring = {
  active: oldKey,
  previous: [],
};
const rotatedRing: GatewayFingerprintHmacKeyring = {
  active: activeKey,
  previous: [oldKey],
};

const legacyDigest = createHash("sha256")
  .update(
    `murmur-idem-v1\nowned_sealed_call\n${canonicalize(body)}`,
    "utf8",
  )
  .digest("hex");
const oldFingerprint = gatewayRequestFingerprint(
  "owned_sealed_call",
  body,
  { hmacKeyring: oldRing },
);
assert.match(oldFingerprint, /^v1:hmac-sha256:2026-07:[0-9a-f]{64}$/);
assert.notEqual(
  oldFingerprint.split(":").at(-1),
  legacyDigest,
  "the persisted digest must not be reproducible from the request body alone",
);
assert.equal(
  gatewayRequestFingerprint("owned_sealed_call", body, {
    hmacKeyring: oldRing,
  }),
  oldFingerprint,
  "the same body is idempotent",
);

const activeFingerprint = gatewayRequestFingerprint(
  "owned_sealed_call",
  body,
  { hmacKeyring: rotatedRing },
);
const previousFingerprint = gatewayRequestFingerprint(
  "owned_sealed_call",
  body,
  { hmacKeyring: { active: oldKey, previous: [] } },
);
assert.doesNotThrow(() =>
  assertGatewayFingerprintMatch(
    oldFingerprint,
    [activeFingerprint, previousFingerprint],
    { client_order_id: body.client_order_id },
  ),
);

const changedFingerprint = gatewayRequestFingerprint(
  "owned_sealed_call",
  {
    ...body,
    verdict: { ...body.verdict, confidence_bps: 7401 },
  },
  { hmacKeyring: rotatedRing },
);
assert.notEqual(changedFingerprint, activeFingerprint);
assert.throws(
  () =>
    assertGatewayFingerprintMatch(
      oldFingerprint,
      [
        changedFingerprint,
        gatewayRequestFingerprint(
          "owned_sealed_call",
          {
            ...body,
            verdict: { ...body.verdict, confidence_bps: 7401 },
          },
          { hmacKeyring: { active: oldKey, previous: [] } },
        ),
      ],
      { client_order_id: body.client_order_id },
    ),
  (err) => err instanceof VerdictError && err.httpStatus === 409,
);
assert.doesNotThrow(() =>
  assertGatewayFingerprintMatch(null, [changedFingerprint], {}),
  "null remains a non-comparable legacy fingerprint",
);

const canonicalInput = `murmur-idem-v1\nsealed_call\n${canonicalize(body)}`;
const legacyCanonical = createHash("sha256")
  .update(canonicalInput, "utf8")
  .digest("hex");
const canonicalFingerprints = gatewayRequestFingerprints("sealed_call", body);
assert.equal(
  canonicalFingerprints.stored,
  `v1:sha256:unkeyed:${legacyCanonical}`,
);
assert.doesNotThrow(() =>
  assertGatewayFingerprintMatch(
    legacyCanonical,
    canonicalFingerprints.comparisons,
    {},
  ),
);

const migrationDb = new Database(":memory:");
migrationDb.exec(`
  CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  INSERT INTO schema_meta(key, value) VALUES('schema_version', '73');
  CREATE TABLE fhenix_gateway_tx_attempts (
    attempt_id TEXT PRIMARY KEY,
    request_fingerprint TEXT
  );
  CREATE TABLE fhenix_gateway_feed_packet_tx_attempts (
    attempt_id TEXT PRIMARY KEY,
    request_fingerprint TEXT
  );
  INSERT INTO fhenix_gateway_tx_attempts VALUES
    ('legacy', '${"aa".repeat(32)}'),
    ('versioned', 'v1:hmac-sha256:old:${"bb".repeat(32)}'),
    ('null', NULL);
  INSERT INTO fhenix_gateway_feed_packet_tx_attempts VALUES
    ('canonical-feed', '${"cc".repeat(32)}');

  -- Minimal stubs for the tables the later migrations read/rewrite. This
  -- fixture stamps schema_version 73, so 074 (the scrub under test), 075 and
  -- 076 all run; 075 asserts agent_provider_terms is empty, then rekeys it and
  -- backfills from markets/submissions, and 076 indexes market_clocks. All
  -- empty here, so everything after 074 is a harmless no-op.
  CREATE TABLE agents (agent_id TEXT PRIMARY KEY);
  CREATE TABLE agent_provider_terms (agent_id TEXT PRIMARY KEY);
  CREATE TABLE markets (market_id TEXT PRIMARY KEY, config_json TEXT NOT NULL DEFAULT '{}');
  CREATE TABLE submissions (call_id TEXT PRIMARY KEY, agent_id TEXT, market_id TEXT);
  CREATE TABLE market_clocks (market_id TEXT PRIMARY KEY, submission_close_at_ms INTEGER);
`);
applyMigrations(migrationDb);
const migrated = migrationDb
  .prepare("SELECT attempt_id, request_fingerprint FROM fhenix_gateway_tx_attempts ORDER BY attempt_id")
  .all() as Array<{ attempt_id: string; request_fingerprint: string | null }>;
assert.deepEqual(migrated, [
  { attempt_id: "legacy", request_fingerprint: null },
  { attempt_id: "null", request_fingerprint: null },
  {
    attempt_id: "versioned",
    request_fingerprint: `v1:hmac-sha256:old:${"bb".repeat(32)}`,
  },
]);
assert.equal(
  migrationDb
    .prepare("SELECT request_fingerprint FROM fhenix_gateway_feed_packet_tx_attempts")
    .pluck()
    .get(),
  "cc".repeat(32),
  "the provably canonical feed route keeps its legacy comparable fingerprint",
);
assert.equal(
  migrationDb.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").pluck().get(),
  String(LATEST_DB_MIGRATION_VERSION),
  "applyMigrations advances all the way to the latest version",
);
migrationDb.close();

console.log("gateway request fingerprint smoke ok");
