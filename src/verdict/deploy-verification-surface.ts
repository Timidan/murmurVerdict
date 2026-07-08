export interface DeployVerificationTarget {
  api: string;
  dashboard: string;
  expectNanopayX402?: boolean;
  nanopayPipelineId?: string;
  slug: string;
}

export interface DeployVerificationCheck {
  name: string;
  url: string;
  expectStatus?: number;
  expectContentType?: RegExp;
  expectBodyContains?: RegExp;
  expectBodyMatches?: (body: string, headers: Headers) => string | null;
  method?: "GET" | "POST";
  body?: unknown;
}

export interface DeployVerificationResult {
  name: string;
  url: string;
  ok: boolean;
  status?: number;
  contentType?: string;
  ms: number;
  detail?: string;
}

export type DeployVerificationFetchAdapter = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;

export interface DeployVerificationClock {
  nowMs: () => number;
}

const ANSI = {
  green: "\x1b[32m",
  red: "\x1b[31m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  reset: "\x1b[0m",
};

export function deployVerificationChecks(
  target: DeployVerificationTarget,
): DeployVerificationCheck[] {
  const checks: DeployVerificationCheck[] = [
    {
      name: "daemon /v1/health",
      url: `${target.api}/v1/health`,
      expectContentType: /json/,
      expectBodyContains: /ok/,
    },
    {
      name: "daemon /v1/meta",
      url: `${target.api}/v1/meta`,
      expectContentType: /json/,
      expectBodyContains: /schema_version/,
    },
    {
      name: "daemon /v1/leaderboard",
      url: `${target.api}/v1/leaderboard`,
      expectContentType: /json/,
      expectBodyContains: /rows/,
    },
    {
      name: "daemon /v1/feed/today",
      url: `${target.api}/v1/feed/today`,
      expectContentType: /json/,
      expectBodyContains: /accepted_recent/,
    },
    {
      name: "daemon /v1/agents?kind=agent",
      url: `${target.api}/v1/agents?kind=agent`,
      expectContentType: /json/,
      expectBodyContains: /count/,
    },
    {
      name: "daemon /v1/agents/:slug",
      url: `${target.api}/v1/agents/${target.slug}`,
      expectContentType: /json/,
      expectBodyContains: /agent_id/,
    },
    {
      name: "daemon /v1/agents/:slug/calls",
      url: `${target.api}/v1/agents/${target.slug}/calls`,
      expectContentType: /json/,
      expectBodyContains: /calls/,
    },
    {
      name: "daemon /v1/agents/:slug/calls.xml",
      url: `${target.api}/v1/agents/${target.slug}/calls.xml`,
      expectContentType: /xml/,
      expectBodyContains: /<rss/,
    },
    {
      name: "daemon /v1/agents/:slug/discoverers",
      url: `${target.api}/v1/agents/${target.slug}/discoverers`,
      expectContentType: /json/,
      expectBodyContains: /discoverers/,
    },
    {
      name: "daemon /v1/refs/top",
      url: `${target.api}/v1/refs/top`,
      expectContentType: /json/,
      expectBodyContains: /senders/,
    },
    {
      name: "daemon /v1/badge/:slug.svg",
      url: `${target.api}/v1/badge/${target.slug}.svg`,
      expectContentType: /svg/,
      expectBodyContains: /<svg/,
    },
    {
      name: "daemon /v1/badge/:slug.png",
      url: `${target.api}/v1/badge/${target.slug}.png`,
      expectContentType: /png/,
    },
    {
      name: "daemon /v1/og/:slug.svg",
      url: `${target.api}/v1/og/${target.slug}.svg`,
      expectContentType: /svg/,
      expectBodyContains: /viewBox="0 0 1200 630"/,
    },
    {
      name: "daemon /v1/og/:slug.png",
      url: `${target.api}/v1/og/${target.slug}.png`,
      expectContentType: /png/,
    },
    {
      name: "daemon /v1/openapi.json",
      url: `${target.api}/v1/openapi.json`,
      expectContentType: /json/,
      expectBodyContains: /Murmur Verdict/,
    },
    {
      name: "daemon /embed.js",
      url: `${target.api}/embed.js`,
      expectContentType: /javascript/,
      expectBodyContains: /data-slug/,
    },
    {
      name: "daemon /v1/snapshot.md",
      url: `${target.api}/v1/snapshot.md`,
      expectContentType: /markdown/,
      expectBodyContains: /Murmur Verdict/,
    },
    {
      name: "daemon /v1/leaderboard.csv",
      url: `${target.api}/v1/leaderboard.csv`,
      expectContentType: /csv/,
      expectBodyContains: /^rank,display_slug/,
    },
    {
      name: "daemon /v1/stats",
      url: `${target.api}/v1/stats`,
      expectContentType: /json/,
      expectBodyContains: /agents_total/,
    },
    {
      name: "daemon /share/:slug (OG meta)",
      url: `${target.api}/share/${target.slug}`,
      expectContentType: /html/,
      expectBodyMatches: (body) => {
        if (!/og:image/.test(body)) return "missing og:image meta";
        if (!/twitter:image/.test(body)) return "missing twitter:image meta";
        if (!new RegExp(`/v1/og/${target.slug}\\.png`).test(body)) {
          return "og:image doesn't reference per-slug PNG";
        }
        return null;
      },
    },
    {
      name: "daemon /v1/agents/:slug/agent-card",
      url: `${target.api}/v1/agents/${target.slug}/agent-card`,
      expectContentType: /json/,
      expectBodyMatches: (body) => {
        if (!/"type"\s*:\s*"ERC-8004:AgentCard"/.test(body)) {
          return "wrong card type";
        }
        if (!/"services"\s*:/.test(body)) return "missing services array";
        const declaresX402 = /"x402Support"\s*:\s*true/.test(body);
        const containsNanopayEndpoint = /\/v2\/nanopay\/infer\/\{pipelineId\}/.test(body);
        if (target.expectNanopayX402 === true && !declaresX402) {
          return "agent card should declare mounted x402 support";
        }
        if (target.expectNanopayX402 === false && declaresX402) {
          return "agent card declares x402 support but Nanopay is not expected";
        }
        if (declaresX402 && !containsNanopayEndpoint) {
          return "agent card declares x402 support without Nanopay endpoint";
        }
        if (!declaresX402 && containsNanopayEndpoint) {
          return "agent card exposes Nanopay endpoint while x402Support is false";
        }
        return null;
      },
    },
    {
      name: "daemon /v1/skill.md (agent self-onboarding)",
      url: `${target.api}/v1/skill.md`,
      expectContentType: /markdown/,
      expectBodyMatches: (body) => {
        if (!/^---\nname:\s*murmur-verdict-register/m.test(body)) {
          return "missing claude-skill frontmatter";
        }
        if (!/Controller Wallet/i.test(body)) {
          return "skill should describe Controller Wallet onboarding";
        }
        if (!/Runtime Key/i.test(body)) {
          return "skill should describe Runtime Key onboarding";
        }
        return null;
      },
    },
    {
      name: "daemon /v1/stream (SSE handshake)",
      url: `${target.api}/v1/stream`,
      expectContentType: /event-stream/,
    },
    {
      name: "dashboard /",
      url: `${target.dashboard}/`,
      expectContentType: /html/,
      expectBodyContains: /<div id="root">/,
    },
    {
      name: "dashboard /.well-known/murmur.json",
      url: `${target.dashboard}/.well-known/murmur.json`,
      expectContentType: /json/,
      expectBodyContains: /murmur-verdict/,
    },
  ];

  if (target.expectNanopayX402 === true && target.nanopayPipelineId) {
    checks.push({
      name: "daemon /v2/nanopay/infer/:pipelineId (x402)",
      url: `${target.api}/v2/nanopay/infer/${target.nanopayPipelineId}`,
      method: "POST",
      body: {},
      expectStatus: 402,
    });
  }

  return checks;
}

export async function runDeployVerificationCheck(input: {
  check: DeployVerificationCheck;
  fetcher?: DeployVerificationFetchAdapter;
  clock?: DeployVerificationClock;
}): Promise<DeployVerificationResult> {
  const c = input.check;
  const nowMs = input.clock?.nowMs ?? (() => Date.now());
  const fetcher = input.fetcher ?? fetch;
  const start = nowMs();
  try {
    const res = await fetcher(c.url, {
      method: c.method ?? "GET",
      headers: c.body ? { "Content-Type": "application/json" } : undefined,
      body: c.body ? JSON.stringify(c.body) : undefined,
    });
    const ct = res.headers.get("content-type") ?? "";
    const ms = nowMs() - start;
    if (res.status !== (c.expectStatus ?? 200)) {
      return failure(c, ms, {
        status: res.status,
        contentType: ct,
        detail: `expected ${c.expectStatus ?? 200} got ${res.status}`,
      });
    }
    if (c.expectContentType && !c.expectContentType.test(ct)) {
      return failure(c, ms, {
        status: res.status,
        contentType: ct,
        detail: `content-type "${ct}" doesn't match ${c.expectContentType}`,
      });
    }
    let body = "";
    if (c.expectBodyContains || c.expectBodyMatches) {
      body = await res.text();
    }
    if (c.expectBodyContains && !c.expectBodyContains.test(body)) {
      return failure(c, ms, {
        status: res.status,
        contentType: ct,
        detail: `body doesn't contain ${c.expectBodyContains}`,
      });
    }
    if (c.expectBodyMatches) {
      const detail = c.expectBodyMatches(body, res.headers);
      if (detail !== null) {
        return failure(c, ms, {
          status: res.status,
          contentType: ct,
          detail,
        });
      }
    }
    return {
      name: c.name,
      url: c.url,
      ok: true,
      status: res.status,
      contentType: ct,
      ms,
    };
  } catch (err) {
    return failure(c, nowMs() - start, {
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

export function renderDeployVerificationHeader(
  target: DeployVerificationTarget,
): string {
  return [
    "",
    `${ANSI.bold}Murmur Verdict - deploy verifier${ANSI.reset}`,
    `  api       ${target.api}`,
    `  dashboard ${target.dashboard}`,
    `  slug      ${target.slug}`,
    `  nanopay   ${target.expectNanopayX402 === undefined ? "auto" : target.expectNanopayX402 ? "expected" : "not expected"}${target.nanopayPipelineId ? ` (${target.nanopayPipelineId})` : ""}`,
    "",
  ].join("\n");
}

export function formatDeployVerificationResult(
  r: DeployVerificationResult,
): string {
  const tick = r.ok
    ? `${ANSI.green}\u2713${ANSI.reset}`
    : `${ANSI.red}\u2717${ANSI.reset}`;
  const status = r.status !== undefined ? String(r.status).padEnd(4) : "-   ";
  const ms = `${String(r.ms).padStart(4)}ms`;
  const ct = r.contentType ?? "";
  const detail = r.detail ? `  ${ANSI.dim}${r.detail}${ANSI.reset}` : "";
  return `  ${tick} ${ANSI.dim}${status}${ANSI.reset} ${ms}  ${r.name.padEnd(36)} ${ANSI.dim}${ct}${ANSI.reset}${detail}`;
}

export function deployVerificationSummary(
  results: DeployVerificationResult[],
): { passed: number; failed: number; total: number } {
  const passed = results.filter((r) => r.ok).length;
  return {
    passed,
    failed: results.length - passed,
    total: results.length,
  };
}

export function renderDeployVerificationSummary(
  results: DeployVerificationResult[],
): string {
  const summary = deployVerificationSummary(results);
  const tone = summary.failed === 0 ? ANSI.green : ANSI.red;
  return `\n  ${tone}${ANSI.bold}${summary.passed} / ${summary.total} passed${ANSI.reset}\n`;
}

function failure(
  c: DeployVerificationCheck,
  ms: number,
  fields: Pick<DeployVerificationResult, "detail"> &
    Partial<Pick<DeployVerificationResult, "status" | "contentType">>,
): DeployVerificationResult {
  return {
    name: c.name,
    url: c.url,
    ok: false,
    ms,
    ...fields,
  };
}
