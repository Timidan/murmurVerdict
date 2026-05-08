import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: path.resolve(__dirname),
  resolve: {
    alias: {
      "@types": path.resolve(__dirname, "../src/types"),
    },
  },
  build: {
    outDir: path.resolve(__dirname, "dist"),
    emptyOutDir: true,
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
    // Production (Vercel preview / prod) does NOT have a proxy. There
    // are no /v1/* rewrites in vercel.json. Operators MUST set
    // VITE_VERDICT_API_URL=https://<daemon-host> at build time so the
    // dashboard issues absolute URLs to the deployed daemon (with CORS
    // on the daemon allowing the dashboard origin).
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
