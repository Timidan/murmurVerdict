import express, { type Express } from "express";
import type Database from "better-sqlite3";
import {
  loadNanopayRuntimeConfig,
  type NanopayRuntimeDecision,
  type NanopayRuntimeConfig,
} from "../verdict/nanopay-config.js";
import { createNanopaySignalResolver } from "../verdict/nanopay-signal-resolver.js";
import { nanopayRouter } from "../verdict/routes/nanopay.js";

export interface DaemonNanopayRuntime {
  mount: (app: Express) => void;
}

export type DaemonNanopayRuntimeConfig = NanopayRuntimeDecision;

export interface LoadDaemonNanopayRuntimeConfigDeps {
  env: NodeJS.ProcessEnv;
  fhenixChainId: number | null;
  fhenixSealedVerdictsAddress: string | null;
  logger?: Pick<Console, "log" | "warn">;
}

export interface LoadDaemonNanopayRuntimeDeps {
  db: Database.Database;
  config: DaemonNanopayRuntimeConfig;
  logger?: Pick<Console, "log" | "warn">;
  now: () => Date;
}

export interface LoadDaemonNanopayRuntimeFromEnvDeps
  extends LoadDaemonNanopayRuntimeConfigDeps {
  db: Database.Database;
  now: () => Date;
}

export function loadDaemonNanopayRuntimeConfig(
  deps: LoadDaemonNanopayRuntimeConfigDeps,
): DaemonNanopayRuntimeConfig {
  return loadNanopayRuntimeConfig(deps);
}

export function loadDaemonNanopayRuntime(
  deps: LoadDaemonNanopayRuntimeDeps | LoadDaemonNanopayRuntimeFromEnvDeps,
): DaemonNanopayRuntime | null {
  const { db, logger = console } = deps;
  const config = "config" in deps
    ? deps.config
    : loadDaemonNanopayRuntimeConfig(deps);

  if (config.kind !== "mounted") return null;

  return createDaemonNanopayRuntime({
    db,
    config: config.config,
    logger,
    now: deps.now,
  });
}

export function mountNanopayRuntime(
  app: Express,
  runtime: DaemonNanopayRuntime | null | undefined,
): void {
  runtime?.mount(app);
}

function createDaemonNanopayRuntime(deps: {
  db: Database.Database;
  config: NanopayRuntimeConfig;
  logger: Pick<Console, "log" | "warn">;
  now: () => Date;
}): DaemonNanopayRuntime {
  const { db, config, logger, now } = deps;
  const {
    network,
    bindingDomain,
    sellerAddress,
    defaultPrice,
    acceptNetworks,
    pipelineCatalog,
    pipelineAgentMap,
  } = config;

  const resolvePipeline = (pipelineId: string) => {
    return pipelineCatalog.get(pipelineId.toLowerCase()) ?? null;
  };

  const resolveLatestSealedCall = createNanopaySignalResolver({
    db,
    pipelineAgentMap,
    logger,
  });

  return {
    mount(app: Express) {
      app.use("/v2/nanopay", express.json({ limit: "16kb" }));
      app.use(
        nanopayRouter({
          db,
          network,
          bindingDomain,
          sellerAddress,
          now,
          defaultPrice,
          acceptNetworks,
          resolvePipeline,
          resolveLatestSealedCall,
        }),
      );
      logger.log(
        `[daemon] Nanopayments route mounted on POST /v2/nanopay/infer/:pipelineId (network=${network}, seller=${sellerAddress}, price=${defaultPrice})`,
      );
    },
  };
}
