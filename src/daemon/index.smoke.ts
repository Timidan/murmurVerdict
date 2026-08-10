import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ambientEnvKeys = [
  "BASE_MAINNET_RPC_URL",
  "CHAINLINK_BASE_ETH_USD_ADDRESS",
  "FHENIX_CANARY_ENABLED",
  "FHENIX_CANARY_REQUIRE_CONTRACT_CODE",
  "FHENIX_CHAIN_ID",
  "FHENIX_CONTRACT_ADDRESS",
  "FHENIX_ESCROW_ADDRESS",
  "FHENIX_GATEWAY_ENABLED",
  "FHENIX_RPC_URL",
  "FHENIX_SEALED_VERDICTS_ADDRESS",
  "MURMUR_NANOPAY_ENABLED",
  "MURMUR_OPERATOR_ALERT_SECRET",
  "MURMUR_OPERATOR_ALERT_TIMEOUT_MS",
  "MURMUR_OPERATOR_ALERT_WEBHOOK_URL",
  "MURMUR_POLYMARKET_GAMMA_ENABLED",
  "MURMUR_PUBLIC_URL",
  "MURMUR_REQUIRE_LIVE_CANARIES",
  "OPENSERV_API_KEY",
  "OPENSERV_LAUNCHPAD_ENABLED",
  "POLYMARKET_CANARY_CONDITION_ID",
  "POLYMARKET_CANARY_ENABLED",
  "PORT",
  "PRIVY_APP_ID",
  "PRIVY_APP_SECRET",
  "PRIVY_VERIFICATION_KEY",
  "PYTH_HERMES_ENDPOINT",
  "VERDICT_DB_PATH",
] as const;

const priorEnv = new Map(ambientEnvKeys.map((key) => [key, process.env[key]]));

process.env.BASE_MAINNET_RPC_URL = "https://ambient-base-rpc.invalid";
process.env.CHAINLINK_BASE_ETH_USD_ADDRESS =
  "0x9999999999999999999999999999999999999999";
process.env.FHENIX_CANARY_ENABLED = "true";
process.env.FHENIX_CANARY_REQUIRE_CONTRACT_CODE = "false";
process.env.FHENIX_CHAIN_ID = "not-a-chain";
process.env.FHENIX_CONTRACT_ADDRESS = `0x${"2".repeat(40)}`;
process.env.FHENIX_ESCROW_ADDRESS = `0x${"3".repeat(40)}`;
process.env.FHENIX_GATEWAY_ENABLED = "true";
process.env.FHENIX_RPC_URL = "http://ambient-fhenix.invalid";
process.env.FHENIX_SEALED_VERDICTS_ADDRESS = `0x${"4".repeat(40)}`;
process.env.MURMUR_NANOPAY_ENABLED = "true";
process.env.MURMUR_OPERATOR_ALERT_SECRET = "ambient-alert-secret";
process.env.MURMUR_OPERATOR_ALERT_TIMEOUT_MS = "9999";
process.env.MURMUR_OPERATOR_ALERT_WEBHOOK_URL = "https://ambient-alert.invalid";
process.env.MURMUR_POLYMARKET_GAMMA_ENABLED = "1";
process.env.MURMUR_PUBLIC_URL = "https://ambient-public.invalid";
process.env.MURMUR_REQUIRE_LIVE_CANARIES = "true";
process.env.OPENSERV_API_KEY = "ambient-openserv-api-key";
process.env.OPENSERV_LAUNCHPAD_ENABLED = "true";
process.env.POLYMARKET_CANARY_CONDITION_ID = `0x${"6".repeat(64)}`;
process.env.POLYMARKET_CANARY_ENABLED = "true";
process.env.PORT = "9999";
process.env.PRIVY_APP_ID = "ambient-privy-app";
process.env.PRIVY_APP_SECRET = "ambient-privy-secret";
process.env.PRIVY_VERIFICATION_KEY = "ambient-invalid-pem";
process.env.PYTH_HERMES_ENDPOINT = "https://ambient-pyth.invalid";
process.env.VERDICT_DB_PATH = "/tmp/ambient-verdict-db-should-not-be-used.db";

