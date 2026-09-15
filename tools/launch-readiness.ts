#!/usr/bin/env tsx
/**
 * Is this deployment fit to open to the public? Each check says what it read and why it matters.
 * A testnet chain id is expected, not a finding: Fhenix CoFHE has no mainnet.
 *
 * Usage: npx tsx tools/launch-readiness.ts [--json]
 */
import "dotenv/config";

type Level = "block" | "warn" | "ok";

interface Check {
  area: string;
  name: string;
  observed: string;
  level: Level;
  /** Why it blocks or warns. Empty when ok. */
  because: string;
  /** The concrete change. Empty when ok. */
  fix: string;
}

const env = process.env;
const raw = (k: string): string => (env[k] ?? "").trim();
const isTrue = (k: string): boolean => raw(k).toLowerCase() === "true";
const checks: Check[] = [];

const record = (
  area: string,
  name: string,
  observed: string,
  ok: boolean,
  level: Level,
  because: string,
  fix: string,
): void => {
  checks.push(
    ok
      ? { area, name, observed, level: "ok", because: "", fix: "" }
      : { area, name, observed, level, because, fix },
  );
};

// ── Honesty: claims the deployment makes about itself ────────────────────
record(
  "honesty",
  "MURMUR_OWNED_SEALING_ENABLED",
  raw("MURMUR_OWNED_SEALING_ENABLED") || "(unset)",
  !isTrue("MURMUR_OWNED_SEALING_ENABLED"),
  "block",
  "agents send plaintext verdicts and the operator can read them before public reveal",
  "prove the client-sealed path live (tools/agent-side-cofhe-sealer.ts), then set false",
);
record(
  "honesty",
  "MURMUR_GATEWAY_FINGERPRINT_HMAC_KEYS",
  raw("MURMUR_GATEWAY_FINGERPRINT_HMAC_KEYS") ? "set" : "(empty)",
  !isTrue("MURMUR_OWNED_SEALING_ENABLED") ||
    raw("MURMUR_GATEWAY_FINGERPRINT_HMAC_KEYS").length > 0,
  "block",
  "owned-sealing verdicts can be brute-forced from persisted request fingerprints",
  "set active-id:$(openssl rand -hex 32)",
);
record(
  "honesty",
  "FHENIX_REVEAL_WORKER_ENABLED",
  raw("FHENIX_REVEAL_WORKER_ENABLED") || "(unset)",
  isTrue("FHENIX_REVEAL_WORKER_ENABLED"),
  "block",
  "sealed verdicts are never published, so nothing ever scores",
  "set true and fund the reveal wallet",
);

// ── Operability: can you tell when it breaks, at 3am ─────────────────────
record(
  "operability",
  "MURMUR_REQUIRE_LIVE_CANARIES",
  raw("MURMUR_REQUIRE_LIVE_CANARIES") || "(unset)",
  isTrue("MURMUR_REQUIRE_LIVE_CANARIES"),
  "warn",
  "/v1/readyz returns 200 even when the dependencies it names are down",
  "set true so a load balancer can actually pull a sick instance",
);
record(
  "operability",
  "FHENIX_CANARY_ENABLED",
  raw("FHENIX_CANARY_ENABLED") || "(unset)",
  isTrue("FHENIX_CANARY_ENABLED"),
  "warn",
  "no probe of the Fhenix path; an outage there is invisible until calls fail",
  "set true",
);
record(
  "operability",
  "POLYMARKET_CANARY_ENABLED",
  raw("POLYMARKET_CANARY_ENABLED") || "(unset)",
  isTrue("POLYMARKET_CANARY_ENABLED"),
  "warn",
  "no probe of the venue; discovery can go blind silently",
  "set true and set POLYMARKET_CANARY_CONDITION_ID",
);
record(
  "operability",
  "MURMUR_OPERATOR_ALERT_WEBHOOK_URL",
  raw("MURMUR_OPERATOR_ALERT_WEBHOOK_URL") ? "set" : "(empty)",
  raw("MURMUR_OPERATOR_ALERT_WEBHOOK_URL").length > 0,
  "warn",
  "operator alerts are raised and then dropped; nobody is paged",
  "point it at a real receiver",
);

