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
import type { FhenixMarketRegistrar } from "../integrations/fhenix-market-registration.js";
import {
  FhenixEventIngestor,
  loadFhenixEventIngestorConfig,
  type FhenixEventIngestorRuntimeConfig,
} from "../integrations/fhenix-watcher.js";
import { FhenixRevealWorker } from "../integrations/fhenix-reveal-worker.js";
import {
  loadFhenixRevealWorkerEnvConfig,
  type FhenixRevealWorkerEnvConfig,
} from "../integrations/fhenix-reveal-worker-env.js";
import {
  loadFhenixGrantEnvConfig,
  type FhenixGrantEnvConfig,
} from "../integrations/fhenix-grant-env.js";
import { FhenixGrantReconciler } from "../integrations/fhenix-grant-reconciler.js";
import type { EntitlementAccessDeps } from "../verdict/entitlement-access.js";
import {
  resolveFhenixChainId,
  resolveFhenixDeploymentAddresses,
} from "../integrations/deployments.js";
import { fhenixSealedCallsRepo } from "../verdict/repos/fhenix-sealed-calls-repo.js";
import {
  parseProtocolFeeBps,
  ProtocolFeeConfigError,
} from "../verdict/protocol-fee.js";

export interface FhenixRuntime {
  verifier: FhenixEventVerifier | null;
  ingestor: { tick: () => Promise<unknown> } | null;
  /** Murmur-owned fallback reveal worker (openReveal → decrypt →
   *  publishReveal). null unless FHENIX_REVEAL_WORKER_ENABLED. */
  revealWorker: { tick: () => Promise<unknown> } | null;
  gateway: FhenixGatewayBroadcaster | null;
  /** Owner-plane market registrar on the shared relayer account/broadcast
   *  queue; present whenever the gateway env config loaded. The raw key
   *  never leaves fhenix-gateway-env. */
  marketRegistrar: FhenixMarketRegistrar | null;
  /** Flow 2 grant runtime (dedicated grantor key). null unless
   *  FHENIX_GRANT_ENABLED. Exposes the env config for the access route mount. */
  grant: FhenixGrantEnvConfig | null;
  /** Access-orchestrator deps (db + grant chain + sales margin + clock) reused
   *  by both the access route and the reconciler. null unless grant enabled. */
  grantAccess: EntitlementAccessDeps | null;
  /** Background reconciler for entitlements stuck mid-grant. null unless the
   *  grant runtime is enabled AND FHENIX_GRANT_RECONCILER_ENABLED. */
  grantReconciler: { tick: () => Promise<unknown> } | null;
  chainId: number | null;
  sealedVerdictsAddress: string | null;
}

export interface FhenixRuntimeConfig {
  verifier: ViemFhenixEventVerifierConfig | null;
  ingestor: FhenixEventIngestorRuntimeConfig | null;
  revealWorker: FhenixRevealWorkerEnvConfig | null;
  gateway: FhenixGatewayEnvConfig | null;
  grant: FhenixGrantEnvConfig | null;
  /**
   * Murmur's cut of an early-access sale, in basis points. null when unset,
   * which is only allowed while both the gateway and paid grants are off.
   */
  protocolFeeBps: number | null;
  chainId: number | null;
  sealedVerdictsAddress: string | null;
  escrowAddress: string | null;
  gatewayEnabled: boolean;
  revealWorkerEnabled: boolean;
  grantEnabled: boolean;
  grantReconcilerEnabled: boolean;
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
  const revealWorkerEnabled = parseBooleanFlag(
    env.FHENIX_REVEAL_WORKER_ENABLED,
    false,
    "FHENIX_REVEAL_WORKER_ENABLED",
  );
  const grantEnabled = parseBooleanFlag(
    env.FHENIX_GRANT_ENABLED,
    false,
    "FHENIX_GRANT_ENABLED",
  );
  const grantReconcilerEnabled = parseBooleanFlag(
    env.FHENIX_GRANT_RECONCILER_ENABLED,
    false,
    "FHENIX_GRANT_RECONCILER_ENABLED",
  );
  const deploymentAddresses = resolveFhenixDeploymentAddresses(
    chainId ?? undefined,
    env,
  );

