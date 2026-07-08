export type FhenixEventPayload = Record<string, unknown>;

export function fhenixEventPayloadJson(payload: FhenixEventPayload): string {
  return JSON.stringify(storedFhenixEventPayload(payload));
}

export function storedFhenixEventPayload(
  payload: FhenixEventPayload,
): FhenixEventPayload {
  return normalizeJsonRecord(payload);
}

function normalizeJsonRecord(payload: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(payload)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, normalizeJsonValue(value)]),
  );
}

function normalizeJsonValue(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(normalizeJsonValue);
  if (value && typeof value === "object") {
    return normalizeJsonRecord(value as Record<string, unknown>);
  }
  return value;
}
