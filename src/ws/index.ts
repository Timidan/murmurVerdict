import { createServer, type Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import express from "express";
import type { DashboardSnapshot, WsMessage } from "../types/index.js";

let wss: WebSocketServer | null = null;
let httpServer: Server | null = null;
let latestSnapshot: DashboardSnapshot | null = null;

// Shared express app for HTTP endpoints on the same port
const app = express();
app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
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

  wss.on("connection", (ws) => {
    console.log(`[WS] Client connected (${wss!.clients.size} total)`);

    if (latestSnapshot) {
      send(ws, { type: "snapshot", data: latestSnapshot });
    }

    ws.on("close", () => {
      console.log(`[WS] Client disconnected (${wss!.clients.size} total)`);
    });
  });

  httpServer.listen(port, () => {
    console.log(`[WS] Server listening on http://localhost:${port} (HTTP + WebSocket)`);
  });

  return wss;
}

export function broadcast(message: WsMessage): void {
  if (!wss) return;

  if (message.type === "snapshot") {
    latestSnapshot = message.data;
  }

  const payload = JSON.stringify(message, (_key, value) =>
    typeof value === "bigint" ? value.toString() : (value as unknown),
  );

  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

export function broadcastPhase(cycleId: string, phase: string, timestamp: string): void {
  broadcast({
    type: "phase",
    data: { cycleId, phase: phase as any, timestamp },
  });
}

export function broadcastSnapshot(snapshot: DashboardSnapshot): void {
  broadcast({ type: "snapshot", data: snapshot });
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
