import type Database from "better-sqlite3";
import {
  createPublicClient,
  http,
  type Address,
  type Hex,
} from "viem";
import { PolymarketGammaClient } from "../markets/polymarket-gamma/client.js";
import { marketsRepo } from "../verdict/db.js";
import { nowIso } from "../verdict/time.js";
import { resolveFhenixContractAddress } from "./deployments.js";

const CONDITION_ID_REGEX = /^0x[0-9a-fA-F]{64}$/;

export type LiveCanaryStatus = "ok" | "fail" | "disabled";
export type LiveCanaryName = "fhenix_rpc" | "polymarket_gamma";
export type LiveCanaryDetails = Record<string, string | number | boolean | null>;

export interface LiveCanaryCheck {
  name: LiveCanaryName;
  status: LiveCanaryStatus;
  checked_at: string;
  latency_ms: number | null;
  details: LiveCanaryDetails;
  error: string | null;
}

export interface LiveCanarySnapshot {
  schema_version: number;
  served_at: string;
  ok: boolean;
  checks: LiveCanaryCheck[];
}

export interface LiveCanaryProvider {
  snapshot(): LiveCanarySnapshot;
  runNow(): Promise<LiveCanarySnapshot>;
  hasEnabledChecks(): boolean;
}

export interface FhenixCanaryClient {
  getChainId(): Promise<number>;
  getBlockNumber(): Promise<bigint>;
  getCode(args: { address: Address }): Promise<Hex | undefined>;
}

export interface PolymarketCanaryClient {
  fetchMarketByConditionId(conditionId: string): Promise<{
    snapshot: unknown | null;
    source: string;
    error: string | null;
  }>;
}

export interface LiveCanaryConfig {
  schemaVersion: number;
  db?: Database.Database | null;
  now?: () => Date;
  fhenix: {
    enabled: boolean;
    expectedChainId: number | null;
    contractAddress: Address | null;
    requireContractCode: boolean;
    client: FhenixCanaryClient | null;
    disabledReason?: string;
  };
  polymarket: {
    enabled: boolean;
    conditionId: string | null;
    client: PolymarketCanaryClient | null;
    disabledReason?: string;
  };
}

export class LiveCanaryRunner implements LiveCanaryProvider {
  private readonly schemaVersion: number;
  private readonly db: Database.Database | null;
  private readonly now: () => Date;
  private readonly fhenix: LiveCanaryConfig["fhenix"];
  private readonly polymarket: LiveCanaryConfig["polymarket"];
  private lastSnapshot: LiveCanarySnapshot | null = null;

  constructor(config: LiveCanaryConfig) {
    this.schemaVersion = config.schemaVersion;
    this.db = config.db ?? null;
    this.now = config.now ?? (() => new Date());
    this.fhenix = config.fhenix;
    this.polymarket = config.polymarket;
  }

  hasEnabledChecks(): boolean {
    return this.fhenix.enabled || this.polymarket.enabled;
  }

  snapshot(): LiveCanarySnapshot {
    if (this.lastSnapshot) return this.lastSnapshot;
    const servedAt = nowIso(this.now());
    const checks = [
      uncheckedOrDisabledCheck(
        "fhenix_rpc",
        servedAt,
        this.fhenix.enabled,
        this.fhenix.disabledReason ?? "FHENIX_CANARY_ENABLED=false",
      ),
      uncheckedOrDisabledCheck(
        "polymarket_gamma",
        servedAt,
        this.polymarket.enabled,
        this.polymarket.disabledReason ?? "POLYMARKET_CANARY_ENABLED=false",
      ),
    ];
    return buildSnapshot(this.schemaVersion, servedAt, checks);
  }

  async runNow(): Promise<LiveCanarySnapshot> {
    const servedAt = nowIso(this.now());
    const checks = await Promise.all([
      this.checkFhenix(servedAt),
      this.checkPolymarket(servedAt),
    ]);
    const snapshot = buildSnapshot(this.schemaVersion, servedAt, checks);
    this.lastSnapshot = snapshot;
    return snapshot;
  }

