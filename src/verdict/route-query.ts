export interface BoundedIntegerQueryOptions {
  fallback: number;
  max: number;
  min?: number;
}

export function firstQueryValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}

export function boundedIntegerQuery(
  value: unknown,
  opts: BoundedIntegerQueryOptions,
): number {
  const min = opts.min ?? 1;
  const max = Math.max(min, opts.max);
  const parsed = Number(firstQueryValue(value) ?? opts.fallback);
  if (!Number.isFinite(parsed)) return opts.fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}
