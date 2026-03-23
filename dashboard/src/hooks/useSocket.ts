import { useState, useEffect, useRef, useCallback } from "react";
import type { DashboardSnapshot, LoopPhase, WsMessage } from "../types";

interface UseSocketReturn {
  snapshot: DashboardSnapshot | null;
  connected: boolean;
  currentPhase: LoopPhase | null;
}

const DEFAULT_WS_URL = (import.meta as any).env?.VITE_WS_URL ?? "ws://localhost:3001";

export function useSocket(url: string = DEFAULT_WS_URL): UseSocketReturn {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [currentPhase, setCurrentPhase] = useState<LoopPhase | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const connect = useCallback(() => {
    // Clean up any existing connection
    if (wsRef.current) {
      wsRef.current.close();
    }

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
    };

    ws.onclose = () => {
      setConnected(false);
      wsRef.current = null;
      // Auto-reconnect after 3 seconds
      reconnectTimerRef.current = setTimeout(() => {
        connect();
      }, 3000);
    };

    ws.onerror = () => {
      // onclose will fire after onerror, triggering reconnect
    };

    ws.onmessage = (event) => {
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
            // Patch snapshot's currentCycle with new phase
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
            // Trade messages are informational; snapshot will follow
            break;
          }
        }
      } catch {
        // Ignore malformed messages
      }
    };
  }, [url]);

  useEffect(() => {
    connect();

    return () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [connect]);

  return { snapshot, connected, currentPhase };
}
