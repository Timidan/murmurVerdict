import { WebSocketServer, WebSocket } from "ws";
import type { DashboardSnapshot, WsMessage } from "../types/index.js";

let wss: WebSocketServer | null = null;
let latestSnapshot: DashboardSnapshot | null = null;

export function startWsServer(port: number = 3001): WebSocketServer {
  wss = new WebSocketServer({ port });

  wss.on("connection", (ws) => {
    console.log(`[WS] Client connected (${wss!.clients.size} total)`);

    if (latestSnapshot) {
      send(ws, { type: "snapshot", data: latestSnapshot });
    }

    ws.on("close", () => {
      console.log(`[WS] Client disconnected (${wss!.clients.size} total)`);
    });
  });

  console.log(`[WS] Server listening on ws://localhost:${port}`);
  return wss;
}

export function broadcast(message: WsMessage): void {
  if (!wss) return;

  if (message.type === "snapshot") {
    latestSnapshot = message.data;
  }

  const payload = JSON.stringify(message, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value,
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
    console.log("[WS] Server stopped");
  }
}

function send(ws: WebSocket, message: WsMessage): void {
  ws.send(JSON.stringify(message, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value,
  ));
}
