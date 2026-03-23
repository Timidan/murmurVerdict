import { type AssetSlug, type ScoredAsset } from "../types/index.js";

// Beta API for hackathon participants — production is api.paywithlocus.com
const LOCUS_BASE_URL = "https://beta-api.paywithlocus.com/api/wrapped";
const LOCUS_TIMEOUT_MS = 20_000;

const ASSET_LABELS: Record<AssetSlug, string> = {
  ethereum: "ETH",
  weth: "WETH",
  "wrapped-bitcoin": "cbBTC",
  aave: "AAVE",
  uniswap: "UNI",
  chainlink: "LINK",
  "aerodrome-finance": "AERO",
  "virtual-protocol": "VIRTUAL",
};

export interface LocusMarketContext {
  status: "disabled" | "ready" | "error";
  provider: string;
  endpoint: string;
  query: string;
  fetchedAt: string;
  promptContext: string | null;
  sources: { title: string; url: string }[];
  error: string | null;
}

export async function fetchLocusMarketContext(params: {
  apiKey?: string;
  candidates: ScoredAsset[];
  cycleId: string;
}): Promise<LocusMarketContext> {
  const apiKey = params.apiKey?.trim() ?? "";
  const fetchedAt = new Date().toISOString();
  const focusAssets = params.candidates
    .slice(0, 3)
    .map((c) => ASSET_LABELS[c.slug] ?? c.slug.toUpperCase());
  const query = `What are the latest market-moving news for ${focusAssets.join(", ") || "ETH"}? Focus on catalysts relevant to DeFi trading: ETF flows, exchange incidents, regulation, protocol launches, Base ecosystem.`;

  if (!apiKey) {
    return {
      status: "disabled",
      provider: "exa",
      endpoint: "answer",
      query,
      fetchedAt,
      promptContext: null,
      sources: [],
      error: "LOCUS_API_KEY not configured",
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LOCUS_TIMEOUT_MS);

  try {
    const res = await fetch(`${LOCUS_BASE_URL}/exa/answer`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
      signal: controller.signal,
    });

    const text = await res.text();
    const json = safeParseJson(text);
    const data = (json as any)?.data ?? json;

    if (res.status === 202) {
      return {
        status: "error",
        provider: "exa",
        endpoint: "answer",
        query,
        fetchedAt,
        promptContext: null,
        sources: [],
        error: `Locus approval required: ${(data as any)?.approval_url ?? "check dashboard"}`,
      };
    }

    if (!res.ok) {
      return {
        status: "error",
        provider: "exa",
        endpoint: "answer",
        query,
        fetchedAt,
        promptContext: null,
        sources: [],
        error: `Locus API error ${res.status}: ${typeof data === "string" ? data.slice(0, 200) : JSON.stringify(data).slice(0, 200)}`,
      };
    }

    // Parse answer + sources
    const answer =
      (data as any)?.answer ??
      (data as any)?.summary ??
      (data as any)?.text ??
      null;
    const rawSources = Array.isArray((data as any)?.citations)
      ? (data as any).citations
      : Array.isArray((data as any)?.sources)
        ? (data as any).sources
        : [];

    const sources = rawSources
      .filter((s: any) => s?.url || s?.link)
      .slice(0, 5)
      .map((s: any) => ({
        title: s.title ?? s.name ?? s.url ?? "Untitled",
        url: s.url ?? s.link ?? "",
      }));

    const promptContext = answer
      ? `External context (via Locus/Exa):\n${String(answer).slice(0, 2000)}${sources.length > 0 ? `\nSources: ${sources.map((s: any) => s.title).join(" | ")}` : ""}`
      : null;

    return {
      status: answer ? "ready" : "error",
      provider: "exa",
      endpoint: "answer",
      query,
      fetchedAt,
      promptContext,
      sources,
      error: answer ? null : "No answer returned from Locus",
    };
  } catch (err) {
    return {
      status: "error",
      provider: "exa",
      endpoint: "answer",
      query,
      fetchedAt,
      promptContext: null,
      sources: [],
      error: (err as Error).message,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
