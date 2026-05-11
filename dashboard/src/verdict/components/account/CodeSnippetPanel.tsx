// ─── CodeSnippetPanel — tabbed multi-language snippet renderer (Phase 7d) ──
//
// Three use sites planned (V2 §7 onboarding research):
//   1. `IntegratePage` — Step f of the new-agent flow. Receives the freshly
//      minted api key inline via sessionStorage handoff from
//      ApiKeyMintModal, so the TS/Python snippets show a complete copy-
//      pasteable curl. The env-var fallback kicks in after the session
//      handoff clears (5 min later, or on page refresh).
//   2. `LaunchPage.compact` — public install track. The user is NOT
//      authenticated, so the panel always renders the env-var fallback
//      (no apiKey prop). Phase 7d refactor swaps the bespoke TrackBrief
//      snippet block for this component without changing the surrounding
//      layout. Bold + calm variants stay on the old pattern until the
//      Phase 12 variant sweep.
//   3. `AgentProfilePage` (Phase 12+) — public profile shows env-var-only
//      snippets keyed to the agent's id so visitors who own that agent
//      know exactly what to wire up.
//
// Design idiom:
//   · Top strip = three bracketed tab buttons + a [ COPY ] button. Brackets
//     are the Nothing-design convention (see ApiKeyMintModal, ApiKeysPanel).
//   · Body = monospace <pre> with no line numbers. Line numbers in a
//     three-language tab strip make the visual diff between languages
//     louder than the content — judgement-call dropped per spec.
//   · Copy uses the same clipboard-fallback as ApiKeyMintModal: we only
//     show "copied" after writeText resolves, otherwise surface a manual-
//     copy hint. Critical for the IntegratePage path — a false-positive
//     copy on the key snippet wastes the user's only chance.
//
// API base URL: read from import.meta.env.VITE_VERDICT_API_URL, default to
// the placeholder "https://murmur.verdict". Substituted consistently across
// all three languages so users can paste any one and get a working call.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type SnippetLanguage = "typescript" | "python" | "curl";

export interface CodeSnippetPanelProps {
  /** Substituted as X-Murmur-Agent-Id header value. */
  agentId?: string;
  /**
   * When present (e.g. just-minted on /integrate), included in TS/Python
   * snippets verbatim. When undefined, snippets show MURMUR_API_KEY env-var
   * references instead.
   */
  apiKey?: string;
  /**
   * Optional pass-through — IntegratePage uses this to display the agent
   * crumb. Not used inside the panel itself today, exposed for callers
   * that want a label header without recomputing.
   */
  agentSlug?: string;
  /** Subset of languages to render. Defaults to all three. */
  languages?: SnippetLanguage[];
  /** Which tab opens active. Defaults to "typescript". */
  initialLanguage?: SnippetLanguage;
  /**
   * When false, omits the tab + copy strip entirely. The body still
   * renders the initialLanguage snippet — useful for embedding inside
   * a parent that wants its own header. Defaults to true.
   */
  showHeader?: boolean;
  /**
   * Override the outer container class. Defaults to "ck-frame", which
   * is the compact-shell idiom used by the rest of the account flow.
   * Pass "" to skip the framing entirely.
   */
  containerClass?: string;
}

const ALL_LANGUAGES: SnippetLanguage[] = ["typescript", "python", "curl"];

const TAB_LABEL: Record<SnippetLanguage, string> = {
  typescript: "TS",
  python: "PY",
  curl: "CURL",
};

/**
 * Read the dashboard's configured daemon base URL with a placeholder
 * fallback. The placeholder ("https://murmur.verdict") is intentionally
 * fake — it makes copy-pasted snippets fail loudly on a misconfigured
 * deploy, instead of silently hitting localhost.
 */
function getApiBase(): string {
  const env = (import.meta.env.VITE_VERDICT_API_URL ?? "").toString().trim();
  if (env.length > 0) return env.replace(/\/$/, "");
  return "https://murmur.verdict";
}

/**
 * Substitute the `{{agentId}}` / `{{base}}` placeholders in a template.
 *
 * Codex P2 fix — `{{apiKey}}` is NOT substituted here. Earlier versions
 * replaced `"{{apiKey}}"` (already-quoted in templates) with the env-var
 * reference, which produced `"${process.env.MURMUR_API_KEY}"` (literal
 * string in TS) or `"os.environ["MURMUR_API_KEY"]"` (invalid Python).
 * Now we pick the template by apiKey presence — see `pickTemplate` —
 * and the chosen template embeds the right form natively.
 */