  private async checkFhenix(checkedAt: string): Promise<LiveCanaryCheck> {
    if (!this.fhenix.enabled) {
      return disabledCheck(
        "fhenix_rpc",
        checkedAt,
        this.fhenix.disabledReason ?? "FHENIX_CANARY_ENABLED=false",
      );
    }
    const client = this.fhenix.client;
    if (!client) {
      return failedCheck("fhenix_rpc", checkedAt, "FHENIX_RPC_URL is not configured");
    }
    if (!this.fhenix.expectedChainId) {
      return failedCheck("fhenix_rpc", checkedAt, "FHENIX_CHAIN_ID is not configured");
    }
    if (this.fhenix.requireContractCode && !this.fhenix.contractAddress) {
      return failedCheck(
        "fhenix_rpc",
        checkedAt,
        "Fhenix contract address required for contract-code canary; set FHENIX_SEALED_VERDICTS_ADDRESS, FHENIX_CONTRACT_ADDRESS, or sync deployments",
      );
    }

    const measured = await measure(async () => {
      const chainId = await client.getChainId();
      if (chainId !== this.fhenix.expectedChainId) {
        return {
          status: "fail" as const,
          error: `chain_id_mismatch:${chainId}`,
          details: {
            expected_chain_id: this.fhenix.expectedChainId,
            observed_chain_id: chainId,
          },
        };
      }
      const blockNumber = await client.getBlockNumber();
      const details: LiveCanaryDetails = {
        chain_id: chainId,
        latest_block: blockNumber.toString(),
      };
      if (this.fhenix.contractAddress) {
        const code = await client.getCode({ address: this.fhenix.contractAddress });
        details.contract_address = this.fhenix.contractAddress;
        details.contract_code_present = Boolean(code && code !== "0x");
        if (this.fhenix.requireContractCode && (!code || code === "0x")) {
          return {
            status: "fail" as const,
            error: "contract_code_missing",
            details,
          };
        }
      }
      return {
        status: "ok" as const,
        error: null,
        details,
      };
    });

    if (measured.ok) {
      return {
        name: "fhenix_rpc",
        status: measured.value.status,
        checked_at: checkedAt,
        latency_ms: measured.latencyMs,
        details: measured.value.details,
        error: measured.value.error,
      };
    }
    return {
      name: "fhenix_rpc",
      status: "fail",
      checked_at: checkedAt,
      latency_ms: measured.latencyMs,
      details: {},
      error: measured.error,
    };
  }

  private async checkPolymarket(checkedAt: string): Promise<LiveCanaryCheck> {
    if (!this.polymarket.enabled) {
      return disabledCheck(
        "polymarket_gamma",
        checkedAt,
        this.polymarket.disabledReason ?? "POLYMARKET_CANARY_ENABLED=false",
      );
    }
    const client = this.polymarket.client;
    if (!client) {
      return failedCheck("polymarket_gamma", checkedAt, "Polymarket Gamma client is not configured");
    }
    const conditionId = this.polymarket.conditionId ?? firstListedPolymarketConditionId(this.db);
    if (!conditionId) {
      return failedCheck(
        "polymarket_gamma",
        checkedAt,
        "POLYMARKET_CANARY_CONDITION_ID is not set and no listed Polymarket market exists",
      );
    }
    if (!CONDITION_ID_REGEX.test(conditionId)) {
      return failedCheck(
        "polymarket_gamma",
        checkedAt,
        "POLYMARKET_CANARY_CONDITION_ID must be a 32-byte conditionId",
        { condition_id: conditionId },
      );
    }

    const measured = await measure(async () => client.fetchMarketByConditionId(conditionId));
    if (!measured.ok) {
      return {
        name: "polymarket_gamma",
        status: "fail",
        checked_at: checkedAt,
        latency_ms: measured.latencyMs,
        details: { condition_id: conditionId },
        error: measured.error,
      };
    }
    const result = measured.value;
    if (!result.snapshot) {
      return {
        name: "polymarket_gamma",
        status: "fail",
        checked_at: checkedAt,
        latency_ms: measured.latencyMs,
        details: {
          condition_id: conditionId,
          source: result.source,
        },
        error: result.error ?? "market_not_found",
      };
    }
    const snapshot = result.snapshot as {
      conditionId?: unknown;
      closed?: unknown;
      slug?: unknown;
      endDate?: unknown;
    };
    return {
      name: "polymarket_gamma",
      status: "ok",
      checked_at: checkedAt,
      latency_ms: measured.latencyMs,
      details: {
        condition_id: conditionId,
        source: result.source,
        upstream_condition_id:
          typeof snapshot.conditionId === "string" ? snapshot.conditionId : null,
        closed: typeof snapshot.closed === "boolean" ? snapshot.closed : null,
        slug: typeof snapshot.slug === "string" ? snapshot.slug : null,
        end_date: typeof snapshot.endDate === "string" ? snapshot.endDate : null,
      },
      error: null,
    };
  }
}

