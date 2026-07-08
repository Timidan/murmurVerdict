export interface OutboundJsonDeliveryFetchResponse {
  status: number;
  ok: boolean;
  text(): Promise<string>;
}

export type OutboundJsonDeliveryFetch = (
  url: string,
  init: RequestInit,
) => Promise<OutboundJsonDeliveryFetchResponse>;

export interface OutboundJsonDeliveryTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface OutboundJsonDeliveryInput {
  url: string;
  body: string;
  headers?: Record<string, string>;
  timeoutMs: number;
  fetch?: OutboundJsonDeliveryFetch;
  timers?: OutboundJsonDeliveryTimers;
}

export interface OutboundJsonDeliveryRequest {
  url: string;
  body: string;
  init: RequestInit;
}

export type OutboundJsonDeliveryResult =
  | { ok: true; status: number; error: null }
  | { ok: false; status: number | null; error: string };

export async function deliverOutboundJson(
  input: OutboundJsonDeliveryInput,
): Promise<OutboundJsonDeliveryResult> {
  const fetchFn = input.fetch ?? defaultFetch;
  const timers = input.timers ?? defaultTimers;
  const ac = new AbortController();
  const timeout = timers.setTimeout(() => ac.abort(), input.timeoutMs);

  try {
    const request = outboundJsonDeliveryRequest({
      url: input.url,
      body: input.body,
      headers: input.headers,
      signal: ac.signal,
    });
    const res = await fetchFn(request.url, request.init);
    await res.text().catch(() => "");
    return res.ok
      ? { ok: true, status: res.status, error: null }
      : { ok: false, status: res.status, error: `http status ${res.status}` };
  } catch (err) {
    return {
      ok: false,
      status: null,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    timers.clearTimeout(timeout);
  }
}

export function outboundJsonDeliveryRequest(input: {
  url: string;
  body: string;
  headers?: Record<string, string>;
  signal: AbortSignal;
}): OutboundJsonDeliveryRequest {
  return {
    url: input.url,
    body: input.body,
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(input.headers ?? {}),
      },
      body: input.body,
      signal: input.signal,
      redirect: "error",
    },
  };
}

const defaultTimers: OutboundJsonDeliveryTimers = {
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
};

async function defaultFetch(
  url: string,
  init: RequestInit,
): Promise<OutboundJsonDeliveryFetchResponse> {
  return fetch(url, init);
}
