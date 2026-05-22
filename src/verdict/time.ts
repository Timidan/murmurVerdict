import { ERROR_CODES, VerdictError } from "./schema.js";

export function nowIso(d: Date): string {
  return d.toISOString().replace(/\.\d+Z$/, "Z");
}

export function isoFromMs(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");
}

export function parseIsoMs(value: string, field: string): number {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new VerdictError(
      `${field} is not a valid ISO timestamp`,
      ERROR_CODES.schema_invalid,
      400,
    );
  }
  return ms;
}
