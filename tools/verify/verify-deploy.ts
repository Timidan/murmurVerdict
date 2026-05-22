#!/usr/bin/env tsx
/**
 * Deploy verifier — hits a public daemon + dashboard pair and prints a
 * green/red diagnostic across 14 endpoint shapes.
 *
 * Usage:
 *   tsx tools/verify/verify-deploy.ts \
 *     --api https://murmur.verdict \
 *     --dashboard https://murmur.app \
 *     --slug murmur-momentum
 *
 * Env fallbacks (any flag can be replaced):
 *   PUBLIC_API_URL, PUBLIC_DASHBOARD_URL, VERIFY_SLUG
 *
 * Exit code 0 if every check passes; 1 otherwise.
 */

interface Args {
  api: string;
  dashboard: string;
  slug: string;
}

function parseArgs(argv: string[]): Args {
  const get = (k: string): string | undefined => {
    const idx = argv.indexOf(`--${k}`);
    return idx >= 0 && idx + 1 < argv.length ? argv[idx + 1] : undefined;
  };
  return {
    api: (get("api") ?? process.env.PUBLIC_API_URL ?? "http://localhost:8080").replace(/\/$/, ""),
    dashboard: (get("dashboard") ?? process.env.PUBLIC_DASHBOARD_URL ?? "http://127.0.0.1:5176").replace(/\/$/, ""),
    slug: get("slug") ?? process.env.VERIFY_SLUG ?? "murmur-momentum",
  };
}

interface Check {
  name: string;
  url: string;
  expectStatus?: number; // default 200
  expectContentType?: RegExp;
  expectBodyContains?: RegExp;
  expectBodyMatches?: (body: string, headers: Headers) => string | null; // null = pass, string = failure reason
  method?: "GET" | "POST";
  body?: unknown;
  /** Skip this check if the previous one of the same name failed (used for ETag). */
  dependsOnEtagFor?: string;
}

