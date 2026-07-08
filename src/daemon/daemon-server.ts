import type { Server } from "node:http";

export interface DaemonHttpListenSurface {
  listen(port: number, callback: () => void): Server;
}

export interface DaemonHttpServerRuntime {
  port: number;
  close(): Promise<void>;
}

export async function startDaemonHttpServer(
  app: DaemonHttpListenSurface,
  port: number,
): Promise<DaemonHttpServerRuntime> {
  const server = await new Promise<Server>((resolve, reject) => {
    let listeningServer: Server | null = null;
    const onError = (err: Error): void => {
      listeningServer?.off("listening", onListening);
      reject(err);
    };
    const onListening = (): void => {
      if (!listeningServer) return;
      listeningServer.off("error", onError);
      resolve(listeningServer);
    };
    const server = app.listen(port, onListening);
    listeningServer = server;
    server.once("error", onError);
  });

  const address = server.address();
  const actualPort =
    typeof address === "object" && address !== null ? address.port : port;
  let closePromise: Promise<void> | null = null;

  return {
    port: actualPort,
    close(): Promise<void> {
      closePromise ??= new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      return closePromise;
    },
  };
}
