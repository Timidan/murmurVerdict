import {
  createFhenixEventVerifierFromEnv,
  type FhenixEventVerifier,
} from "../integrations/fhenix-events.js";
import {
  FhenixDeploymentConfigError,
  parseFhenixAddressInput,
  resolveFhenixChainId,
  resolveFhenixContractAddress,
} from "../integrations/deployments.js";
import {
  loadFhenixSaleTermsEnv,
  type FhenixSaleTermsEnv,
} from "../integrations/fhenix-grant-env.js";
import {
  createAdminRouteAuth,
  type AdminRouteAuth,
} from "./admin-route-auth.js";
import {
  operatorAlertSinkFromEnv,
  type OperatorAlertSinkConfig,
} from "./operator-alerts.js";
import {
  loadMurmurPublicOrigin,
  type MurmurPublicOrigin,
} from "./public-origin.js";
import {
  normalizeFhenixRevealGraceSec,
  type OperatorFhenixLifecycleQueryDefaults,
} from "./operator-fhenix-lifecycle-query.js";
import {
  ERROR_CODES,
  VerdictError,
} from "./schema.js";
import {
  type WebhookDnsLookup,
  loadWebhookUrlPolicy,
  type WebhookUrlPolicy,
} from "./webhook-url.js";

export interface VerdictRouterRuntimeInput {
  adminToken?: string;
  env?: NodeJS.ProcessEnv;
  fhenixChainId?: number | null;
  fhenixSealedVerdictsAddress?: string | null;
  /**
   * Deployment-wide sale terms + sales safety margin for the public sellable
   * listing. Daemon callers pass the values parsed from their INJECTED env;
   * direct/test construction falls back to the env derivation below, like
   * every other adapter here.
   */
  saleTerms?: FhenixSaleTermsEnv;
  fhenixVerifier?: FhenixEventVerifier | null;
  logger?: Pick<Console, "error">;
  now: () => Date;
  operatorAlertSink?: OperatorAlertSinkConfig | null;
  operatorFhenixLifecycleQueryDefaults?: OperatorFhenixLifecycleQueryDefaults;
  publicOrigin?: MurmurPublicOrigin;
  webhookDnsLookup?: WebhookDnsLookup;
  webhookUrlPolicy?: WebhookUrlPolicy;
}

export interface VerdictRouterRuntime {
  adminAuth: AdminRouteAuth;
  fhenixChain: {
    chainId: number;
    sealedVerdictsAddress: string | null;
  } | null;
  fhenixVerifier: FhenixEventVerifier | null;
  logger: Pick<Console, "error">;
  now: () => Date;
  operatorAlertSink: OperatorAlertSinkConfig | null;
  operatorFhenixLifecycleQueryDefaults: OperatorFhenixLifecycleQueryDefaults;
  publicOrigin: MurmurPublicOrigin;
  requireFhenixVerifier: () => FhenixEventVerifier;
  saleTerms: FhenixSaleTermsEnv;
  webhookDnsLookup?: WebhookDnsLookup;
  webhookUrlPolicy: WebhookUrlPolicy;
}

export function createVerdictRouterRuntime(
  input: VerdictRouterRuntimeInput,
): VerdictRouterRuntime {
  const env = input.env ?? process.env;
  const logger = input.logger ?? console;
  const now = input.now;
  const publicOrigin = input.publicOrigin ?? loadMurmurPublicOrigin(env);
  const fhenixChainId =
    input.fhenixChainId === undefined
      ? resolveFhenixChainId(env)
      : input.fhenixChainId;
  const fhenixSealedVerdictsAddress =
    resolveVerdictRouterFhenixAddress(
      env,
      fhenixChainId,
      input.fhenixSealedVerdictsAddress,
    );
  const fhenixVerifier =
    input.fhenixVerifier === undefined
      ? createFhenixEventVerifierFromEnv(env)
      : input.fhenixVerifier;
  const operatorAlertSink =
    input.operatorAlertSink === undefined
      ? operatorAlertSinkFromEnv(env)
      : input.operatorAlertSink;
  const operatorFhenixLifecycleQueryDefaults =
    input.operatorFhenixLifecycleQueryDefaults ?? {
      fhenixRevealGraceSec: normalizeFhenixRevealGraceSec(
        env.FHENIX_REVEAL_GRACE_SEC,
      ),
    };

  return {
    adminAuth: createAdminRouteAuth(
      input.adminToken ?? env.VERDICT_ADMIN_TOKEN ?? "",
    ),
    fhenixChain: fhenixChainId
      ? {
          chainId: fhenixChainId,
          sealedVerdictsAddress: fhenixSealedVerdictsAddress,
        }
      : null,
    fhenixVerifier,
    logger,
    now,
    operatorAlertSink,
    operatorFhenixLifecycleQueryDefaults,
    publicOrigin,
    requireFhenixVerifier: () => requireFhenixVerifier(fhenixVerifier),
    saleTerms: input.saleTerms ?? loadFhenixSaleTermsEnv(env),
    webhookDnsLookup: input.webhookDnsLookup,
    webhookUrlPolicy: input.webhookUrlPolicy ?? loadWebhookUrlPolicy(env),
  };
}

function resolveVerdictRouterFhenixAddress(
  env: NodeJS.ProcessEnv,
  fhenixChainId: number | null,
  sealedVerdictsAddress: string | null | undefined,
): string | null {
  if (sealedVerdictsAddress === undefined) {
    return fhenixChainId
      ? resolveFhenixContractAddress(fhenixChainId, env)
      : null;
  }
  const parsed = parseFhenixAddressInput(sealedVerdictsAddress);
  if (parsed.kind === "empty") return null;
  if (parsed.kind === "address") return parsed.address;
  throw new FhenixDeploymentConfigError(
    "FHENIX_SEALED_VERDICTS_ADDRESS",
    "must be a 20-byte 0x-prefixed address",
  );
}

function requireFhenixVerifier(
  verifier: FhenixEventVerifier | null,
): FhenixEventVerifier {
  if (!verifier) {
    throw new VerdictError(
      "Fhenix chain verifier is not configured; set FHENIX_RPC_URL before accepting sealed calls",
      ERROR_CODES.oracle_unavailable,
      503,
    );
  }
  return verifier;
}