const tmp = mkdtempSync(join(tmpdir(), "murmur-daemon-index-smoke-"));
const dbPath = join(tmp, "nested", "verdict.db");
const runtimeEnv: NodeJS.ProcessEnv = {
  BASE_MAINNET_RPC_URL: "https://configured-base-rpc.invalid",
  CHAINLINK_BASE_ETH_USD_ADDRESS: `0x${"7".repeat(40)}`,
  FHENIX_CANARY_ENABLED: "false",
  FHENIX_CANARY_REQUIRE_CONTRACT_CODE: "false",
  FHENIX_CHAIN_ID: "",
  FHENIX_CONTRACT_ADDRESS: "",
  FHENIX_ESCROW_ADDRESS: "",
  FHENIX_GATEWAY_ENABLED: "false",
  FHENIX_RPC_URL: "",
  FHENIX_SEALED_VERDICTS_ADDRESS: "",
  MURMUR_NANOPAY_ENABLED: "false",
  MURMUR_OPERATOR_ALERT_SECRET: "",
  MURMUR_OPERATOR_ALERT_TIMEOUT_MS: "",
  MURMUR_OPERATOR_ALERT_WEBHOOK_URL: "",
  MURMUR_POLYMARKET_GAMMA_ENABLED: "0",
  MURMUR_PUBLIC_URL: "https://configured-daemon.example",
  MURMUR_REQUIRE_LIVE_CANARIES: "false",
  OPENSERV_API_KEY: "configured-openserv-api-key",
  OPENSERV_LAUNCHPAD_ENABLED: "true",
  POLYMARKET_CANARY_CONDITION_ID: "",
  POLYMARKET_CANARY_ENABLED: "false",
  PORT: "0",
  PRIVY_APP_ID: "",
  PRIVY_APP_SECRET: "",
  PRIVY_VERIFICATION_KEY: "",
  PYTH_HERMES_ENDPOINT: "https://configured-pyth.invalid",
  VERDICT_DB_PATH: dbPath,
};
const logs: unknown[][] = [];
const warns: unknown[][] = [];
const errors: unknown[][] = [];
const logger = {
  log: (...args: unknown[]) => {
    logs.push(args);
  },
  warn: (...args: unknown[]) => {
    warns.push(args);
  },
  error: (...args: unknown[]) => {
    errors.push(args);
  },
};
const daemonNow = () => new Date("2026-06-12T10:15:00Z");
let handle: Awaited<ReturnType<typeof import("./index.js").startDaemon>> | null = null;

try {
  const { startDaemon } = await import("./index.js");
  handle = await startDaemon({
    env: runtimeEnv,
    logger,
    now: daemonNow,
    skipOpenServ: true,
    skipTickers: true,
  });

  assert(handle.port > 0, "daemon should expose the actual ephemeral port");

  const health = await fetch(`http://127.0.0.1:${handle.port}/v1/health`);
  assert.equal(health.status, 200);
  const body = await health.json() as { ok?: boolean; privacy?: { mode?: string } };
  assert.equal(body.ok, true);
  assert.equal((body as { now?: string }).now, "2026-06-12T10:15:00Z");
  assert.equal(body.privacy?.mode, "sealed_fhenix");

  const embed = await fetch(`http://127.0.0.1:${handle.port}/embed.js`);
  assert.equal(embed.status, 200);
  const embedJs = await embed.text();
  assert.match(embedJs, /https:\/\/configured-daemon\.example/);
  assert.doesNotMatch(embedJs, /ambient-public\.invalid/);
  assert(
    logs.some((entry) => String(entry[0]).includes("[daemon] Fhenix config:")),
    "daemon should log Fhenix startup through the injected logger",
  );
  assert(
    logs.some((entry) => String(entry[0]).includes("[daemon] verdict listening")),
    "daemon should log HTTP startup through the injected logger",
  );

  const firstClose = handle.close();
  const secondClose = handle.close();
  assert.equal(
    secondClose,
    firstClose,
    "close should return the in-flight shutdown promise",
  );
  await firstClose;
  await handle.close();
  handle = null;

  await assert.rejects(
    () =>
      startDaemon({
        env: {
          ...runtimeEnv,
          PORT: "-1",
          VERDICT_DB_PATH: join(tmp, "failed-startup", "verdict.db"),
        },
        logger,
        skipOpenServ: true,
        skipTickers: true,
      }),
    isInvalidDaemonPort,
  );
  // Privy is deliberately unset in runtimeEnv, so startup emits exactly the
  // fail-closed auth warning and nothing else.
  assert.equal(warns.length, 1);
  assert.match(
    String(warns[0]?.[0]),
    /PRIVY_APP_ID\/PRIVY_APP_SECRET unset/,
  );
  assert.equal(errors.length, 0);

  console.log("daemon index smoke ok");
} finally {
  await handle?.close();
  rmSync(tmp, { recursive: true, force: true });
  for (const key of ambientEnvKeys) {
    const value = priorEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function isInvalidDaemonPort(err: unknown): boolean {
  return (
    err instanceof Error &&
    (
      (err.name === "DaemonConfigError" &&
        (err as { key?: unknown }).key === "PORT") ||
      (err as NodeJS.ErrnoException).code === "ERR_SOCKET_BAD_PORT" ||
      err instanceof RangeError ||
      err.message.includes("PORT") ||
      err.message.includes("port")
    )
  );
}