function renderSnippet(
  template: string,
  agentId: string,
  apiKey: string | undefined,
  base: string,
): string {
  let out = template.replaceAll("{{base}}", base).replaceAll("{{agentId}}", agentId);
  if (apiKey !== undefined) out = out.replaceAll("{{apiKey}}", apiKey);
  return out;
}

// ─── Templates ──────────────────────────────────────────────────────────────
// Codex P1 fix — every snippet matches the v0.2 SubmittedCallSchema:
//   schema_version, agent_id, client_order_id, asset_id, side,
//   horizon_hours, confidence, submitted_at, rationale|strategy_tag.
// Response is unwrapped: { call: { call_id }, status, idempotent_hit }.

const TS_WITH_KEY = `// Submit a Murmur call (BUY ETH, 4h horizon, 0.72 confidence)
const res = await fetch("{{base}}/v1/calls", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Murmur-Agent-Id": "{{agentId}}",
    "X-Murmur-Api-Key": "{{apiKey}}",
  },
  body: JSON.stringify({
    schema_version: 1,
    agent_id: "{{agentId}}",
    client_order_id: crypto.randomUUID(),
    asset_id: "base:ETH:USD",
    side: "BUY",
    horizon_hours: 4,
    confidence: 0.72,
    submitted_at: new Date().toISOString(),
    rationale: "demo: paste into your agent",
  }),
});
const result = await res.json();
console.log(result.call.call_id, result.status);`;

const TS_ENV_REF = `// Submit a Murmur call (BUY ETH, 4h horizon, 0.72 confidence)
const apiKey = process.env.MURMUR_API_KEY ?? "";
const res = await fetch("{{base}}/v1/calls", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Murmur-Agent-Id": "{{agentId}}",
    "X-Murmur-Api-Key": apiKey,
  },
  body: JSON.stringify({
    schema_version: 1,
    agent_id: "{{agentId}}",
    client_order_id: crypto.randomUUID(),
    asset_id: "base:ETH:USD",
    side: "BUY",
    horizon_hours: 4,
    confidence: 0.72,
    submitted_at: new Date().toISOString(),
    rationale: "demo: paste into your agent",
  }),
});
const result = await res.json();
console.log(result.call.call_id, result.status);`;

const PY_WITH_KEY = `import datetime
import json
import urllib.request
import uuid

req = urllib.request.Request(
    "{{base}}/v1/calls",
    method="POST",
    headers={
        "Content-Type": "application/json",
        "X-Murmur-Agent-Id": "{{agentId}}",
        "X-Murmur-Api-Key": "{{apiKey}}",
    },
    data=json.dumps({
        "schema_version": 1,
        "agent_id": "{{agentId}}",
        "client_order_id": str(uuid.uuid4()),
        "asset_id": "base:ETH:USD",
        "side": "BUY",
        "horizon_hours": 4,
        "confidence": 0.72,
        "submitted_at": datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S.%fZ"),
        "rationale": "demo: paste into your agent",
    }).encode(),
)
with urllib.request.urlopen(req) as resp:
    body = json.load(resp)
    print(body["call"]["call_id"], body["status"])`;

const PY_ENV_REF = `import datetime
import json
import os
import urllib.request
import uuid

req = urllib.request.Request(
    "{{base}}/v1/calls",
    method="POST",
    headers={
        "Content-Type": "application/json",
        "X-Murmur-Agent-Id": "{{agentId}}",
        "X-Murmur-Api-Key": os.environ["MURMUR_API_KEY"],
    },
    data=json.dumps({
        "schema_version": 1,
        "agent_id": "{{agentId}}",
        "client_order_id": str(uuid.uuid4()),
        "asset_id": "base:ETH:USD",
        "side": "BUY",
        "horizon_hours": 4,
        "confidence": 0.72,
        "submitted_at": datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S.%fZ"),
        "rationale": "demo: paste into your agent",
    }).encode(),
)
with urllib.request.urlopen(req) as resp:
    body = json.load(resp)
    print(body["call"]["call_id"], body["status"])`;

// curl: `$MURMUR_API_KEY` expands inside double quotes, so one template
// suffices — substitute either the literal key or the env-var name.
const CURL_TEMPLATE = `curl -X POST {{base}}/v1/calls \\
  -H "Content-Type: application/json" \\
  -H "X-Murmur-Agent-Id: {{agentId}}" \\
  -H "X-Murmur-Api-Key: {{apiKey}}" \\
  -d '{
    "schema_version": 1,
    "agent_id": "{{agentId}}",
    "client_order_id": "'"$(uuidgen)"'",
    "asset_id": "base:ETH:USD",
    "side": "BUY",
    "horizon_hours": 4,
    "confidence": 0.72,
    "submitted_at": "'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'",
    "rationale": "demo: paste into your agent"
  }'`;