  // Hand the child loaders the RESOLVED chain id, not the raw environment.
  //
  // Each of them re-reads FHENIX_CHAIN_ID and rejects an empty value, so
  // deriving it here and then passing `env` through unchanged meant the
  // derivation only ever applied to this function: an operator who omitted the
  // var — exactly what .env.example now tells them to do — got
  // "FHENIX_CHAIN_ID is required when FHENIX_RPC_URL is set" at startup.
  //
  // Safe to overwrite because resolveFhenixChainId has already refused any
  // value that disagrees with the manifest, so this can only ever restate what
  // the operator set or supply what they left out.
  const childEnv: NodeJS.ProcessEnv =
    chainId === null ? env : { ...env, FHENIX_CHAIN_ID: String(chainId) };

  const verifier = loadFhenixEventVerifierConfig(childEnv, {
    contractAddress: deploymentAddresses.sealedVerdictsAddress,
  });
  const ingestor = loadFhenixEventIngestorConfig(childEnv, {
    contractAddress: deploymentAddresses.sealedVerdictsAddress,
  });
  const revealWorker = loadFhenixRevealWorkerEnvConfig(childEnv, {
    contractAddress: deploymentAddresses.sealedVerdictsAddress,
    enabled: revealWorkerEnabled,
  });
  const gateway = loadFhenixGatewayEnvConfig(childEnv, {
    contractAddress: deploymentAddresses.sealedVerdictsAddress,
    enabled: gatewayEnabled,
  });
  const grant = loadFhenixGrantEnvConfig(childEnv, {
    contractAddress: deploymentAddresses.sealedVerdictsAddress,
    enabled: grantEnabled,
  });

  // Murmur's cut. Required by BOTH runtimes that can put a sale in motion:
  //
  //   · grants  — the obvious one; a sale settles and must be split.
  //   · gateway — calls are SEALED here, and a seal is where the fee snapshot
  //     is frozen onto the call. A selling call sealed while grants were off
  //     still has to carry its split, or its later sale has nothing to
  //     reconstruct the terms from.
  //
  // Checked AFTER the child loaders on purpose: a broken chain id, key or
  // contract address is the more fundamental problem, and an operator should
  // hear about that first rather than fixing a fee and then meeting it.
  const protocolFeeBps = parseProtocolFeeBps(env);
  if ((gatewayEnabled || grantEnabled) && protocolFeeBps === null) {
    const flag = grantEnabled ? "FHENIX_GRANT_ENABLED" : "FHENIX_GATEWAY_ENABLED";
    throw new ProtocolFeeConfigError(
      `is required when ${flag}=true — it is murmur's cut of every early-access ` +
        `sale, in basis points (1000 = murmur 10% / provider 90%). Sealing a ` +
        `call freezes this number onto it, so a deployment that seals or sells ` +
        `without one produces sales whose split cannot be reconstructed. There ` +
        `is no default: a fee is a business decision.`,
    );
  }

