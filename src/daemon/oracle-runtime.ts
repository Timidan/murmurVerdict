import { OracleClient } from "../integrations/oracle.js";
import { CHAINLINK_BASE_ETH_USD_DEFAULT } from "../integrations/oracle-chainlink.js";
import { HERMES_LATEST } from "../integrations/oracle-pyth.js";

export const DEFAULT_DAEMON_BASE_MAINNET_RPC_URL = "https://mainnet.base.org";

export interface DaemonOracleRuntime {
  oracle: OracleClient | null;
  baseRpcUrl: string;
  chainlinkEthUsdAddress: `0x${string}`;
  hermesEndpoint: string;
  usedDefaultBaseRpcUrl: boolean;
}

export interface DaemonOracleRuntimeConfig {
  baseRpcUrl: string;
  chainlinkEthUsdAddress: `0x${string}`;
  hermesEndpoint: string;
  usedDefaultBaseRpcUrl: boolean;
}

interface DaemonOracleLogger {
  log: (message: string) => void;
  warn: (message: string, details?: unknown) => void;
}

export interface DaemonOracleRuntimeOptions {
  config?: DaemonOracleRuntimeConfig;
  env?: NodeJS.ProcessEnv;
  logger?: DaemonOracleLogger;
  now: () => Date;
}

export class DaemonOracleRuntimeConfigError extends Error {
  readonly key: string;

  constructor(key: string, message: string) {
    super(`${key}: ${message}`);
    this.name = "DaemonOracleRuntimeConfigError";
    this.key = key;
  }
}

export function loadDaemonOracleRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): DaemonOracleRuntimeConfig {
  const configuredBaseRpcUrl = env.BASE_MAINNET_RPC_URL?.trim();
  const baseRpcUrl = parseHttpUrl(
    configuredBaseRpcUrl,
    DEFAULT_DAEMON_BASE_MAINNET_RPC_URL,
    "BASE_MAINNET_RPC_URL",
  );
  const usedDefaultBaseRpcUrl = !configuredBaseRpcUrl;
  const chainlinkEthUsdAddress = parseAddress(
    env.CHAINLINK_BASE_ETH_USD_ADDRESS?.trim() ||
      CHAINLINK_BASE_ETH_USD_DEFAULT,
    "CHAINLINK_BASE_ETH_USD_ADDRESS",
  );
  const hermesEndpoint = parseHttpUrl(
    env.PYTH_HERMES_ENDPOINT?.trim(),
    HERMES_LATEST,
    "PYTH_HERMES_ENDPOINT",
  );

  return {
    baseRpcUrl,
    chainlinkEthUsdAddress,
    hermesEndpoint,
    usedDefaultBaseRpcUrl,
  };
}

export function loadDaemonOracleRuntime(
  opts: DaemonOracleRuntimeOptions,
): DaemonOracleRuntime {
  const logger = opts.logger ?? console;
  const config = opts.config ?? loadDaemonOracleRuntimeConfig(opts.env);
  const {
    baseRpcUrl,
    chainlinkEthUsdAddress,
    hermesEndpoint,
    usedDefaultBaseRpcUrl,
  } = config;

  if (config.usedDefaultBaseRpcUrl) {
    logger.log(
      "[daemon] BASE_MAINNET_RPC_URL unset; defaulting to public https://mainnet.base.org (rate-limited; set a paid RPC URL for production load)",
    );
  }

  try {
    return {
      oracle: new OracleClient({
        baseRpcUrl,
        chainlinkEthUsdAddress,
        hermesEndpoint,
        now: opts.now,
      }),
      baseRpcUrl,
      chainlinkEthUsdAddress,
      hermesEndpoint,
      usedDefaultBaseRpcUrl,
    };
  } catch (err) {
    logger.warn(
      "[daemon] OracleClient init failed:",
      err instanceof Error ? err.message : err,
    );
    return {
      oracle: null,
      baseRpcUrl,
      chainlinkEthUsdAddress,
      hermesEndpoint,
      usedDefaultBaseRpcUrl,
    };
  }
}

function parseHttpUrl(
  raw: string | undefined,
  fallback: string,
  key: string,
): string {
  const value = raw || fallback;
  try {
    const parsed = new URL(value);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return value;
    }
  } catch {
    // Re-throw below with a stable config error shape.
  }
  throw new DaemonOracleRuntimeConfigError(
    key,
    "must be an http or https URL",
  );
}

function parseAddress(value: string, key: string): `0x${string}` {
  if (/^0x[0-9a-fA-F]{40}$/.test(value)) {
    return value as `0x${string}`;
  }
  throw new DaemonOracleRuntimeConfigError(
    key,
    "must be a 20-byte 0x-prefixed address",
  );
}
