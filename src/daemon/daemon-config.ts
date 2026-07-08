import {
  DEFAULT_LOCAL_PUBLIC_ORIGIN,
  dashboardBaseUrl,
  loadMurmurPublicOrigin,
  publicApiBaseUrl,
  type MurmurPublicOrigin,
} from "../verdict/public-origin.js";
import { resolveVerdictDbPath } from "../verdict/db-bootstrap.js";
import {
  DEFAULT_FHENIX_REVEAL_GRACE_SEC,
  type OperatorFhenixLifecycleQueryDefaults,
} from "../verdict/operator-fhenix-lifecycle-query.js";
import {
  loadPrivyAuthConfig,
  type PrivyAuthConfig,
} from "../verdict/auth/privy.js";
import {
  loadOperatorAlertSinkConfig,
  type OperatorAlertSinkConfig,
} from "../verdict/operator-alerts.js";
import {
  loadWebhookUrlPolicy,
  type WebhookUrlPolicy,
} from "../verdict/webhook-url.js";
import {
  loadDaemonOracleRuntimeConfig,
  type DaemonOracleRuntimeConfig,
} from "./oracle-runtime.js";
import {
  loadFhenixRuntimeConfig,
  type FhenixRuntimeConfig,
} from "./fhenix-runtime.js";
import {
  loadDaemonNanopayRuntimeConfig,
  type DaemonNanopayRuntimeConfig,
} from "./nanopay-runtime.js";
import type { DaemonTickerIntervals } from "./tickers.js";

export type DashboardCorsConfig =
  | { kind: "any" }
  | { kind: "allowlist"; origins: string[] };

export interface DaemonRuntimeConfig {
  port: number;
  dbPath: string;
  adminToken: string;
  publicOrigin: MurmurPublicOrigin;
  resolverTickSec: number;
  dashboardCors: DashboardCorsConfig;
  requireLiveCanaries: boolean;
  polymarketGammaEnabled: boolean;
  fhenixRuntime: FhenixRuntimeConfig;
  nanopayRuntime: DaemonNanopayRuntimeConfig;
  oracleRuntime: DaemonOracleRuntimeConfig;
  operatorAlertSink: OperatorAlertSinkConfig;
  privyAuth: PrivyAuthConfig;
  openServLaunchpad: OpenServLaunchpadRuntimeConfig;
  webhookUrlPolicy: WebhookUrlPolicy;
  operatorFhenixLifecycleQueryDefaults: OperatorFhenixLifecycleQueryDefaults;
  intervals: DaemonTickerIntervals;
}

export interface OpenServLaunchpadRuntimeConfig {
  enabled: boolean;
  port: number;
  apiKey: string | null;
  authToken: string | null;
  dashboardUrl: string;
  publicApiUrl: string;
  launchpadStage: string;
  launchpadProjectId: string | null;
  launchpadProjectUrl: string | null;
}

export interface DaemonRuntimeOverrides {
  dbPath?: string;
  port?: number;
}

export class DaemonConfigError extends Error {
  readonly key: string;

  constructor(key: string, message: string) {
    super(`${key}: ${message}`);
    this.name = "DaemonConfigError";
    this.key = key;
  }
}

export function loadDaemonRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
  overrides: DaemonRuntimeOverrides = {},
): DaemonRuntimeConfig {
  const port = parsePort(overrides.port ?? env.PORT, 8080, "PORT");
  const resolverTickSec = parsePositiveSeconds(
    env.RESOLVER_TICK_SEC,
    30,
    "RESOLVER_TICK_SEC",
  );
  const fhenixEventTickSec = parsePositiveSeconds(
    env.FHENIX_EVENT_TICK_SEC,
    resolverTickSec,
    "FHENIX_EVENT_TICK_SEC",
  );
  const fhenixGatewayTickSec = parsePositiveSeconds(
    env.FHENIX_GATEWAY_TICK_SEC,
    10,
    "FHENIX_GATEWAY_TICK_SEC",
  );
  const feedSlaTickSec = parsePositiveSeconds(
    env.FEED_SLA_TICK_SEC,
    60,
    "FEED_SLA_TICK_SEC",
  );
  const liveCanaryTickSec = parsePositiveSeconds(
    env.LIVE_CANARY_TICK_SEC,
    300,
    "LIVE_CANARY_TICK_SEC",
  );
  const operatorAlertTickSec = parsePositiveSeconds(
    env.OPERATOR_ALERT_TICK_SEC,
    60,
    "OPERATOR_ALERT_TICK_SEC",
  );
  const publicOrigin = loadMurmurPublicOrigin(env);
  const fhenixRuntime = loadFhenixRuntimeConfig(env);

  return {
    port,
    dbPath: resolveVerdictDbPath(env, overrides.dbPath),
    adminToken: env.VERDICT_ADMIN_TOKEN ?? "",
    publicOrigin,
    resolverTickSec,
    dashboardCors: parseDashboardCors(env.DASHBOARD_ORIGIN),
    requireLiveCanaries: parseBooleanFlag(
      env.MURMUR_REQUIRE_LIVE_CANARIES,
      false,
      "MURMUR_REQUIRE_LIVE_CANARIES",
    ),
    polymarketGammaEnabled: parseBooleanFlag(
      env.MURMUR_POLYMARKET_GAMMA_ENABLED,
      false,
      "MURMUR_POLYMARKET_GAMMA_ENABLED",
    ),
    fhenixRuntime,
    nanopayRuntime: loadDaemonNanopayRuntimeConfig({
      env,
      fhenixChainId: fhenixRuntime.chainId,
      fhenixSealedVerdictsAddress: fhenixRuntime.sealedVerdictsAddress,
    }),
    oracleRuntime: loadDaemonOracleRuntimeConfig(env),
    operatorAlertSink: loadOperatorAlertSinkConfig(env),
    privyAuth: loadPrivyAuthConfig(env),
    openServLaunchpad: loadOpenServLaunchpadRuntimeConfig(env, publicOrigin),
    webhookUrlPolicy: loadWebhookUrlPolicy(env),
    operatorFhenixLifecycleQueryDefaults: {
      fhenixRevealGraceSec: parseIntegerRange(
        env.FHENIX_REVEAL_GRACE_SEC,
        DEFAULT_FHENIX_REVEAL_GRACE_SEC,
        "FHENIX_REVEAL_GRACE_SEC",
        0,
        30 * 24 * 60 * 60,
      ),
    },
    intervals: {
      resolverMs: resolverTickSec * 1000,
      fhenixEventMs: fhenixEventTickSec * 1000,
      fhenixGatewayMs: fhenixGatewayTickSec * 1000,
      feedSlaMs: feedSlaTickSec * 1000,
      liveCanaryMs: liveCanaryTickSec * 1000,
      operatorAlertMs: operatorAlertTickSec * 1000,
      statsMs: 10_000,
    },
  };
}

