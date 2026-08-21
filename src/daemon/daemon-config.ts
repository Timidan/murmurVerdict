import {
  assertSeriesClockConfig,
  type SeriesClockConfig,
} from "../verdict/series-clock.js";
import {
  DEFAULT_LOCAL_PUBLIC_ORIGIN,
  dashboardBaseUrl,
  loadMurmurPublicOrigin,
  publicApiBaseUrl,
  type MurmurPublicOrigin,
} from "../verdict/public-origin.js";
import { resolveVerdictDbPath } from "../verdict/db-bootstrap.js";
import {
  parseBooleanToken,
  resolvePolymarketGammaEnabled,
} from "../verdict/env-grammar.js";
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
  /** Number of reverse-proxy hops Express may trust for req.ip. Zero is safe for direct exposure. */
  trustProxyHops: number;
  dbPath: string;
  adminToken: string;
  publicOrigin: MurmurPublicOrigin;
  /** Deployment-specific runtime-key PoP audience (MURMUR_POP_AUDIENCE).
   *  Distinct per deployment so a DB clone with the same runtime-key
   *  material cannot replay signed requests across environments. */
  popAudience: string | undefined;
  resolverTickSec: number;
  dashboardCors: DashboardCorsConfig;
  requireLiveCanaries: boolean;
  polymarketGammaEnabled: boolean;
  fhenixRuntime: FhenixRuntimeConfig;
  nanopayRuntime: DaemonNanopayRuntimeConfig;
  operatorAlertSink: OperatorAlertSinkConfig;
  privyAuth: PrivyAuthConfig;
  /**
   * Signing secret for the inbound Privy `user.transferred_account` webhook
   * (dashboard endpoint secret, `whsec_...`). `null` disables the receiver
   * (route answers 503). When set, PRIVY_APP_ID + PRIVY_APP_SECRET are
   * required — the verifier needs the Privy client to check the svix signature.
   */
  privyWebhookSigningSecret: string | null;
  openServLaunchpad: OpenServLaunchpadRuntimeConfig;
  webhookUrlPolicy: WebhookUrlPolicy;
  operatorFhenixLifecycleQueryDefaults: OperatorFhenixLifecycleQueryDefaults;
  polymarketDiscovery: PolymarketDiscoveryRuntimeConfig;
  /**
   * Live venue ticker (websocket order book + resolution feed for the public
   * market board). DERIVED, never a required var: it is on exactly when
   * discovery is on — a deployment that registers no Polymarket markets has
   * nothing to stream — and `MURMUR_VENUE_TICKER_ENABLED=false` is the
   * explicit opt-out for keeping discovery while dropping the socket.
   */
  venueTickerEnabled: boolean;
  intervals: DaemonTickerIntervals;
}

