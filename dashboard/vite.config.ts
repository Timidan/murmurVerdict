import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: path.resolve(__dirname),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      // NB: not "@types" — TypeScript reserves the "@types/*" specifier for
      // DefinitelyTyped ambient packages, so "@types/events" collides with
      // Node's events .d.ts. "@shared" maps the backend↔dashboard shared
      // wire types (src/types/) without that collision.
      "@shared": path.resolve(__dirname, "../src/types"),
    },
  },
  build: {
    outDir: path.resolve(__dirname, "dist"),
    emptyOutDir: true,
    chunkSizeWarningLimit: 2200,
    rollupOptions: {
      onwarn(warning, defaultHandler) {
        if (
          warning.code === "INVALID_ANNOTATION" &&
          typeof warning.id === "string" &&
          warning.id.includes("node_modules/")
        ) {
          return;
        }
        defaultHandler(warning);
      },
    },
  },
  server: {
    port: 5173,
    // QA finding #2 (post-Codex audit): dev-only proxy for /v1/*, /share,
    // /embed.js so `npm run dashboard` against a local daemon works
    // without setting VITE_VERDICT_API_URL. The dashboard's API client
    // (dashboard/src/verdict/api.ts) defaults to RELATIVE URLs when the
    // env var is unset — those relative requests land here and get
    // forwarded to the daemon at MURMUR_DAEMON_URL || localhost:8080.
    //
    // Production (any static host serving dashboard/dist) does NOT have
    // this proxy. The static host should not rewrite /v1/* — operators
    // MUST set VITE_VERDICT_API_URL=https://<daemon-host> at build time
    // so the dashboard issues absolute URLs to the deployed daemon
    // (with CORS on the daemon allowing the dashboard origin).
    proxy: {
      "/v1": {
        target: process.env.MURMUR_DAEMON_URL ?? "http://localhost:8080",
        changeOrigin: true,
        // SSE: long-lived connection; disable buffering on the proxy.
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq, req) => {
            // Mirror the Accept header so /v1/stream gets text/event-stream
            if (req.headers.accept) {
              proxyReq.setHeader("accept", req.headers.accept);
            }
          });
        },
      },
      // /v2/* — the venue ticker stream + snapshot and the markets archive
      // search. Same dev-only rationale as /v1 above: without this, `npm run
      // dashboard` gets a 404 from Vite's own static handler for
      // /v2/venue/stream and the matrix paints with no live prices and no
      // archive search. Production is unchanged — operators still set
      // VITE_VERDICT_API_URL so the SPA issues absolute URLs.
      "/v2": {
        target: process.env.MURMUR_DAEMON_URL ?? "http://localhost:8080",
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq, req) => {
            // Mirror Accept so /v2/venue/stream negotiates text/event-stream.
            if (req.headers.accept) {
              proxyReq.setHeader("accept", req.headers.accept);
            }
          });
          proxy.on("proxyRes", (proxyRes) => {
            // SSE dies behind a buffering hop: the daemon flushes each frame,
            // but a proxy holding a compression or chunk buffer delivers them
            // in bursts (or not at all until close), so a 2s venue tick can
            // arrive 30s late. The daemon already sets X-Accel-Buffering: no
            // and no-transform; restate both here so this hop cannot be the
            // one that buffers.
            if (
              String(proxyRes.headers["content-type"] ?? "")
                .includes("text/event-stream")
            ) {
              proxyRes.headers["cache-control"] = "no-cache, no-transform";
              proxyRes.headers["x-accel-buffering"] = "no";
              delete proxyRes.headers["content-encoding"];
            }
          });
        },
      },
      "/embed.js": {
        target: process.env.MURMUR_DAEMON_URL ?? "http://localhost:8080",
        changeOrigin: true,
      },
      "/share": {
        target: process.env.MURMUR_DAEMON_URL ?? "http://localhost:8080",
        changeOrigin: true,
      },
    },
  },
});
