export const REF_MAX_LENGTH = 32;

export function sanitizeRef(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const safe = raw.replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, REF_MAX_LENGTH);
  return safe.length === 0 ? null : safe;
}