  return {
    verifier,
    ingestor,
    revealWorker,
    gateway,
    grant,
    protocolFeeBps,
    chainId,
    sealedVerdictsAddress: deploymentAddresses.sealedVerdictsAddress,
    escrowAddress: deploymentAddresses.escrowAddress,
    gatewayEnabled,
    revealWorkerEnabled,
    grantEnabled,
    grantReconcilerEnabled,
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
        // Threaded so a publish tx sent by the fallback reveal EOA is attributed
        // to daemon_fallback in reveal ingestion.
        daemonRevealSender: config.revealWorker?.revealAddress ?? null,
        now: opts.now,
      })
    : null;
  const revealWorker = config.revealWorker
    ? new FhenixRevealWorker({
        db,
        chainId: config.revealWorker.chainId,
        contractAddress: config.revealWorker.contractAddress,
        chain: config.revealWorker.chain,
        decryptor: config.revealWorker.decryptor,
        graceSeconds: config.revealWorker.graceSeconds,
        retryBaseMs: config.revealWorker.retryBaseMs,
        retryMaxMs: config.revealWorker.retryMaxMs,
        rebroadcastMs: config.revealWorker.rebroadcastMs,
        maxJobsPerTick: config.revealWorker.maxJobsPerTick,
        maxConcurrency: config.revealWorker.maxConcurrency,
        warnMs: config.revealWorker.warnMs,
        escalateMs: config.revealWorker.escalateMs,
        now: opts.now,
        logger,
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

  // Flow 2 grant runtime. grantAccess is the shared orchestrator dep set; the
  // reconciler is only built when explicitly enabled (default-off).
  const grantAccess: EntitlementAccessDeps | null = config.grant
    ? {
        db,
        grantChain: config.grant.chain,
        salesSafetySeconds: config.grant.salesSafetySeconds,
        // Producer attribution. This was declared as an optional dependency
        // and then never supplied here, so EVERY entitlement written in
        // production recorded producer_agent_id = NULL — the revenue split had
        // nothing to attribute a sale to. Resolved from the sealed call, whose
        // submission row names the owning agent; acceptance writes both in one
        // transaction, so the join can never see half a pair.
        resolveProducerAgentId: (onchainCallId: string) =>
          fhenixSealedCallsRepo.producerAgentIdByOnchainCall(db, {
            chain_id: config.grant!.chainId,
            contract_address: config.grant!.contractAddress,
            onchain_call_id: onchainCallId,
          }),
        // Murmur's cut. Only consulted for calls sealed before fees were
        // snapshotted; every sale of a modern call carries its own split.
        protocolFeeBps: config.protocolFeeBps ?? undefined,
        logger,
        // Cohort ceiling. Without this the cap is decorative — persisted on
        // the series at registration but never consulted, so a cohort could
        // grow past what the grantor can fund or confirm in time, and grants would
        // fail for every subscriber on that call, after they had all paid.
        maxArmedPerCall: config.grant.maxArmedPerCall,
        grantConfirmations: config.grant.confirmations,
        maxGrantAttempts: config.grant.maxGrantAttempts,
        grantRebroadcastDelaySeconds: config.grant.grantRebroadcastDelaySeconds,
        settlementUnknownMaxAttempts: config.grant.settlementUnknownMaxAttempts,
        now: opts.now,
      }
    : null;
  // Paid grants MUST fail closed without their crash-recovery reconciler.
  // The two flags were independent, so a paid route could be live while
  // nothing recovered in-flight grants: a restart mid-purchase left a SETTLED
  // payment stranded with no path to either grant or refund. Refuse to boot
  // rather than take money we cannot make good on.
  // There is no refund worker. `listRefundDue` exists but nothing consumes it,
  // so a grant that fails after settlement leaves the subscriber with a
  // database marker and no money back. Until a durable refund path ships,
  // enabling paid grants requires an explicit acknowledgement that refunds are
  // a MANUAL operator duty — so nobody turns this on assuming it is automatic.
  // `opts.env`, not ambient process.env: startDaemon({env}) loads every other
  // setting from the injected environment, so reading this one from the
  // process made an injected grant configuration fail unless the ambient
  // process happened to carry the acknowledgement too.
  const env = opts.env ?? process.env;
  if (config.grantEnabled && env.MURMUR_ACK_MANUAL_REFUNDS !== "true") {
    throw new Error(
      "FHENIX_GRANT_ENABLED=true requires MURMUR_ACK_MANUAL_REFUNDS=true. " +
        "Murmur has no automated refund worker yet: a grant that fails after " +
        "payment settles is recorded as grant_failed_refund_due and must be " +
        "refunded BY HAND (query entitlementsRepo.listRefundDue). Set this only " +
        "if you have an operator process to honour that.",
    );
  }
  if (config.grantEnabled && !config.grantReconcilerEnabled) {
    throw new Error(
      "FHENIX_GRANT_ENABLED=true requires FHENIX_GRANT_RECONCILER_ENABLED=true. " +
        "Without the reconciler a settled payment interrupted by a restart is " +
        "never granted and never refunded.",
    );
  }
  const grantReconciler =
    grantAccess && config.grantReconcilerEnabled
      ? new FhenixGrantReconciler({ db, access: grantAccess, now: opts.now, logger })
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
      revealWorkerEnabled: config.revealWorkerEnabled,
      revealWorkerAddress: config.revealWorker?.revealAddress ?? null,
      verifierActive: Boolean(verifier),
      ingestorActive: Boolean(ingestor),
      revealWorkerActive: Boolean(revealWorker),
      gatewayActive: Boolean(gateway),
    }),
  );

  // Fail-soft funded-worker check: sealed submissions accepted without an
  // active, funded fallback worker must be surfaced (Codex review §12). The
  // config already fails CLOSED on a mis-set key; here we only warn on low
  // balance so a fresh key can still be topped up before its first reveal.
  if (config.revealWorker) {
    try {
      const balance = await config.revealWorker.getBalanceWei();
      if (balance < config.revealWorker.minBalanceWei) {
        logger.warn(
          `[daemon] Fhenix reveal worker EOA ${config.revealWorker.revealAddress} balance ${balance} wei is below FHENIX_REVEAL_WORKER_MIN_BALANCE_WEI ${config.revealWorker.minBalanceWei} — fund it or fallback reveals will fail to broadcast`,
        );
      }
    } catch (err) {
      logger.warn(
        "[daemon] Fhenix reveal worker balance check failed:",
        err,
      );
    }
  } else if (config.rpcConfigured && config.sealedVerdictsAddress) {
    // Info, not a warning: default-off is the intended rollout posture. Runtime
    // enforcement is the graduated `fhenix_reveal_fallback_overdue` operator
    // alert, which fires from overdue pending calls whether or not the worker
    // is enabled (operator-alert-sources.ts).
    logger.log(
      "[daemon] Fhenix reveal worker is DISABLED (FHENIX_REVEAL_WORKER_ENABLED unset). Sealed calls whose agent never reveals will retry-alert but are NOT guaranteed to be published by murmur. Enable + fund a dedicated FHENIX_REVEAL_PRIVATE_KEY for the reveal guarantee.",
    );
  }

  // Fail-soft funded-grantor check: an enabled grant runtime whose EOA cannot
  // pay for grant txs would charge subscribers for access it never delivers.
  if (config.grant) {
    try {
      const balance = await config.grant.chain.getBalanceWei();
      if (balance < config.grant.minBalanceWei) {
        logger.warn(
          `[daemon] Fhenix grantor EOA ${config.grant.grantorAddress} balance ${balance} wei is below FHENIX_GRANT_MIN_BALANCE_WEI ${config.grant.minBalanceWei} — fund it or paid decrypt grants will fail to broadcast (subscribers owed refunds)`,
        );
      }
    } catch (err) {
      logger.warn("[daemon] Fhenix grantor balance check failed:", err);
    }

    // FAIL CLOSED on the role. Unlike balance (which an operator can top up
    // while the daemon runs), a key without the grantor role can never grant:
    // every attempt reverts NotGrantor. Booting anyway means issuing 402s,
    // settling payments, and turning each sale into a refund obligation.
    let hasRole: boolean;
    try {
      hasRole = await config.grant.chain.hasGrantorRole();
    } catch (err) {
      throw new Error(
        `[daemon] could not verify the grantor role for ${config.grant.grantorAddress} ` +
          `on ${config.sealedVerdictsAddress}: ${err instanceof Error ? err.message : String(err)}. ` +
          `Refusing to start paid grants without confirming the role.`,
      );
    }
    if (!hasRole) {
      throw new Error(
        `[daemon] FHENIX_GRANT_ENABLED=true but ${config.grant.grantorAddress} does not hold ` +
          `the grantor role on ${config.sealedVerdictsAddress}. Every grant would revert ` +
          `NotGrantor after the subscriber had already paid. Set GRANTOR_ADDRESS at deploy, ` +
          `or call setGrantor for this address.`,
      );
    }
  }

  return {
    verifier,
    ingestor,
    revealWorker,
    gateway,
    marketRegistrar: config.gateway?.marketRegistrar ?? null,
    grant: config.grant,
    grantAccess,
    grantReconciler,
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
