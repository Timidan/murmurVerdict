import { type Plugin, defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import fs from "fs";

// On Vercel the site origin defaults to the project's production domain; VITE_SITE_URL wins.
if (!process.env.VITE_SITE_URL && process.env.VERCEL_PROJECT_PRODUCTION_URL) {
  process.env.VITE_SITE_URL = `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
}

/**
 * Absolute share-card URLs.
 *
 * `og:image` and `twitter:image` MUST be absolute: Twitter, Slack, Discord and
 * most other unfurlers fetch them without a document base, so a root-relative
 * `/murmur-banner.png` resolves against their own host and the card silently
 * renders with no image. Same for `og:url`.
 *
 * The origin is a build-time input and is INTENTIONALLY unset by default —
 * the same discipline MURMUR_DASHBOARD_URL follows in .env.example. A
 * self-hosted deploy must not inherit somebody else's origin, and a wrong
 * absolute URL is worse than a relative one. Unset leaves the tags exactly as
 * authored; set it and every og/twitter URL is rewritten absolute.
 */
function absoluteShareUrls(siteUrl: string | undefined) {
  const origin = (siteUrl ?? "").trim().replace(/\/+$/, "");
  return {
    name: "murmur-absolute-share-urls",
    transformIndexHtml(html: string) {
      if (origin === "") return html;
      const rewritten = html.replace(
        /(<meta\s+(?:property|name)="(?:og:image|twitter:image)"\s+content=")(\/[^"]*)(")/g,
        (_m, head: string, path: string, tail: string) => `${head}${origin}${path}${tail}`,
      );
      // og:url states the page's own canonical address; without an origin
      // there is nothing true to say, which is why it is added here.
      return rewritten.includes('property="og:url"')
        ? rewritten
        : rewritten.replace(
            /(<meta\s+property="og:title")/,
            `<meta property="og:url" content="${origin}/" />\n    $1`,
          );
    },
  };
}

/**
 * Fill the public launchpad manifest's absolute URLs at build time.
 *
 * `.well-known/murmur.json` is what OpenServ discovery reads. It used to ship
 * `https://murmur.verdict` for `homepage`, `endpoints.api` and `$schema` —
 * `.verdict` is not a TLD, so every one of those was unreachable. The fields
 * are now ABSENT from the source file and added here only when an origin is
 * actually configured: a manifest with no homepage is honest, a manifest
 * pointing at a domain that cannot resolve is not.
 */
function launchpadManifestOrigin(siteUrl: string | undefined) {
  const origin = (siteUrl ?? "").trim().replace(/\/+$/, "");
  return {
    name: "murmur-launchpad-manifest-origin",
    apply: "build" as const,
    closeBundle() {
      if (origin === "") return;
      const file = path.resolve(__dirname, "dist/.well-known/murmur.json");
      if (!fs.existsSync(file)) return;
      const manifest = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
      manifest.homepage = origin;
      const endpoints = (manifest.endpoints ?? {}) as Record<string, unknown>;
      endpoints.api = origin;
      manifest.endpoints = endpoints;
      fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
    },
  };
}

/** Emits the licence texts of every npm package bundled into the site. */
function thirdPartyLicenses(): Plugin {
  return {
    name: "murmur-third-party-licenses",
    apply: "build",
    generateBundle() {
      const seen = new Map<string, string>();
      for (const id of this.getModuleIds()) {
        const file = id.replace(/^\0/, "").split("?")[0];
        let dir = path.dirname(file);
        // Walk up to the nearest package.json that names a package.
        while (dir.includes(`${path.sep}node_modules${path.sep}`)) {
          const manifest = path.join(dir, "package.json");
          const pkg = fs.existsSync(manifest) ? JSON.parse(fs.readFileSync(manifest, "utf8")) : null;
          if (pkg?.name && pkg?.version) {
            const key = `${pkg.name}@${pkg.version}`;
            if (!seen.has(key)) {
              const licence = typeof pkg.license === "string" ? pkg.license : pkg.license?.type ?? "see package";
              const texts = fs.readdirSync(dir)
                .filter((f) => /^(licen[cs]e|copying|notice)(\.|-|$)/i.test(f))
                .map((f) => fs.readFileSync(path.join(dir, f), "utf8").trim());
              seen.set(key, `${pkg.name} ${pkg.version}\nLicense: ${licence}\n\n${texts.join("\n\n") || "(no licence file shipped with this package)"}`);
            }
            break;
          }
          dir = path.dirname(dir);
        }
      }
      const entries = [...seen.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, text]) => text);
      this.emitFile({
        type: "asset",
        fileName: "third-party-licenses.txt",
        source: `Third-party software included in this site\n\n${entries.join(`\n\n${"-".repeat(72)}\n\n`)}\n`,
      });
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    absoluteShareUrls(process.env.VITE_SITE_URL),
    launchpadManifestOrigin(process.env.VITE_SITE_URL),
    thirdPartyLicenses(),
  ],
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
  // Privy is reachable only through the lazily-imported AccountShell, so Vite's
  // startup scan misses it and re-optimizes on the first /account visit —
  // invalidating chunks the browser has already fetched. The result is a 404 on
  // a deps chunk and "Failed to fetch dynamically imported module". Pre-bundle
  // it so there is no second pass.
  optimizeDeps: { include: ["@privy-io/react-auth", "@radix-ui/react-select", "viem", "viem/chains", "@cofhe/sdk/web", "@cofhe/sdk/chains", "@cofhe/sdk"] },
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
  // CoFHE's browser decrypt worker is loaded only from the lazy checkout
  // chunk. Rollup cannot emit an IIFE worker inside this code-split build.
  worker: { format: "es" },
  server: {
    // Bind IPv4 loopback explicitly: localhost resolved to IPv6-only here,
    // leaving browser requests to 127.0.0.1 refused.
    host: "127.0.0.1",
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