const ANSI = {
  green: "\x1b[32m",
  red: "\x1b[31m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  reset: "\x1b[0m",
};

interface Result {
  name: string;
  url: string;
  ok: boolean;
  status?: number;
  contentType?: string;
  ms: number;
  detail?: string;
}

async function runCheck(c: Check): Promise<Result> {
  const start = Date.now();
  try {
    const res = await fetch(c.url, {
      method: c.method ?? "GET",
      headers: c.body ? { "Content-Type": "application/json" } : undefined,
      body: c.body ? JSON.stringify(c.body) : undefined,
    });
    const ct = res.headers.get("content-type") ?? "";
    const ms = Date.now() - start;
    if (res.status !== (c.expectStatus ?? 200)) {
      return {
        name: c.name,
        url: c.url,
        ok: false,
        status: res.status,
        contentType: ct,
        ms,
        detail: `expected ${c.expectStatus ?? 200} got ${res.status}`,
      };
    }
    if (c.expectContentType && !c.expectContentType.test(ct)) {
      return {
        name: c.name,
        url: c.url,
        ok: false,
        status: res.status,
        contentType: ct,
        ms,
        detail: `content-type "${ct}" doesn't match ${c.expectContentType}`,
      };
    }
    let body = "";
    if (c.expectBodyContains || c.expectBodyMatches) {
      body = await res.text();
    }
    if (c.expectBodyContains && !c.expectBodyContains.test(body)) {
      return {
        name: c.name,
        url: c.url,
        ok: false,
        status: res.status,
        contentType: ct,
        ms,
        detail: `body doesn't contain ${c.expectBodyContains}`,
      };
    }
    if (c.expectBodyMatches) {
      const failure = c.expectBodyMatches(body, res.headers);
      if (failure !== null) {
        return {
          name: c.name,
          url: c.url,
          ok: false,
          status: res.status,
          contentType: ct,
          ms,
          detail: failure,
        };
      }
    }
    return { name: c.name, url: c.url, ok: true, status: res.status, contentType: ct, ms };
  } catch (err) {
    const ms = Date.now() - start;
    return {
      name: c.name,
      url: c.url,
      ok: false,
      ms,
      detail: (err as Error).message,
    };
  }
}

function formatResult(r: Result): string {
  const tick = r.ok ? `${ANSI.green}✓${ANSI.reset}` : `${ANSI.red}✗${ANSI.reset}`;
  const status = r.status !== undefined ? String(r.status).padEnd(4) : "—   ";
  const ms = String(r.ms).padStart(4) + "ms";
  const ct = r.contentType ?? "";
  const detail = r.detail ? `  ${ANSI.dim}${r.detail}${ANSI.reset}` : "";
  return `  ${tick} ${ANSI.dim}${status}${ANSI.reset} ${ms}  ${r.name.padEnd(36)} ${ANSI.dim}${ct}${ANSI.reset}${detail}`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(`\n${ANSI.bold}Murmur Verdict — deploy verifier${ANSI.reset}`);
  console.log(`  api       ${args.api}`);
  console.log(`  dashboard ${args.dashboard}`);
  console.log(`  slug      ${args.slug}\n`);

  const checks: Check[] = [
    { name: "daemon /v1/health", url: `${args.api}/v1/health`, expectContentType: /json/, expectBodyContains: /ok/ },
    { name: "daemon /v1/meta", url: `${args.api}/v1/meta`, expectContentType: /json/, expectBodyContains: /schema_version/ },
    { name: "daemon /v1/leaderboard", url: `${args.api}/v1/leaderboard`, expectContentType: /json/, expectBodyContains: /rows/ },
    { name: "daemon /v1/feed/today", url: `${args.api}/v1/feed/today`, expectContentType: /json/, expectBodyContains: /accepted_recent/ },
    { name: "daemon /v1/agents?kind=agent", url: `${args.api}/v1/agents?kind=agent`, expectContentType: /json/, expectBodyContains: /count/ },
    { name: "daemon /v1/agents/:slug", url: `${args.api}/v1/agents/${args.slug}`, expectContentType: /json/, expectBodyContains: /agent_id/ },
    { name: "daemon /v1/agents/:slug/calls", url: `${args.api}/v1/agents/${args.slug}/calls`, expectContentType: /json/, expectBodyContains: /calls/ },
    { name: "daemon /v1/agents/:slug/calls.xml", url: `${args.api}/v1/agents/${args.slug}/calls.xml`, expectContentType: /xml/, expectBodyContains: /<rss/ },
    { name: "daemon /v1/agents/:slug/discoverers", url: `${args.api}/v1/agents/${args.slug}/discoverers`, expectContentType: /json/, expectBodyContains: /discoverers/ },
    { name: "daemon /v1/refs/top", url: `${args.api}/v1/refs/top`, expectContentType: /json/, expectBodyContains: /senders/ },
    { name: "daemon /v1/badge/:slug.svg", url: `${args.api}/v1/badge/${args.slug}.svg`, expectContentType: /svg/, expectBodyContains: /<svg/ },
    { name: "daemon /v1/badge/:slug.png", url: `${args.api}/v1/badge/${args.slug}.png`, expectContentType: /png/ },
    { name: "daemon /v1/og/:slug.svg", url: `${args.api}/v1/og/${args.slug}.svg`, expectContentType: /svg/, expectBodyContains: /viewBox="0 0 1200 630"/ },
    { name: "daemon /v1/og/:slug.png", url: `${args.api}/v1/og/${args.slug}.png`, expectContentType: /png/ },
    { name: "daemon /v1/openapi.json", url: `${args.api}/v1/openapi.json`, expectContentType: /json/, expectBodyContains: /Murmur Verdict/ },
    { name: "daemon /embed.js", url: `${args.api}/embed.js`, expectContentType: /javascript/, expectBodyContains: /data-slug/ },
    { name: "daemon /v1/snapshot.md", url: `${args.api}/v1/snapshot.md`, expectContentType: /markdown/, expectBodyContains: /Murmur Verdict/ },
    { name: "daemon /v1/leaderboard.csv", url: `${args.api}/v1/leaderboard.csv`, expectContentType: /csv/, expectBodyContains: /^rank,display_slug/ },
    { name: "daemon /v1/stats", url: `${args.api}/v1/stats`, expectContentType: /json/, expectBodyContains: /agents_total/ },
    {
      name: "daemon /share/:slug (OG meta)",
      url: `${args.api}/share/${args.slug}`,
      expectContentType: /html/,
      expectBodyMatches: (body) => {
        if (!/og:image/.test(body)) return "missing og:image meta";
        if (!/twitter:image/.test(body)) return "missing twitter:image meta";
        if (!new RegExp(`/v1/og/${args.slug}\\.png`).test(body))
          return "og:image doesn't reference per-slug PNG";
        return null;
      },
    },
    {
      name: "daemon /v1/agents/:slug/agent-card",
      url: `${args.api}/v1/agents/${args.slug}/agent-card`,
      expectContentType: /json/,
      expectBodyMatches: (body) => {
        if (!/"type"\s*:\s*"ERC-8004:AgentCard"/.test(body)) return "wrong card type";
        if (!/"services"\s*:/.test(body)) return "missing services array";
        if (!/"x402Support"\s*:\s*false/.test(body)) return "x402Support should stay false until payment rails are wired";
        return null;
      },
    },
    {
      name: "daemon /v1/skill.md (agent self-onboarding)",
      url: `${args.api}/v1/skill.md`,
      expectContentType: /markdown/,
      expectBodyMatches: (body) => {
        if (!/^---\nname:\s*murmur-verdict-register/m.test(body))
          return "missing claude-skill frontmatter";
        if (!/Controller Wallet/i.test(body)) return "skill should describe Controller Wallet onboarding";
        if (!/Runtime Key/i.test(body)) return "skill should describe Runtime Key onboarding";
        return null;
      },
    },
    { name: "daemon /v1/stream (SSE handshake)", url: `${args.api}/v1/stream`, expectContentType: /event-stream/ },
    { name: "dashboard /", url: `${args.dashboard}/`, expectContentType: /html/, expectBodyContains: /<div id="root">/ },
    { name: "dashboard /.well-known/murmur.json", url: `${args.dashboard}/.well-known/murmur.json`, expectContentType: /json/, expectBodyContains: /murmur-verdict/ },
  ];

  const results: Result[] = [];
  for (const c of checks) {
    const r = await runCheck(c);
    results.push(r);
    console.log(formatResult(r));
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  const tone = failed === 0 ? ANSI.green : ANSI.red;
  console.log(`\n  ${tone}${ANSI.bold}${passed} / ${results.length} passed${ANSI.reset}\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
