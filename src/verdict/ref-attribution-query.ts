export interface RefAttributionLimitQueryInput {
  limit?: unknown;
}

export interface RefTopSendersQuery {
  limit: number;
}

export interface RefAgentDiscoverersQuery {
  limit: number;
}

export function publicRefTopSendersQuery(
  query: RefAttributionLimitQueryInput | undefined,
): RefTopSendersQuery {
  return {
    limit: normalizeRefLimit(query?.limit, { fallback: 20, max: 50 }),
  };
}

export function adminRefTopSendersQuery(
  query: RefAttributionLimitQueryInput | undefined,
): RefTopSendersQuery {
  return {
    limit: normalizeRefLimit(query?.limit, { fallback: 50, max: 200 }),
  };
}

export function refAgentDiscoverersQuery(
  query: RefAttributionLimitQueryInput | undefined,
): RefAgentDiscoverersQuery {
  return {
    limit: normalizeRefLimit(query?.limit, { fallback: 5, max: 20 }),
  };
}

export function normalizeRefLimit(
  raw: unknown,
  opts: {
    fallback: number;
    max: number;
  },
): number {
  const value = Number(raw ?? opts.fallback);
  return Number.isFinite(value)
    ? Math.max(1, Math.min(opts.max, Math.floor(value)))
    : opts.fallback;
}
