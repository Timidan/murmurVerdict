// Mock-mode fetch interceptor for the handful of pages that bypass the
// verdictApi helper and call window.fetch directly (AdminRefsPage hits
// /v1/refs + /v1/refs/<ref>; SharePage fires a /v1/refs/<ref>/click ping;
// EmbedBlock/SharePage reference /v1/og/*.svg + /v1/badge/*.svg). The
// interceptor only intercepts paths under the mock apiUrl prefix ("/mock"
// or relative /v1/) AND only when MOCK_MODE is on — non-mock builds skip
// the install entirely.

import { REFS } from "./fixtures.js";

let installed = false;

const MOCK_BASE = "/mock";

/**
 * Returns a small inline SVG so anything that requests
 * /v1/og/<slug>.svg or /v1/badge/<slug>.svg paints a placard rather than
 * a broken-image icon in mock mode. The label is just the slug.
 */
function svgPlacard(label: string, kind: "og" | "badge"): string {
  if (kind === "badge") {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="32" viewBox="0 0 160 32">
  <rect width="160" height="32" fill="#0a0a0a"/>
  <rect x="0" y="0" width="60" height="32" fill="#1c1c1c"/>
  <text x="8" y="20" font-family="ui-monospace,monospace" font-size="11" fill="#7d7d7d">murmur</text>
  <text x="68" y="20" font-family="ui-monospace,monospace" font-size="11" fill="#d3d3d3">${escapeXml(label)}</text>
</svg>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="#080808"/>
  <text x="64" y="120" font-family="ui-monospace,monospace" font-size="28" fill="#7d7d7d">murmur.verdict</text>
  <text x="64" y="230" font-family="ui-sans-serif,system-ui,sans-serif" font-weight="700" font-size="86" fill="#f5f5f5">${escapeXml(label)}</text>
  <text x="64" y="290" font-family="ui-monospace,monospace" font-size="22" fill="#7d7d7d">public referee · score updates live</text>
  <text x="64" y="560" font-family="ui-monospace,monospace" font-size="18" fill="#7d7d7d">[mock card]</text>
</svg>`;
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) =>
    c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === "&" ? "&amp;" : c === '"' ? "&quot;" : "&#39;",
  );
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function tryHandle(url: string, init: RequestInit | undefined): Response | null {
  // Strip the mock base + any host; pages build URLs as `${mockBase}/v1/...`.
  let path = url;
  if (path.startsWith("http://") || path.startsWith("https://")) {
    try {
      path = new URL(url).pathname + new URL(url).search;
    } catch {
      return null;
    }
  }
  if (path.startsWith(MOCK_BASE)) path = path.slice(MOCK_BASE.length);
  // Strip query
  const q = path.indexOf("?");
  const search = q >= 0 ? new URLSearchParams(path.slice(q + 1)) : new URLSearchParams();
  if (q >= 0) path = path.slice(0, q);

  const method = (init?.method ?? "GET").toUpperCase();

  // GET /v1/refs — admin-only sender board (mock accepts any token)
  if (method === "GET" && path === "/v1/refs") {
    const limit = Number(search.get("limit") ?? 50);
    return jsonResponse({
      senders: REFS.slice(0, limit).map((r) => ({
        ref: r.ref,
        total: r.total,
        agents_touched: r.agents_touched,
        converted: r.converted,
        last_at: r.last_at,
      })),
    });
  }

  // DELETE /v1/refs/<ref>
  const delMatch = /^\/v1\/refs\/([^/]+)$/.exec(path);
  if (method === "DELETE" && delMatch) {
    const ref = decodeURIComponent(delMatch[1]);
    const idx = REFS.findIndex((r) => r.ref === ref);
    if (idx >= 0) REFS.splice(idx, 1);
    return jsonResponse({ ok: true });
  }

  // POST /v1/refs/<ref>/click  — SharePage attribution ping (fire-and-forget)
  if (method === "POST" && /^\/v1\/refs\/[^/]+\/click$/.test(path)) {
    return new Response(null, { status: 204 });
  }

  // GET /v1/og/<slug>.svg + /v1/badge/<slug>.svg — placard SVGs
  const ogMatch = /^\/v1\/(og|badge)\/([^/]+)\.svg$/.exec(path);
  if (method === "GET" && ogMatch) {
    const kind = ogMatch[1] as "og" | "badge";
    const slug = decodeURIComponent(ogMatch[2]);
    return new Response(svgPlacard(slug, kind), {
      status: 200,
      headers: { "content-type": "image/svg+xml" },
    });
  }

  return null;
}

export function installFetchInterceptor(): void {
  if (installed) return;
  if (typeof window === "undefined" || typeof window.fetch !== "function") return;
  installed = true;
  const original = window.fetch.bind(window);
  window.fetch = async function patchedFetch(input: RequestInfo | URL, init?: RequestInit) {
    let url: string;
    if (typeof input === "string") url = input;
    else if (input instanceof URL) url = input.toString();
    else url = input.url;

    // Only intercept paths under the mock prefix. Anything else (a real
    // backend URL, third-party CDN, etc.) goes through untouched.
    if (url.startsWith(MOCK_BASE) || url.includes(MOCK_BASE + "/v1/")) {
      const handled = tryHandle(url, init);
      if (handled) return handled;
    }
    return original(input as RequestInfo, init);
  } as typeof window.fetch;
}