export function createLiveCanaryRunnerFromEnv(
  db: Database.Database,
  schemaVersion: number,
): LiveCanaryRunner {
  const fhenixEnabled = enabledFromEnv(
    "FHENIX_CANARY_ENABLED",
    Boolean(process.env.FHENIX_RPC_URL?.trim() && process.env.FHENIX_CHAIN_ID?.trim()),
  );
  const polymarketEnabled = enabledFromEnv(
    "POLYMARKET_CANARY_ENABLED",
    process.env.MURMUR_POLYMARKET_GAMMA_ENABLED === "1",
  );
  const rpcUrl = process.env.FHENIX_RPC_URL?.trim() || "";
  const rawChainId = process.env.FHENIX_CHAIN_ID?.trim() || "";
  const expectedChainId = Number(rawChainId);
  const contractAddress =
    resolveFhenixContractAddress(
      Number.isInteger(expectedChainId) && expectedChainId > 0 ? expectedChainId : undefined,
    ) || "";
  const fhenixClient = rpcUrl
    ? createViemFhenixCanaryClient(rpcUrl)
    : null;

  return new LiveCanaryRunner({
    schemaVersion,
    db,
    fhenix: {
      enabled: fhenixEnabled,
      expectedChainId: Number.isInteger(expectedChainId) && expectedChainId > 0
        ? expectedChainId
        : null,
      contractAddress: isAddressLike(contractAddress)
        ? (contractAddress as Address)
        : null,
      requireContractCode:
        process.env.FHENIX_CANARY_REQUIRE_CONTRACT_CODE !== "false",
      client: fhenixClient,
      disabledReason: fhenixEnabled
        ? undefined
        : "FHENIX_CANARY_ENABLED=false or Fhenix chain env is unset",
    },
    polymarket: {
      enabled: polymarketEnabled,
      conditionId: normalizeConditionId(process.env.POLYMARKET_CANARY_CONDITION_ID),
      client: new PolymarketGammaClient(),
      disabledReason: polymarketEnabled
        ? undefined
        : "POLYMARKET_CANARY_ENABLED=false and Polymarket sync is disabled",
    },
  });
}

function createViemFhenixCanaryClient(rpcUrl: string): FhenixCanaryClient {
  const publicClient = createPublicClient({ transport: http(rpcUrl) });
  return {
    getChainId: () => publicClient.getChainId(),
    getBlockNumber: () => publicClient.getBlockNumber(),
    getCode: (args) => publicClient.getCode(args),
  };
}

function enabledFromEnv(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === "true" || raw === "1" || raw === "yes") return true;
  if (raw === "false" || raw === "0" || raw === "no") return false;
  return defaultValue;
}

function normalizeConditionId(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function isAddressLike(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

function firstListedPolymarketConditionId(db: Database.Database | null): string | null {
  if (!db) return null;
  const listed = marketsRepo.listed(db);
  for (const row of listed) {
    if (row.adapter_id !== "polymarket-gamma") continue;
    const fromConfig = conditionIdFromConfig(row.config_json);
    if (fromConfig) return fromConfig;
    if (CONDITION_ID_REGEX.test(row.market_id)) return row.market_id;
  }
  return null;
}

function conditionIdFromConfig(configJson: string | null): string | null {
  if (!configJson) return null;
  try {
    const parsed = JSON.parse(configJson) as { conditionId?: unknown };
    return typeof parsed.conditionId === "string" && CONDITION_ID_REGEX.test(parsed.conditionId)
      ? parsed.conditionId
      : null;
  } catch {
    return null;
  }
}

async function measure<T>(
  fn: () => Promise<T>,
): Promise<
  | { ok: true; value: T; latencyMs: number }
  | { ok: false; error: string; latencyMs: number }
> {
  const started = Date.now();
  try {
    const value = await fn();
    return { ok: true, value, latencyMs: Date.now() - started };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      latencyMs: Date.now() - started,
    };
  }
}

function uncheckedOrDisabledCheck(
  name: LiveCanaryName,
  checkedAt: string,
  enabled: boolean,
  reason: string,
): LiveCanaryCheck {
  return enabled
    ? failedCheck(name, checkedAt, "canary_not_checked_yet")
    : disabledCheck(name, checkedAt, reason);
}

function disabledCheck(
  name: LiveCanaryName,
  checkedAt: string,
  reason: string,
): LiveCanaryCheck {
  return {
    name,
    status: "disabled",
    checked_at: checkedAt,
    latency_ms: null,
    details: { reason },
    error: null,
  };
}

function failedCheck(
  name: LiveCanaryName,
  checkedAt: string,
  error: string,
  details: LiveCanaryDetails = {},
): LiveCanaryCheck {
  return {
    name,
    status: "fail",
    checked_at: checkedAt,
    latency_ms: null,
    details,
    error,
  };
}

function buildSnapshot(
  schemaVersion: number,
  servedAt: string,
  checks: LiveCanaryCheck[],
): LiveCanarySnapshot {
  return {
    schema_version: schemaVersion,
    served_at: servedAt,
    ok: checks.every((check) => check.status !== "fail"),
    checks,
  };
}
