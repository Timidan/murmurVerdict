import type Database from "better-sqlite3";

import type { VerdictEventBus } from "./events.js";
import { publicLeaderboardUpdateEvent } from "./public-event-fanout.js";

const PUBLIC_EVENT_STREAM_HEARTBEAT_MS = 25_000;

export const PUBLIC_EVENT_STREAM_UNAVAILABLE_BODY = {
  code: "stream_unavailable",
  message: "event bus not configured on this deployment",
} as const;

export interface PublicEventStreamRequest {
  on(event: "close" | "error", handler: () => void): unknown;
}

export interface PublicEventStreamResponse {
  status(code: number): PublicEventStreamResponse;
  json(body: unknown): unknown;
  setHeader(name: string, value: string): unknown;
  flushHeaders?(): unknown;
  write(chunk: string): unknown;
  end(): unknown;
}

export interface PublicEventStreamSurfaceDeps {
  db: Database.Database;
  events?: Pick<VerdictEventBus, "subscribe">;
  now: () => Date;
  heartbeatMs?: number;
  setInterval?: (handler: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

export type PublicEventStreamResult =
  | {
      status: 503;
      body: typeof PUBLIC_EVENT_STREAM_UNAVAILABLE_BODY;
    }
  | {
      status: 200;
      close: () => void;
    };

export function openPublicEventStream(
  req: PublicEventStreamRequest,
  res: PublicEventStreamResponse,
  deps: PublicEventStreamSurfaceDeps,
): PublicEventStreamResult {
  const bus = deps.events;
  if (!bus) {
    res.status(503).json(PUBLIC_EVENT_STREAM_UNAVAILABLE_BODY);
    return {
      status: 503,
      body: PUBLIC_EVENT_STREAM_UNAVAILABLE_BODY,
    };
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  try {
    const snapshot = publicLeaderboardUpdateEvent({
      db: deps.db,
      servedAt: deps.now(),
      limit: 20,
    });
    writeSseFrame(res, snapshot.type, snapshot);
  } catch {
    // Best-effort snapshot; live deltas still flow even if the snapshot fails.
  }

  const unsubscribe = bus.subscribe((event) => {
    writeSseFrame(res, event.type, event);
  });

  const scheduleHeartbeat =
    deps.setInterval ?? ((handler: () => void, ms: number) => setInterval(handler, ms));
  const clearHeartbeat =
    deps.clearInterval ??
    ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>));
  const heartbeat = scheduleHeartbeat(
    () => {
      res.write(": heartbeat\n\n");
    },
    deps.heartbeatMs ?? PUBLIC_EVENT_STREAM_HEARTBEAT_MS,
  );

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearHeartbeat(heartbeat);
    unsubscribe();
    try {
      res.end();
    } catch {
      // Already closed.
    }
  };

  req.on("close", close);
  req.on("error", close);

  return { status: 200, close };
}

function writeSseFrame(
  res: PublicEventStreamResponse,
  eventName: string,
  payload: unknown,
): void {
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}
