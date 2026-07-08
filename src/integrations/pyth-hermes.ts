import {
  errorMessage,
  formatPythDecimal,
  isoFromUnixSeconds,
  nowIso,
} from "./oracle-primitives.js";

export const PYTH_HERMES_LATEST =
  "https://hermes.pyth.network/v2/updates/price/latest";

export type PythHermesErrorKind =
  | "http_failure"
  | "parse_error"
  | "missing_field";

export class PythHermesReadError extends Error {
  constructor(
    message: string,
    public readonly cause_kind: PythHermesErrorKind,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "PythHermesReadError";
  }
}

export interface PythHermesTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface PythHermesReadInput {
  endpoint: string;
  priceId: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  timers?: PythHermesTimers;
  now: () => Date;
}

export interface PythHermesObservation {
  price: string;
  feed_timestamp: string;
  observed_at: string;
  source_id: string;
  source_age_seconds: number;
}

export async function readPythHermesPrice(
  input: PythHermesReadInput,
): Promise<PythHermesObservation> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const timers = input.timers ?? defaultTimers;
  const ctrl = new AbortController();
  const timer = timers.setTimeout(() => ctrl.abort(), input.timeoutMs);
  let payload: HermesResponse;

  try {
    const res = await fetchImpl(
      pythHermesLatestUrl(input.endpoint, input.priceId),
      { signal: ctrl.signal },
    );
    if (!res.ok) {
      throw new PythHermesReadError(
        `hermes HTTP ${res.status}`,
        "http_failure",
      );
    }
    payload = (await res.json()) as HermesResponse;
  } catch (err) {
    if (err instanceof PythHermesReadError) throw err;
    throw new PythHermesReadError(
      "hermes fetch failed",
      "http_failure",
      { error: errorMessage(err) },
    );
  } finally {
    timers.clearTimeout(timer);
  }

  return pythHermesObservationFromPayload(payload, input.now);
}

const defaultTimers: PythHermesTimers = {
  setTimeout(callback, ms) {
    return setTimeout(callback, ms);
  },
  clearTimeout(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export function pythHermesLatestUrl(endpoint: string, priceId: string): string {
  return `${endpoint}?ids[]=${priceId}&parsed=true`;
}

export function pythHermesObservationFromPayload(
  payload: HermesResponse,
  now: () => Date,
): PythHermesObservation {
  const item = payload.parsed?.[0];
  if (!item) {
    throw new PythHermesReadError(
      "hermes returned no parsed entries",
      "parse_error",
    );
  }
  const px = item.price;
  if (!px || typeof px.price !== "string" || typeof px.expo !== "number") {
    throw new PythHermesReadError(
      "hermes parsed entry missing price/expo",
      "missing_field",
    );
  }
  const priceBig = BigInt(px.price);
  if (priceBig <= 0n) {
    throw new PythHermesReadError(
      "pyth price non-positive",
      "missing_field",
    );
  }
  const publishUnix = px.publish_time ?? item.metadata?.publish_time;
  if (typeof publishUnix !== "number") {
    throw new PythHermesReadError(
      "hermes parsed entry missing publish_time",
      "missing_field",
    );
  }
  const observedAt = now();
  return {
    price: formatPythDecimal(priceBig, px.expo),
    feed_timestamp: isoFromUnixSeconds(publishUnix),
    observed_at: nowIso(() => observedAt),
    source_id: `pyth:${publishUnix}`,
    source_age_seconds: Math.max(
      0,
      Math.floor(observedAt.getTime() / 1000) - publishUnix,
    ),
  };
}

export interface HermesPriceEntry {
  price: string;
  expo: number;
  conf: string;
  publish_time?: number;
}

export interface HermesParsedItem {
  id: string;
  price: HermesPriceEntry;
  ema_price?: HermesPriceEntry;
  metadata?: {
    slot?: number;
    publish_time?: number;
    prev_publish_time?: number;
  };
}

export interface HermesResponse {
  parsed?: HermesParsedItem[];
  binary?: { encoding: string; data: string[] };
}