function pickTemplate(language: SnippetLanguage, hasKey: boolean): string {
  if (language === "typescript") return hasKey ? TS_WITH_KEY : TS_ENV_REF;
  if (language === "python") return hasKey ? PY_WITH_KEY : PY_ENV_REF;
  return CURL_TEMPLATE;
}

export function CodeSnippetPanel({
  agentId,
  apiKey,
  languages,
  initialLanguage = "typescript",
  showHeader = true,
  containerClass = "ck-frame",
}: CodeSnippetPanelProps) {
  const langs = useMemo<SnippetLanguage[]>(() => {
    if (!languages || languages.length === 0) return ALL_LANGUAGES;
    // Preserve the caller's order, filter duplicates.
    const seen = new Set<SnippetLanguage>();
    const out: SnippetLanguage[] = [];
    for (const l of languages) {
      if (!seen.has(l)) {
        seen.add(l);
        out.push(l);
      }
    }
    return out;
  }, [languages]);

  // Initial active tab — clamp to the available subset so a stale
  // `initialLanguage="curl"` with languages=["typescript"] doesn't render
  // an empty body.
  const [active, setActive] = useState<SnippetLanguage>(() =>
    langs.includes(initialLanguage) ? initialLanguage : langs[0]!,
  );

  // Codex P2 (carried over from ApiKeyMintModal pattern): only set "copied"
  // feedback after writeText resolves; surface a manual-copy hint when
  // the clipboard API is unavailable or rejected. False-positive copies
  // on snippet panels are less catastrophic than on a one-time key, but
  // the muscle memory matters — keep the UI honest.
  const [copied, setCopied] = useState(false);
  const [copyFallback, setCopyFallback] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, []);

  const base = getApiBase();
  // The renderer ignores agentId when not provided — show a hint
  // placeholder that the user replaces. Surfacing "<agent-id>" in the
  // snippet beats showing "undefined" if a caller forgot the prop.
  const effectiveAgentId = agentId ?? "<agent-id>";

  const body = useMemo(() => {
    const hasKey = apiKey !== undefined;
    const tpl = pickTemplate(active, hasKey);
    // curl substitutes apiKey from either the literal key or the env-var
    // string `$MURMUR_API_KEY` (which bash expands inside double quotes).
    const curlKey = hasKey ? apiKey : "$MURMUR_API_KEY";
    const renderKey = active === "curl" ? curlKey : apiKey;
    return renderSnippet(tpl, effectiveAgentId, renderKey, base);
  }, [active, effectiveAgentId, apiKey, base]);

  const doCopy = useCallback(async () => {
    if (!navigator.clipboard?.writeText) {
      setCopyFallback(true);
      setCopied(false);
      return;
    }
    try {
      await navigator.clipboard.writeText(body);
      setCopied(true);
      setCopyFallback(false);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopyFallback(true);
      setCopied(false);
    }
  }, [body]);

  // Reset the copy-feedback state when switching tabs so a stale
  // "[COPIED]" badge from the previous tab doesn't lie about the new one.
  useEffect(() => {
    setCopied(false);
    setCopyFallback(false);
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
  }, [active]);

  const containerProps = containerClass ? { className: containerClass } : {};

  return (
    <section {...containerProps}>
      {showHeader && (
        <div className="ck-header">
          <span className="flex items-center gap-1">
            {langs.map((l) => (
              <button
                key={l}
                type="button"
                onClick={() => setActive(l)}
                className={
                  "ck-btn " + (active === l ? "ck-btn-active" : "")
                }
                aria-pressed={active === l}
              >
                [ {TAB_LABEL[l]} ]
              </button>
            ))}
          </span>
          <span className="flex items-center gap-2">
            {copyFallback && (
              <span
                className="ck-mono text-[10px]"
                style={{ color: "var(--color-accent)" }}
                aria-live="polite"
              >
                × clipboard blocked — Cmd-C / Ctrl-C
              </span>
            )}
            <button
              type="button"
              onClick={() => void doCopy()}
              className="ck-btn"
              aria-label={`copy ${TAB_LABEL[active]} snippet`}
            >
              {copied ? "[ COPIED ]" : "[ COPY ]"}
            </button>
          </span>
        </div>
      )}
      <pre className="ck-mono whitespace-pre overflow-x-auto px-3 py-2 leading-tight text-[11px]">
        {body}
      </pre>
    </section>
  );
}
