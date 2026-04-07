import { createServer, type Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { URL } from "url";
import express from "express";
import type { DashboardSnapshot, WsMessage } from "../types/index.js";
import { getSession } from "../session/index.js";

let wss: WebSocketServer | null = null;
let httpServer: Server | null = null;
let latestSnapshot: DashboardSnapshot | null = null;
const latestSnapshotsByToken = new Map<string, DashboardSnapshot>();

// Shared express app for HTTP endpoints on the same port
const ALLOWED_ORIGINS = new Set(
  (process.env.DASHBOARD_ORIGIN || "http://localhost:5173")
    .split(",")
    .map((o) => o.trim()),
);

const app = express();
app.use((_req, res, next) => {
  const origin = _req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (_req.method === "OPTIONS") { res.status(204).end(); return; }
  next();
});
app.use(express.json());

// Health check (basic — loop adds richer /api/status)
app.get("/healthz", (_req, res) => {
  res.json({ agent: "Murmur", ok: true, wsClients: wss?.clients.size ?? 0 });
});

export { app };

/**
 * Start a single HTTP + WebSocket server on one port.
 * Render routes all public traffic to this port.
 */
export function startWsServer(port: number = 3001): WebSocketServer {
  httpServer = createServer(app);

  wss = new WebSocketServer({ server: httpServer });

  wss.on("connection", (ws, req) => {
    // Require auth via token query parameter
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const token = url.searchParams.get("token");
    if (!token || !getSession(token)) {
      ws.close(4001, "Unauthorized");
      return;
    }

    (ws as WebSocket & { __token?: string }).__token = token;

    console.log(`[WS] Client connected (${wss!.clients.size} total)`);

    const initialSnapshot = latestSnapshotsByToken.get(token) ?? latestSnapshot;
    if (initialSnapshot) {
      send(ws, { type: "snapshot", data: initialSnapshot });
    }

    ws.on("close", () => {
      console.log(`[WS] Client disconnected (${wss!.clients.size} total)`);
    });

    ws.on("pong", () => {
      (ws as any).__alive = true;
    });
    (ws as any).__alive = true;
  });

  // Ping all clients every 30s to keep connections alive through Render's proxy
  const pingInterval = setInterval(() => {
    if (!wss) return;
    for (const ws of wss.clients) {
      if ((ws as any).__alive === false) {
        ws.terminate();
        continue;
      }
      (ws as any).__alive = false;
      ws.ping();
    }
  }, 30_000);

  wss.on("close", () => clearInterval(pingInterval));

  httpServer.listen(port, () => {
    console.log(`[WS] Server listening on http://localhost:${port} (HTTP + WebSocket)`);
  });

  return wss;
}

export function broadcast(message: WsMessage, token?: string): void {
  if (!wss) return;

  if (message.type === "snapshot") {
    if (token) {
      latestSnapshotsByToken.set(token, message.data);
    } else {
      latestSnapshot = message.data;
    }
  }

  const payload = JSON.stringify(message, (_key, value) =>
    typeof value === "bigint" ? value.toString() : (value as unknown),
  );

  for (const client of wss.clients) {
    const clientToken = (client as WebSocket & { __token?: string }).__token;
    if (
      client.readyState === WebSocket.OPEN &&
      (!token || clientToken === token)
    ) {
      client.send(payload);
    }
  }
}

export function broadcastPhase(
  cycleId: string,
  phase: string,
  timestamp: string,
  token?: string,
): void {
  broadcast({
    type: "phase",
    data: { cycleId, phase: phase as any, timestamp },
  }, token);
}

export function broadcastSnapshot(snapshot: DashboardSnapshot, token?: string): void {
  broadcast({ type: "snapshot", data: snapshot }, token);
}

export function stopWsServer(): void {
  if (wss) {
    wss.close();
    wss = null;
  }
  if (httpServer) {
    httpServer.close();
    httpServer = null;
  }
  console.log("[WS] Server stopped");
}

function send(ws: WebSocket, message: WsMessage): void {
  ws.send(JSON.stringify(message, (_key, value) =>
    typeof value === "bigint" ? value.toString() : (value as unknown),
  ));
}
