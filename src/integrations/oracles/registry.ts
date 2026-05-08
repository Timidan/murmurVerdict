// Oracle adapter registry — dispatch by `oracles.adapter` column.
//
// New adapters land as a file in this directory + a single `register()` call.
// The runtime then resolves an oracle's adapter by name, loads its asset row
// from the registry, and observes the latest price.

import type Database from "better-sqlite3";
import {
  assetsRepo,
  oraclesRepo,
  type AssetRow,
  type OracleRow,
} from "../../verdict/db.js";
import {
  AdapterContext,
  AdapterError,
  OracleAdapter,
  OracleObservation,
} from "./types.js";
import { chainlinkEvmAdapter } from "./chainlink-evm.js";
import { pythPullAdapter } from "./pyth-pull.js";

const adapters = new Map<string, OracleAdapter>();

export function registerAdapter(adapter: OracleAdapter): void {
  adapters.set(adapter.name, adapter);
}

export function getAdapter(name: string): OracleAdapter | null {
  return adapters.get(name) ?? null;
}

// Bootstrap built-in adapters at module load.
registerAdapter(chainlinkEvmAdapter);
registerAdapter(pythPullAdapter);

/**
 * Observe the latest price for a registered oracle. Looks up the oracle and
 * its asset, dispatches to the registered adapter, and returns the
 * observation. Throws AdapterError when the oracle is missing, retired/draft,
 * or its adapter isn't registered.
 *
 * Status policy: `listed` → observe; `draft`/`frozen`/`retired` → refuse.
 * Caller (resolver / market policy) decides what to do on refusal.
 */
export async function observeOracle(
  db: Database.Database,
  oracle_id: string,
  ctx: AdapterContext = {},
): Promise<OracleObservation> {
  const oracle = oraclesRepo.get(db, oracle_id);
  if (!oracle) {
    throw new AdapterError(
      `unknown oracle: ${oracle_id}`,
      oracle_id,
      "config_invalid",
    );
  }
  if (oracle.status !== "listed") {
    throw new AdapterError(
      `oracle ${oracle_id} status=${oracle.status} (expected 'listed')`,
      oracle_id,
      "config_invalid",
      { status: oracle.status },
    );
  }
  const asset = assetsRepo.get(db, oracle.asset_id);
  if (!asset) {
    throw new AdapterError(
      `oracle ${oracle_id} references unknown asset ${oracle.asset_id}`,
      oracle_id,
      "config_invalid",
    );
  }
  const adapter = adapters.get(oracle.adapter);
  if (!adapter) {
    throw new AdapterError(
      `oracle ${oracle_id} adapter '${oracle.adapter}' not registered`,
      oracle_id,
      "config_invalid",
    );
  }
  return adapter.getLatest(oracle, asset, ctx);
}

/**
 * Test seam: hand-fed oracle + asset, no DB lookup. Used by smoke tests and
 * future per-market unit tests.
 */
export async function observeWithRows(
  oracle: OracleRow,
  asset: AssetRow,
  ctx: AdapterContext = {},
): Promise<OracleObservation> {
  const adapter = adapters.get(oracle.adapter);
  if (!adapter) {
    throw new AdapterError(
      `adapter '${oracle.adapter}' not registered`,
      oracle.oracle_id,
      "config_invalid",
    );
  }
  return adapter.getLatest(oracle, asset, ctx);
}
