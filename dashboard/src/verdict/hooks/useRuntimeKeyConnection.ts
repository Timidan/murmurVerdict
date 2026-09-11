import { useCallback, useEffect, useRef, useState } from "react";
import { getAccessToken } from "@privy-io/react-auth";

import { verdictApi, type RuntimeKeysResponse } from "../api.js";

const SETUP_POLL_MS = 5_000;
const NORMAL_POLL_MS = 15_000;
const REQUEST_TIMEOUT_MS = 8_000;

export function useRuntimeKeyConnection(slug: string, trackedKeyId?: string) {
  const [snapshot, setSnapshot] = useState<RuntimeKeysResponse | null>(null);
  const [receivedAtMs, setReceivedAtMs] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [clockTick, setClockTick] = useState(0);
  const requestRef = useRef<{
    id: number;
    slug: string;
    controller: AbortController;
    promise: Promise<RuntimeKeysResponse | null>;
  } | null>(null);
  const nextRequestId = useRef(0);
  const mountedRef = useRef(true);

  const refresh = useCallback((): Promise<RuntimeKeysResponse | null> => {
    const active = requestRef.current;
    if (active?.slug === slug && !active.controller.signal.aborted) return active.promise;
    active?.controller.abort();
    const controller = new AbortController();
    const requestId = ++nextRequestId.current;
    const promise = (async () => {
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, REQUEST_TIMEOUT_MS);
      try {
        const token = await awaitUntilAborted(
          Promise.resolve().then(() => getAccessToken()),
          controller.signal,
        );
        if (!token) throw new Error("your session expired. Sign in again.");
        const next = await verdictApi.getRuntimeKeys(token, slug, controller.signal);
        if (mountedRef.current && requestRef.current?.id === requestId) {
          setSnapshot(next);
          setReceivedAtMs(performance.now());
          setError(null);
        }
        return next;
      } catch (cause) {
        if ((cause as Error)?.name === "AbortError" && !timedOut) return null;
        if (mountedRef.current && requestRef.current?.id === requestId) {
          setError(timedOut ? "connection refresh timed out" : ((cause as Error)?.message ?? "unable to refresh connection status"));
        }
        return null;
      } finally {
        clearTimeout(timeout);
        if (requestRef.current?.id === requestId) {
          requestRef.current = null;
          if (mountedRef.current) setLoading(false);
        }
      }
    })();
    requestRef.current = { id: requestId, slug, controller, promise };
    return promise;
  }, [slug]);

  useEffect(() => {
    mountedRef.current = true;
    setLoading(true);
    setSnapshot(null);
    setReceivedAtMs(null);
    setError(null);
    return () => {
      mountedRef.current = false;
      requestRef.current?.controller.abort();
    };
  }, [slug]);

  useEffect(() => {
    let stopped = false;
    let polling = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      if (polling || stopped || document.visibilityState !== "visible") return;
      polling = true;
      const next = await refresh();
      polling = false;
      if (stopped || document.visibilityState !== "visible") return;
      const tracked = trackedKeyId
        ? next?.keys.find((key) => key.runtime_key_id === trackedKeyId)?.connection
        : null;
      const status = tracked ?? next?.connection;
      timer = setTimeout(poll, status?.status === "never_connected" ? SETUP_POLL_MS : NORMAL_POLL_MS);
    };
    const onVisibility = () => {
      if (document.visibilityState !== "visible") {
        if (timer) clearTimeout(timer);
        timer = null;
      } else if (!timer) {
        void poll();
      }
    };
    void poll();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refresh, trackedKeyId]);

  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") setClockTick((value) => value + 1);
    };
    const timer = setInterval(tick, 1_000);
    return () => clearInterval(timer);
  }, []);

  return { snapshot, receivedAtMs, error, loading, refresh, clockTick };
}

/** Abort races both Privy's token read and the network read, and removes its listener. */
function awaitUntilAborted<T>(value: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException("aborted", "AbortError"));
    if (signal.aborted) {
      // The caller's token promise may still reject after StrictMode has
      // aborted this read; observe it so that late rejection is not unhandled.
      void value.catch(() => undefined);
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    value.then(
      (result) => {
        signal.removeEventListener("abort", abort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}
