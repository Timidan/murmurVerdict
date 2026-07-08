// ─── CodeSnippetPanel — tabbed multi-language snippet renderer (Phase 7d) ──
//
// Three use sites planned (V2 §7 onboarding research):
//   1. `IntegratePage` — reached via the [ integrate ] button on the
//      per-agent settings shell. Shows the canonical Runtime Key Gateway
//      path. Runtime Key plaintext is only shown by the runtime-key mint
//      flow; snippets use env-var placeholders here.
//   2. `LaunchPage` — public install track. The user is NOT
//      authenticated, so the panel always renders the env-var fallback
//      for MURMUR_RUNTIME_KEY.
//   3. `AgentProfilePage` (Phase 12+) — public profile shows env-var-only
//      snippets keyed to the agent's id so visitors who own that agent
//      know exactly what to wire up.
//
// Design idiom:
//   · Top strip = three bracketed tab buttons + a [ COPY ] button. Brackets
//     are the Nothing-design convention used across account panels.
//   · Body = monospace <pre> with no line numbers. Line numbers in a
//     three-language tab strip make the visual diff between languages
//     louder than the content — judgement-call dropped per spec.
//   · Copy uses the account-panel clipboard fallback: we only
//     show "copied" after writeText resolves, otherwise surface a manual-
//     copy hint.
//
// API base URL: read from import.meta.env.VITE_VERDICT_API_URL, default to
// the placeholder "https://murmur.verdict". Substituted consistently across
// all three languages so users can paste any one and get a working call.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type SnippetLanguage = "typescript" | "python" | "curl";

export interface CodeSnippetPanelProps {
  /**
   * Optional pass-through — IntegratePage uses this to display the agent
   * crumb. Not used inside the panel itself today, exposed for callers
   * that want a label header without recomputing.
   */
  agentSlug?: string;
  /**
   * When provided, the snippets substitute the plaintext runtime key
   * directly into each language's auth line (with a "// remove before
   * committing" comment). When omitted, snippets render the env-var
   * placeholder pattern (process.env.MURMUR_RUNTIME_KEY, etc.). This is
   * the one-time post-mint path — the secret is gone on refresh.
   */
  runtimeKey?: string;
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
 * Substitute the `{{base}}` and `{{key}}` placeholders in a template.
 * When `runtimeKey` is undefined, swap `{{key}}` for the env-var pattern
 * idiomatic to each language (handled via the `keyBlock` arg per call).
 */
function renderSnippet(
  template: string,
  base: string,
  keyBlock: string,
): string {
  return template.replaceAll("{{base}}", base).replaceAll("{{key}}", keyBlock);
}

// ─── Templates ──────────────────────────────────────────────────────────────

const TS_TEMPLATE = `// Create CoFHE inputs client-side, then let Murmur relay submitSealedFor.
{{key}}
const encrypted = await createCofheVerdictInputs({
  binaryIndex: 0,
  confidenceBps: 7200,
});
const res = await fetch("{{base}}/v2/gateway/calls", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Murmur-Runtime-Key": MURMUR_RUNTIME_KEY,
  },
  body: JSON.stringify({
    marketRef: { protocol: "polymarket-gamma", sourceId: "<condition-id>", configVersion: 1 },
    client_order_id: crypto.randomUUID(),
    client_nonce: encrypted.client_nonce,
    privacy_mode: "sealed_fhenix",
    binary_index_input: encrypted.binary_index_input,
    confidence_input: encrypted.confidence_input,
    strategy_tag: "momentum",
  }),
});
const result = await res.json();
console.log(result.call_id, result.status);`;

const PY_TEMPLATE = `import json
import os
import urllib.request
import uuid

{{key}}

encrypted = create_cofhe_verdict_inputs(binary_index=0, confidence_bps=7200)
req = urllib.request.Request(
    "{{base}}/v2/gateway/calls",
    method="POST",
    headers={
        "Content-Type": "application/json",
        "X-Murmur-Runtime-Key": MURMUR_RUNTIME_KEY,
    },
    data=json.dumps({
        "marketRef": {"protocol": "polymarket-gamma", "sourceId": "<condition-id>", "configVersion": 1},
        "client_order_id": str(uuid.uuid4()),
        "client_nonce": encrypted["client_nonce"],
        "privacy_mode": "sealed_fhenix",
        "binary_index_input": encrypted["binary_index_input"],
        "confidence_input": encrypted["confidence_input"],
        "strategy_tag": "momentum",
    }).encode(),
)
with urllib.request.urlopen(req) as resp:
    body = json.load(resp)
    print(body["call_id"], body["status"])`;

const CURL_TEMPLATE = `{{key}}
curl -X POST {{base}}/v2/gateway/calls \\
  -H "Content-Type: application/json" \\
  -H "X-Murmur-Runtime-Key: $MURMUR_RUNTIME_KEY" \\
  -d '{
    "marketRef": { "protocol": "polymarket-gamma", "sourceId": "<condition-id>", "configVersion": 1 },
    "client_order_id": "'"$(uuidgen)"'",
    "client_nonce": "0x<32 bytes>",
    "privacy_mode": "sealed_fhenix",
    "binary_index_input": { "ct_hash": "0x<32 bytes>", "security_zone": 0, "utype": 2, "signature": "0x<bytes>" },
    "confidence_input": { "ct_hash": "0x<32 bytes>", "security_zone": 0, "utype": 3, "signature": "0x<bytes>" },
    "strategy_tag": "momentum"
  }'`;

function pickTemplate(language: SnippetLanguage): string {
  if (language === "typescript") return TS_TEMPLATE;
  if (language === "python") return PY_TEMPLATE;
  return CURL_TEMPLATE;
}

/**
 * Build the language-idiomatic key-binding line. When `runtimeKey` is set
 * we inline it with a "// rotate before committing" hint so the operator
 * knows the snippet is paste-ready but secret-ful. When unset we fall back
 * to the env-var pattern so the snippet is safe to share.
 */
function buildKeyBlock(
  language: SnippetLanguage,
  runtimeKey: string | undefined,
): string {
  const literal = runtimeKey && runtimeKey.length > 0 ? runtimeKey : null;
  if (language === "typescript") {
    return literal
      ? `const MURMUR_RUNTIME_KEY = "${literal}"; // shown once — store in env before committing`
      : `const MURMUR_RUNTIME_KEY = process.env.MURMUR_RUNTIME_KEY ?? "";`;
  }
  if (language === "python") {
    return literal
      ? `MURMUR_RUNTIME_KEY = "${literal}"  # shown once — store in env before committing`
      : `MURMUR_RUNTIME_KEY = os.environ["MURMUR_RUNTIME_KEY"]`;
  }
  // curl
  return literal
    ? `# Shown once — export now then remove this line before sharing.\nexport MURMUR_RUNTIME_KEY='${literal}'\n`
    : `# Set MURMUR_RUNTIME_KEY in your shell first.`;
}

export function CodeSnippetPanel({
  runtimeKey,
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
  const body = useMemo(() => {
    const tpl = pickTemplate(active);
    const keyBlock = buildKeyBlock(active, runtimeKey);
    return renderSnippet(tpl, base, keyBlock);
  }, [active, base, runtimeKey]);

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
