import type Database from "better-sqlite3";
import {
  LiveCanaryRunner,
  loadLiveCanaryConfig,
  type LiveCanaryConfig,
  type LiveCanaryProvider,
} from "../integrations/live-canaries.js";
import {
  loadOperatorAlertSinkConfig,
  type OperatorAlertSinkConfig,
} from "../verdict/operator-alerts.js";

export interface OperatorObservabilityRuntime {
  liveCanaries: LiveCanaryProvider;
  operatorAlertSink: OperatorAlertSinkConfig;
}

export interface OperatorObservabilityRuntimeConfig {
  liveCanaries: LiveCanaryConfig;
  operatorAlertSink: OperatorAlertSinkConfig;
}

export interface OperatorObservabilityRuntimeOptions {
  config?: OperatorObservabilityRuntimeConfig;
  env?: NodeJS.ProcessEnv;
  now: () => Date;
}

export interface LoadOperatorObservabilityRuntimeConfigOptions {
  fhenixSealedVerdictsAddress?: string | null;
  now: () => Date;
  operatorAlertSink?: OperatorAlertSinkConfig;
  polymarketGammaEnabled?: boolean;
}

export function loadOperatorObservabilityRuntimeConfig(
  db: Database.Database,
  schemaVersion: number,
  env: NodeJS.ProcessEnv,
  opts: LoadOperatorObservabilityRuntimeConfigOptions,
): OperatorObservabilityRuntimeConfig {
  return {
    liveCanaries: loadLiveCanaryConfig(db, schemaVersion, env, {
      fhenixContractAddress: opts.fhenixSealedVerdictsAddress,
      nowMs: () => opts.now().getTime(),
      polymarketGammaEnabled: opts.polymarketGammaEnabled,
    }),
    operatorAlertSink: opts.operatorAlertSink ?? loadOperatorAlertSinkConfig(env),
  };
}

export function loadOperatorObservabilityRuntime(
  db: Database.Database,
  schemaVersion: number,
  opts: OperatorObservabilityRuntimeOptions,
): OperatorObservabilityRuntime {
  const config = opts.config ??
    loadOperatorObservabilityRuntimeConfig(db, schemaVersion, opts.env ?? process.env, {
      now: opts.now,
    });
  return {
    liveCanaries: new LiveCanaryRunner({
      config: config.liveCanaries,
      now: opts.now,
    }),
    operatorAlertSink: config.operatorAlertSink,
  };
}