function loadOpenServLaunchpadRuntimeConfig(
  env: NodeJS.ProcessEnv,
  publicOrigin: MurmurPublicOrigin,
): OpenServLaunchpadRuntimeConfig {
  const apiKey = nonEmpty(env.OPENSERV_API_KEY);
  const configuredEnabled = parseBooleanFlag(
    env.OPENSERV_LAUNCHPAD_ENABLED,
    false,
    "OPENSERV_LAUNCHPAD_ENABLED",
  );
  const enabled = configuredEnabled && Boolean(apiKey);
  return {
    enabled,
    port: enabled
      ? parsePort(env.OPENSERV_LAUNCHPAD_PORT, 7378, "OPENSERV_LAUNCHPAD_PORT")
      : 7378,
    apiKey,
    authToken: nonEmpty(env.OPENSERV_AUTH_TOKEN),
    dashboardUrl: dashboardBaseUrl(publicOrigin) || DEFAULT_LOCAL_PUBLIC_ORIGIN,
    publicApiUrl: publicApiBaseUrl(publicOrigin),
    launchpadStage: nonEmpty(env.OPENSERV_LAUNCHPAD_STAGE) ?? "prelaunch",
    launchpadProjectId: nonEmpty(env.OPENSERV_LAUNCHPAD_PROJECT_ID),
    launchpadProjectUrl: nonEmpty(env.OPENSERV_LAUNCHPAD_PROJECT_URL),
  };
}

function parseDashboardCors(raw: string | undefined): DashboardCorsConfig {
  const dashboardOrigin = (raw ?? "*").trim();
  if (dashboardOrigin === "*") return { kind: "any" };
  if (!dashboardOrigin) {
    throw new DaemonConfigError(
      "DASHBOARD_ORIGIN",
      "must be '*' or a comma-separated origin allowlist",
    );
  }
  const origins = dashboardOrigin
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (origins.length === 0) {
    throw new DaemonConfigError(
      "DASHBOARD_ORIGIN",
      "must include at least one origin when not '*'",
    );
  }
  return {
    kind: "allowlist",
    origins,
  };
}

function nonEmpty(raw: string | undefined): string | null {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : null;
}

function parsePort(
  raw: number | string | undefined,
  fallback: number,
  key: string,
): number {
  if (raw === undefined || raw === "") return fallback;
  const value = typeof raw === "number" ? raw : Number(raw.trim());
  if (Number.isInteger(value) && value >= 0 && value <= 65_535) {
    return value;
  }
  throw new DaemonConfigError(key, "must be an integer from 0 to 65535");
}

function parsePositiveSeconds(
  raw: string | undefined,
  fallback: number,
  key: string,
): number {
  const trimmed = raw?.trim();
  if (!trimmed) return fallback;
  const value = Number(trimmed);
  if (Number.isFinite(value) && value > 0) {
    return value;
  }
  throw new DaemonConfigError(key, "must be a positive number of seconds");
}

function parseIntegerRange(
  raw: string | undefined,
  fallback: number,
  key: string,
  min: number,
  max: number,
): number {
  const trimmed = raw?.trim();
  if (!trimmed) return fallback;
  const value = Number(trimmed);
  if (Number.isInteger(value) && value >= min && value <= max) {
    return value;
  }
  throw new DaemonConfigError(key, `must be an integer from ${min} to ${max}`);
}

function parseBooleanFlag(
  raw: string | undefined,
  fallback: boolean,
  key: string,
): boolean {
  const normalized = raw?.trim().toLowerCase();
  if (!normalized) return fallback;
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  throw new DaemonConfigError(key, "must be one of true, false, 1, or 0");
}
