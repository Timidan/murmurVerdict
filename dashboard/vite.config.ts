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
    // QA finding #2: dev-only proxy for /v1/* + /share + SSE so the
    // dashboard works against the daemon without VITE_VERDICT_API_URL
    // configured. Production (Vercel) routes the same paths via
    // vercel.json rewrites — keep them aligned. SSE needs `ws: false`
    // and `changeOrigin: true` so EventSource handshake survives.
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
