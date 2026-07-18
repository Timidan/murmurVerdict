import type Database from "better-sqlite3";
import { parseBooleanToken } from "../verdict/env-grammar.js";
import {
  loadFhenixEventVerifierConfig,
  ViemFhenixEventVerifier,
  type ViemFhenixEventVerifierConfig,
  type FhenixEventVerifier,
} from "../integrations/fhenix-events.js";
import {
  FhenixGatewayBroadcaster,
} from "../integrations/fhenix-gateway.js";
import type { FhenixGatewayRuntimeTimers } from "../integrations/fhenix-gateway-runtime.js";
import type { FeedPacketIdAdapter } from "../verdict/feed-packet-ingestion.js";
import type { SealedCallIdAdapter } from "../verdict/sealed-call-acceptance.js";
import {
  loadFhenixGatewayEnvConfig,
  type FhenixGatewayEnvConfig,
} from "../integrations/fhenix-gateway-env.js";
import {
  FhenixEventIngestor,
  loadFhenixEventIngestorConfig,
  type FhenixEventIngestorRuntimeConfig,
} from "../integrations/fhenix-watcher.js";
import {
  resolveFhenixChainId,
  resolveFhenixDeploymentAddresses,
} from "../integrations/deployments.js";

export interface FhenixRuntime {
  verifier: FhenixEventVerifier | null;
  ingestor: { tick: () => Promise<unknown> } | null;
  gateway: FhenixGatewayBroadcaster | null;
  chainId: number | null;
  sealedVerdictsAddress: string | null;
}

export interface FhenixRuntimeConfig {
  verifier: ViemFhenixEventVerifierConfig | null;
  ingestor: FhenixEventIngestorRuntimeConfig | null;
  gateway: FhenixGatewayEnvConfig | null;
  chainId: number | null;
  sealedVerdictsAddress: string | null;
  escrowAddress: string | null;
  gatewayEnabled: boolean;
  rpcConfigured: boolean;
}

export interface FhenixRuntimeOptions {
  config?: FhenixRuntimeConfig;
  env?: NodeJS.ProcessEnv;
  gatewayTimers?: FhenixGatewayRuntimeTimers;
  gatewayAttemptId?: () => string;
  gatewayClaimToken?: () => string;
  gatewayFeedPacketId?: FeedPacketIdAdapter;
  gatewaySealedCallId?: SealedCallIdAdapter;
  logger?: Pick<Console, "log" | "warn">;
  now: () => Date;
}

export class FhenixRuntimeConfigError extends Error {
  readonly key: string;

  constructor(key: string, message: string) {
    super(`${key}: ${message}`);
    this.name = "FhenixRuntimeConfigError";
    this.key = key;
  }
}

export function loadFhenixRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): FhenixRuntimeConfig {
  const chainId = resolveFhenixChainId(env);
  const gatewayEnabled = parseBooleanFlag(
    env.FHENIX_GATEWAY_ENABLED,
    false,
    "FHENIX_GATEWAY_ENABLED",
  );
  const deploymentAddresses = resolveFhenixDeploymentAddresses(
    chainId ?? undefined,
    env,
  );

  return {
    verifier: loadFhenixEventVerifierConfig(env, {
      contractAddress: deploymentAddresses.sealedVerdictsAddress,
    }),
    ingestor: loadFhenixEventIngestorConfig(env, {
      contractAddress: deploymentAddresses.sealedVerdictsAddress,
    }),
    gateway: loadFhenixGatewayEnvConfig(env, {
      contractAddress: deploymentAddresses.sealedVerdictsAddress,
      enabled: gatewayEnabled,
    }),
    chainId,
    sealedVerdictsAddress: deploymentAddresses.sealedVerdictsAddress,
    escrowAddress: deploymentAddresses.escrowAddress,
    gatewayEnabled,
    rpcConfigured: Boolean(env.FHENIX_RPC_URL?.trim()),
  };
}

export async function loadFhenixRuntime(
  db: Database.Database,
  opts: FhenixRuntimeOptions,
): Promise<FhenixRuntime> {
  const logger = opts.logger ?? console;
  const config = opts.config ?? loadFhenixRuntimeConfig(opts.env);
  const verifier = config.verifier
    ? new ViemFhenixEventVerifier(config.verifier)
    : null;
  const ingestor = verifier && config.ingestor
    ? new FhenixEventIngestor({
        db,
        verifier,
        ...config.ingestor,
        now: opts.now,
      })
    : null;
  const gateway = config.gateway
    ? new FhenixGatewayBroadcaster({
        db,
        ...config.gateway,
        timers: opts.gatewayTimers,
        newAttemptId: opts.gatewayAttemptId,
        newClaimToken: opts.gatewayClaimToken,
        newFeedPacketId: opts.gatewayFeedPacketId,
        newSealedCallId: opts.gatewaySealedCallId,
        now: opts.now,
      })
    : null;

  if (verifier && !ingestor && config.rpcConfigured) {
    logger.warn(
      "[daemon] Fhenix verifier is configured, but event watcher is disabled; set FHENIX_CHAIN_ID and either FHENIX_SEALED_VERDICTS_ADDRESS or run sync-deployments to index reveals",
    );
  }

  logger.log(
    "[daemon] Fhenix config:",
    JSON.stringify({
      chainId: config.chainId,
      sealedVerdictsAddress: config.sealedVerdictsAddress,
      escrowAddress: config.escrowAddress,
      gatewayEnabled: config.gatewayEnabled,
      verifierActive: Boolean(verifier),
      ingestorActive: Boolean(ingestor),
      gatewayActive: Boolean(gateway),
    }),
  );

  return {
    verifier,
    ingestor,
    gateway,
    chainId: config.chainId,
    sealedVerdictsAddress: config.sealedVerdictsAddress,
  };
}

function parseBooleanFlag(
  raw: string | undefined,
  fallback: boolean,
  key: string,
): boolean {
  if (!raw?.trim()) return fallback;
  const value = parseBooleanToken(raw);
  if (value === undefined) {
    throw new FhenixRuntimeConfigError(
      key,
      "must be one of true, false, 1, or 0",
    );
  }
  return value;
}