// ── Durability: what survives losing the box ─────────────────────────────
record(
  "durability",
  "LITESTREAM_ACCESS_KEY_ID",
  raw("LITESTREAM_ACCESS_KEY_ID") ? "set" : "(empty)",
  raw("LITESTREAM_ACCESS_KEY_ID").length > 0,
  "block",
  "the database has no offsite replication; losing the disk loses every call, grant and payout record",
  "configure litestream, or schedule tools/backup-db.ts offsite",
);

// ── Money: only checked once the deployment actually sells ───────────────
const sells = isTrue("FHENIX_GRANT_ENABLED");
record(
  "money",
  "FHENIX_GRANT_PRICE_ATOMS",
  raw("FHENIX_GRANT_PRICE_ATOMS") || "(empty)",
  !sells || raw("FHENIX_GRANT_PRICE_ATOMS").length > 0,
  "block",
  "selling is on with no price configured",
  "set a price, or set FHENIX_GRANT_ENABLED=false",
);
record(
  "money",
  "MURMUR_NANOPAY_SELLER_ADDRESS",
  raw("MURMUR_NANOPAY_SELLER_ADDRESS") ? "set" : "(empty)",
  !sells || /^0x[0-9a-fA-F]{40}$/.test(raw("MURMUR_NANOPAY_SELLER_ADDRESS")),
  "block",
  "sales settle to no address",
  "set the seller address",
);
record(
  "money",
  "MURMUR_ACK_MANUAL_REFUNDS",
  raw("MURMUR_ACK_MANUAL_REFUNDS") || "(unset)",
  !sells || isTrue("MURMUR_ACK_MANUAL_REFUNDS"),
  "warn",
  "refunds are a manual operator step and nobody has acknowledged owning it",
  "set true only if a human really is on the hook for refunds",
);

// ── Safety: dev conveniences that must not ship ──────────────────────────
record(
  "safety",
  "MURMUR_ALLOW_FIXTURE_SEED",
  raw("MURMUR_ALLOW_FIXTURE_SEED") || "(unset)",
  !isTrue("MURMUR_ALLOW_FIXTURE_SEED"),
  "block",
  "tools can mint runtime keys straight into the database, bypassing the wallet gate",
  "remove it from the environment; pass it per-command when testing",
);
record(
  "safety",
  "WEBHOOK_ALLOW_HTTP",
  raw("WEBHOOK_ALLOW_HTTP") || "(empty=off)",
  !isTrue("WEBHOOK_ALLOW_HTTP"),
  "block",
  "webhook payloads may ride plaintext http",
  "leave unset",
);
record(
  "safety",
  "PRIVY_APP_SECRET",
  raw("PRIVY_APP_SECRET") ? "set" : "(empty)",
  raw("PRIVY_APP_SECRET").length > 0,
  "block",
  "sign-in tokens cannot be verified, so nobody can log in",
  "set it",
);

const order: Record<Level, number> = { block: 0, warn: 1, ok: 2 };
checks.sort((a, b) => order[a.level] - order[b.level] || a.area.localeCompare(b.area));

const blocking = checks.filter((c) => c.level === "block");
const warning = checks.filter((c) => c.level === "warn");
const ready = blocking.length === 0;

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ ready, blocking, warning, checks }, null, 2));
} else {
  const mark = (l: Level) => (l === "block" ? "BLOCK" : l === "warn" ? " warn" : "   ok");
  console.log("");
  for (const c of checks) {
    console.log(`${mark(c.level)}  ${c.name}  =  ${c.observed}`);
    if (c.because) {
      console.log(`         ${c.because}`);
      console.log(`         → ${c.fix}`);
    }
  }
  console.log("");
  console.log(
    ready
      ? `READY — 0 blocking, ${warning.length} warning`
      : `NOT READY — ${blocking.length} blocking, ${warning.length} warning`,
  );
  console.log("");
}

process.exit(ready ? 0 : 1);
