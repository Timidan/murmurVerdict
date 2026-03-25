import { useState, useEffect, useRef } from "react";
import type { DashboardSnapshot, LoopPhase, WsMessage } from "../types";

interface UseSocketReturn {
  snapshot: DashboardSnapshot | null;
  connected: boolean;
  currentPhase: LoopPhase | null;
  authFailed: boolean;
}

const DEFAULT_WS_URL = (import.meta as any).env?.VITE_WS_URL ?? "ws://localhost:3001";

export function useSocket(token: string | null, url: string = DEFAULT_WS_URL): UseSocketReturn {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [currentPhase, setCurrentPhase] = useState<LoopPhase | null>(null);
  const [authFailed, setAuthFailed] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connIdRef = useRef(0);

  useEffect(() => {
    if (!token) {
      setConnected(false);
      setAuthFailed(false);
      return;
    }

    // Reset auth failure when token changes
    setAuthFailed(false);

    const connId = ++connIdRef.current;
    let disposed = false;

    function clearTimers() {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    }

    function isStale(ws: WebSocket) {
      return disposed || connIdRef.current !== connId || wsRef.current !== ws;
    }

    function connect() {
      if (disposed || connIdRef.current !== connId) return;
      clearTimers();

      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }

      const wsUrl = `${url}?token=${encodeURIComponent(token!)}`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        if (isStale(ws)) return;
        setConnected(true);
      };

      ws.onclose = (event) => {
        if (isStale(ws)) return;
        clearTimers();
        setConnected(false);
        wsRef.current = null;

        // 4001 = server rejected our token — don't retry
        if (event.code === 4001) {
          setAuthFailed(true);
          return;
        }

        // Normal disconnect — reconnect after 3s
        reconnectTimerRef.current = setTimeout(connect, 3000);
      };

      ws.onerror = () => {
        // onclose will fire after onerror
      };

      ws.onmessage = (event) => {
        if (isStale(ws)) return;
        try {
          const msg = JSON.parse(event.data) as WsMessage;

          switch (msg.type) {
            case "snapshot": {
              setSnapshot(msg.data);
              if (msg.data.currentCycle) {
                setCurrentPhase(msg.data.currentCycle.phase);
              }
              break;
            }
            case "phase": {
              setCurrentPhase(msg.data.phase);
              setSnapshot((prev) => {
                if (!prev) return prev;
                return {
                  ...prev,
                  currentCycle: {
                    cycleId: msg.data.cycleId,
                    phase: msg.data.phase,
                    startedAt: prev.currentCycle?.startedAt ?? msg.data.timestamp,
                  },
                };
              });
              break;
            }
            case "trade": {
              break;
            }
          }
        } catch {
          // Ignore malformed messages
        }
      };
    }

    connect();

    return () => {
      disposed = true;
      clearTimers();
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [url, token]);

  return { snapshot, connected, currentPhase, authFailed };
}
