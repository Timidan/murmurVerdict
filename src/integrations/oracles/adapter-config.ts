import type {
  OracleRow,
} from "../../verdict/repos/market-registry-repo.js";
import {
  AdapterError,
} from "./types.js";

export interface OracleAdapterHexKey {
  key: string;
  bytes: number;
  malformedMessage?: string;
}

export function parseOracleAdapterConfig<T = Record<string, unknown>>(
  oracle: OracleRow,
  requiredKeys: ReadonlyArray<string>,
): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(oracle.config_json);
  } catch {
    throw new AdapterError(
      `oracle ${oracle.oracle_id}: config_json is not valid JSON`,
      oracle.oracle_id,
      "config_invalid",
    );
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    throw new AdapterError(
      `oracle ${oracle.oracle_id}: config_json must be a JSON object`,
      oracle.oracle_id,
      "config_invalid",
    );
  }
  const obj = parsed as Record<string, unknown>;
  for (const key of requiredKeys) {
    if (!(key in obj) || typeof obj[key] !== "string") {
      throw new AdapterError(
        `oracle ${oracle.oracle_id}: config missing required string '${String(key)}'`,
        oracle.oracle_id,
        "config_invalid",
        { config: obj },
      );
    }
  }
  return obj as T;
}

export function parseOracleAdapterHexConfig<T = Record<string, string>>(
  oracle: OracleRow,
  requiredHexKeys: ReadonlyArray<OracleAdapterHexKey>,
): T {
  const config = parseOracleAdapterConfig<Record<string, unknown>>(
    oracle,
    requiredHexKeys.map((entry) => entry.key),
  );
  for (const entry of requiredHexKeys) {
    const value = config[entry.key] as string;
    if (isFixedHexString(value, entry.bytes)) continue;
    throw new AdapterError(
      `oracle ${oracle.oracle_id}: ${
        entry.malformedMessage ??
        `${entry.key} malformed (expect 0x + ${entry.bytes * 2} hex)`
      }`,
      oracle.oracle_id,
      "config_invalid",
      { [entry.key]: value },
    );
  }
  return config as T;
}

function isFixedHexString(value: string, bytes: number): boolean {
  return new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(value);
}