export interface PolymarketDiscoveryRuntimeConfig {
  enabled: boolean;
  tickSec: number;
  lookaheadMin: number;
  minLeadSec: number;
  questionFilter: string;
  assets: string[];
  windowDurationSec: number;
  seriesClock: SeriesClockConfig;
  maxArmedPerCall: number;
  seriesVersion: number;
  maxPerTick: number;
  maxPerHour: number;
  maxPerDay: number;
  minBalanceWei: bigint;
  warnBalanceWei: bigint;
  maxRegisterCostWei: bigint;
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
  const fhenixRevealWorkerTickSec = parsePositiveSeconds(
    env.FHENIX_REVEAL_WORKER_TICK_SEC,
    30,
    "FHENIX_REVEAL_WORKER_TICK_SEC",
  );
  const fhenixGrantReconcilerTickSec = parsePositiveSeconds(
    env.FHENIX_GRANT_RECONCILER_TICK_SEC,
    30,
    "FHENIX_GRANT_RECONCILER_TICK_SEC",
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
  const popAudience = env.MURMUR_POP_AUDIENCE?.trim() || undefined;
  const fhenixRuntime = loadFhenixRuntimeConfig(env);
  const privyAuth = loadPrivyAuthConfig(env);
  const polymarketGammaEnabled = resolvePolymarketGammaEnabled(env);
  const polymarketDiscovery = loadPolymarketDiscoveryRuntimeConfig(env, {
    polymarketGammaEnabled,
    fhenixGatewayConfigured: fhenixRuntime.gateway !== null,
  });

  return {
    port,
    trustProxyHops: parseIntegerRange(
      env.MURMUR_TRUST_PROXY_HOPS,
      0,
      "MURMUR_TRUST_PROXY_HOPS",
      0,
      10,
    ),
    dbPath: resolveVerdictDbPath(env, overrides.dbPath),
    adminToken: env.VERDICT_ADMIN_TOKEN ?? "",
    publicOrigin,
    popAudience,
    resolverTickSec,
    dashboardCors: parseDashboardCors(env.DASHBOARD_ORIGIN),
    requireLiveCanaries: parseBooleanFlag(
      env.MURMUR_REQUIRE_LIVE_CANARIES,
      false,
      "MURMUR_REQUIRE_LIVE_CANARIES",
    ),
    // Default ON: Gamma is a public key-less API, the sync ticker no-ops with
    // zero Polymarket markets, and the resolver needs this adapter registered
    // for any admin-registered polymarket market to resolve. Set =false to opt
    // out explicitly.
    polymarketGammaEnabled,
    fhenixRuntime,
    nanopayRuntime: loadDaemonNanopayRuntimeConfig({
      env,
      fhenixChainId: fhenixRuntime.chainId,
      fhenixSealedVerdictsAddress: fhenixRuntime.sealedVerdictsAddress,
    }),
    operatorAlertSink: loadOperatorAlertSinkConfig(env),
    privyAuth,
    privyWebhookSigningSecret: loadPrivyWebhookSigningSecret(env, privyAuth),
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
    polymarketDiscovery,
    venueTickerEnabled:
      polymarketDiscovery.enabled &&
      parseBooleanToken(env.MURMUR_VENUE_TICKER_ENABLED, { yesNo: true }) !==
        false,
    intervals: {
      resolverMs: resolverTickSec * 1000,
      fhenixEventMs: fhenixEventTickSec * 1000,
      fhenixGatewayMs: fhenixGatewayTickSec * 1000,
      fhenixRevealWorkerMs: fhenixRevealWorkerTickSec * 1000,
      fhenixGrantReconcilerMs: fhenixGrantReconcilerTickSec * 1000,
      feedSlaMs: feedSlaTickSec * 1000,
      liveCanaryMs: liveCanaryTickSec * 1000,
      operatorAlertMs: operatorAlertTickSec * 1000,
      polymarketDiscoveryMs: polymarketDiscovery.tickSec * 1000,
      statsMs: 10_000,
    },
  };
}

// Every write the discovery ticker makes spends owner-key gas, so an
// invalid enabled configuration refuses to start instead of guessing.
function loadPolymarketDiscoveryRuntimeConfig(
  env: NodeJS.ProcessEnv,
  runtime: { polymarketGammaEnabled: boolean; fhenixGatewayConfigured: boolean },
): PolymarketDiscoveryRuntimeConfig {
  const enabled = parseBooleanFlag(
    env.POLYMARKET_DISCOVERY_ENABLED,
    false,
    "POLYMARKET_DISCOVERY_ENABLED",
  );
  const tickSec = parsePositiveSeconds(
    env.POLYMARKET_DISCOVERY_TICK_SEC,
    60,
    "POLYMARKET_DISCOVERY_TICK_SEC",
  );
  const lookaheadMin = parseIntegerRange(
    env.POLYMARKET_DISCOVERY_LOOKAHEAD_MIN,
    20,
    "POLYMARKET_DISCOVERY_LOOKAHEAD_MIN",
    1,
    24 * 60,
  );
  const minLeadSec = parseIntegerRange(
    env.POLYMARKET_DISCOVERY_MIN_LEAD_SEC,
    120,
    "POLYMARKET_DISCOVERY_MIN_LEAD_SEC",
    0,
    60 * 60,
  );
  // Series clock constants. Every on-chain instant derives from these, so an
  // inverted config yields a schedule that is silently unusable rather than
  // obviously broken — assertSeriesClockConfig rejects that at boot.
  const seriesClock: SeriesClockConfig = {
    submissionOpenLeadSec: parseIntegerRange(
      env.POLYMARKET_DISCOVERY_SUBMISSION_OPEN_LEAD_SEC,
      300,
      "POLYMARKET_DISCOVERY_SUBMISSION_OPEN_LEAD_SEC",
      1,
      24 * 60 * 60,
    ),
    commitMarginSec: parseIntegerRange(
      env.POLYMARKET_DISCOVERY_COMMIT_MARGIN_SEC,
      60,
      "POLYMARKET_DISCOVERY_COMMIT_MARGIN_SEC",
      1,
      60 * 60,
    ),
    deliveryBudgetSec: parseIntegerRange(
      env.POLYMARKET_DISCOVERY_DELIVERY_BUDGET_SEC,
      60,
      "POLYMARKET_DISCOVERY_DELIVERY_BUDGET_SEC",
      1,
      60 * 60,
    ),
    embargoSec: parseIntegerRange(
      env.POLYMARKET_DISCOVERY_EMBARGO_SEC,
      600,
      "POLYMARKET_DISCOVERY_EMBARGO_SEC",
      1,
      30 * 24 * 60 * 60,
    ),
  };
  assertSeriesClockConfig(seriesClock);

  const questionFilter =
    env.POLYMARKET_DISCOVERY_QUESTION_FILTER?.trim() || "Up or Down";
  const assets = (env.POLYMARKET_DISCOVERY_ASSETS ?? "Bitcoin,Ethereum")
    .split(",")
    .map((asset) => asset.trim())
    .filter(Boolean);
  const config: PolymarketDiscoveryRuntimeConfig = {
    enabled,
    tickSec,
    lookaheadMin,
    minLeadSec,
    questionFilter,
    assets,
    windowDurationSec: parseIntegerRange(
      env.POLYMARKET_DISCOVERY_WINDOW_DURATION_SEC,
      300,
      "POLYMARKET_DISCOVERY_WINDOW_DURATION_SEC",
      60,
      24 * 60 * 60,
    ),
    seriesClock,
    // Falls back to the grant cap, never to an invented number: this value is
    // persisted as the series' max_armed_per_call and eligibility prefers it
    // over the global env, so a discovery default that disagreed with
    // FHENIX_GRANT_MAX_ARMED_PER_CALL would silently override the operator's
    // stated sales limit for every market it registers.
    // ONE source: the grant cap. POLYMARKET_DISCOVERY_MAX_ARMED_PER_CALL was a
    // second name for the same number, and the two disagreeing meant discovery
    // stamped a series cap that eligibility would not honour.
    //
    // Since per-provider terms landed this is purely a DELIVERABILITY bound —
    // how many grants can confirm inside the delivery budget — not a sales
    // limit. Owners set their own ceiling; this clamps it.
    //
    // Required only when discovery is ENABLED: it is written onto every series
    // registered, so there is no number to guess. A daemon that never runs
    // discovery must not be forced to state one; the unreachable placeholder
    // is 1, the minimum, so it can never widen a cohort.
    maxArmedPerCall: parseIntegerRange(
      env.FHENIX_GRANT_MAX_ARMED_PER_CALL,
      enabled ? 0 : 1,
      "FHENIX_GRANT_MAX_ARMED_PER_CALL",
      1,
      500,
    ),
    // Bump when intentionally changing clock constants. Existing markets keep
    // the schedule they were registered with; new markets bind to the new
    // series. Without this, a constant change fails the preflight every tick
    // with no legal way forward.
    seriesVersion: parseIntegerRange(
      env.POLYMARKET_DISCOVERY_SERIES_VERSION,
      1,
      "POLYMARKET_DISCOVERY_SERIES_VERSION",
      1,
      10_000,
    ),
    maxPerTick: parseIntegerRange(
      env.POLYMARKET_DISCOVERY_MAX_PER_TICK,
      4,
      "POLYMARKET_DISCOVERY_MAX_PER_TICK",
      1,
      100,
    ),
    maxPerHour: parseIntegerRange(
      env.POLYMARKET_DISCOVERY_MAX_PER_HOUR,
      30,
      "POLYMARKET_DISCOVERY_MAX_PER_HOUR",
      1,
      10_000,
    ),
    maxPerDay: parseIntegerRange(
      env.POLYMARKET_DISCOVERY_MAX_PER_DAY,
      650,
      "POLYMARKET_DISCOVERY_MAX_PER_DAY",
      1,
      100_000,
    ),
    // Hard stop / warning reserve for the shared owner+relayer balance —
    // discovery must never drain the account the Gateway relays with.
    minBalanceWei: parseWei(
      env.POLYMARKET_DISCOVERY_MIN_BALANCE_WEI,
      50_000_000_000_000_000n, // 0.05 ETH
      "POLYMARKET_DISCOVERY_MIN_BALANCE_WEI",
    ),
    warnBalanceWei: parseWei(
      env.POLYMARKET_DISCOVERY_WARN_BALANCE_WEI,
      200_000_000_000_000_000n, // 0.2 ETH
      "POLYMARKET_DISCOVERY_WARN_BALANCE_WEI",
    ),
    maxRegisterCostWei: parseWei(
      env.POLYMARKET_DISCOVERY_MAX_REGISTER_COST_WEI,
      500_000_000_000_000n, // 0.0005 ETH per registration
      "POLYMARKET_DISCOVERY_MAX_REGISTER_COST_WEI",
    ),
  };
  if (!enabled) return config;
  if (!runtime.polymarketGammaEnabled) {
    throw new DaemonConfigError(
      "POLYMARKET_DISCOVERY_ENABLED",
      "requires the Polymarket Gamma adapter (MURMUR_POLYMARKET_GAMMA_ENABLED must not be false)",
    );
  }
  if (!runtime.fhenixGatewayConfigured) {
    throw new DaemonConfigError(
      "POLYMARKET_DISCOVERY_ENABLED",
      "requires the Fhenix gateway relayer (FHENIX_GATEWAY_ENABLED=true with FHENIX_RPC_URL, FHENIX_CHAIN_ID, and FHENIX_GATEWAY_RELAYER_PRIVATE_KEY) — on-chain registration signs with the owner/relayer key",
    );
  }
  if (assets.length === 0) {
    throw new DaemonConfigError(
      "POLYMARKET_DISCOVERY_ASSETS",
      "must list at least one asset name when discovery is enabled",
    );
  }
  if (lookaheadMin * 60 <= minLeadSec) {
    throw new DaemonConfigError(
      "POLYMARKET_DISCOVERY_LOOKAHEAD_MIN",
      "lookahead window must extend past POLYMARKET_DISCOVERY_MIN_LEAD_SEC",
    );
  }
  if (config.warnBalanceWei < config.minBalanceWei) {
    throw new DaemonConfigError(
      "POLYMARKET_DISCOVERY_WARN_BALANCE_WEI",
      "must be >= POLYMARKET_DISCOVERY_MIN_BALANCE_WEI",
    );
  }
  return config;
}

function parseWei(
  raw: string | undefined,
  fallback: bigint,
  key: string,
): bigint {
  const trimmed = raw?.trim();
  if (!trimmed) return fallback;
  if (!/^[0-9]+$/.test(trimmed)) {
    throw new DaemonConfigError(key, "must be a non-negative integer wei amount");
  }
  return BigInt(trimmed);
}

function loadOpenServLaunchpadRuntimeConfig(
  env: NodeJS.ProcessEnv,
  publicOrigin: MurmurPublicOrigin,
): OpenServLaunchpadRuntimeConfig {
  const apiKey = nonEmpty(env.OPENSERV_API_KEY);
  const configuredEnabled = parseBooleanFlag(
    env.OPENSERV_LAUNCHPAD_ENABLED,
    Boolean(apiKey),
    "OPENSERV_LAUNCHPAD_ENABLED",
  );
  if (configuredEnabled && !apiKey) {
    throw new DaemonConfigError(
      "OPENSERV_API_KEY",
      "is required when OPENSERV_LAUNCHPAD_ENABLED is true",
    );
  }
  return {
    enabled: configuredEnabled,
    port: parsePort(env.OPENSERV_LAUNCHPAD_PORT, 7378, "OPENSERV_LAUNCHPAD_PORT"),
    apiKey,
    authToken: nonEmpty(env.OPENSERV_AUTH_TOKEN),
    dashboardUrl: dashboardBaseUrl(publicOrigin) || DEFAULT_LOCAL_PUBLIC_ORIGIN,
    publicApiUrl: publicApiBaseUrl(publicOrigin),
    launchpadStage: nonEmpty(env.OPENSERV_LAUNCHPAD_STAGE) ?? "prelaunch",
    launchpadProjectId: nonEmpty(env.OPENSERV_LAUNCHPAD_PROJECT_ID),
    launchpadProjectUrl: nonEmpty(env.OPENSERV_LAUNCHPAD_PROJECT_URL),
  };
}

function loadPrivyWebhookSigningSecret(
  env: NodeJS.ProcessEnv,
  privyAuth: PrivyAuthConfig,
): string | null {
  // NOTE: the env var is PRIVY_WEBHOOK_SIGNING_SECRET (not ...KEY). Pass the
  // dashboard endpoint secret (`whsec_...`) through unchanged — the SDK
  // strips/decodes it.
  const secret = nonEmpty(env.PRIVY_WEBHOOK_SIGNING_SECRET);
  if (!secret) return null;
  // Fail loud rather than pretend the receiver is enabled: without the Privy
  // client (APP_ID + APP_SECRET) the svix signature cannot be verified.
  if (!privyAuth.appId) {
    throw new DaemonConfigError(
      "PRIVY_APP_ID",
      "is required when PRIVY_WEBHOOK_SIGNING_SECRET is set (the transfer webhook verifier needs the Privy client)",
    );
  }
  if (!privyAuth.appSecret) {
    throw new DaemonConfigError(
      "PRIVY_APP_SECRET",
      "is required when PRIVY_WEBHOOK_SIGNING_SECRET is set (the transfer webhook verifier needs the Privy client)",
    );
  }
  return secret;
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

/**
 * First env value that is actually stated. Treats the empty string as absent:
 * docker-compose renders `${FOO:-}` for an unset variable, so `a ?? b` and
 * `a || b` behave differently in Docker than they do from a shell.
 */
function firstStated(...values: (string | undefined)[]): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function parseIntegerRange(
  raw: string | undefined,
  fallback: number,
  key: string,
  min: number,
  max: number,
): number {
  const trimmed = raw?.trim();
  if (!trimmed) {
    // The fallback is validated too. It used to be returned as-is, so a
    // caller passing a sentinel like 0 (meaning "there is no default") got
    // that sentinel silently written into config instead of an error.
    if (!Number.isInteger(fallback) || fallback < min || fallback > max) {
      throw new DaemonConfigError(
        key,
        `is required — must be an integer from ${min} to ${max} (there is no default)`,
      );
    }
    return fallback;
  }
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
  if (!raw?.trim()) return fallback;
  const value = parseBooleanToken(raw);
  if (value === undefined) {
    throw new DaemonConfigError(key, "must be one of true, false, 1, or 0");
  }
  return value;
}
