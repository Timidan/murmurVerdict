// ─── CodeSnippetPanel — tabbed multi-language snippet renderer ─────────────
//
// Three use sites planned (V2 §7 onboarding research):
//   1. `IntegratePage` — reached via the [ integrate ] button on the
//      per-agent settings shell. Shows the canonical Runtime Key Gateway
//      path. Runtime Key plaintext is only shown by the runtime-key mint
//      flow; snippets use env-var placeholders here.
//   2. `LaunchPage` — public install track. The user is NOT
//      authenticated, so the panel always renders the env-var fallback
//      for MURMUR_RUNTIME_KEY.
//   3. `AgentProfilePage` — public profile shows env-var-only
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
// API base URL: read from import.meta.env.VITE_VERDICT_API_URL, falling
// back to the page's own origin (which proxies /v1 in dev and same-host
// deploys). Substituted consistently across all three languages so users
// can paste any one and get a working call.
//
// The pasteable text itself lives in ./gateway-snippets.ts so a smoke can
// assert on it without a DOM. Read that file's header for the auth and
// sealing contract each snippet has to satisfy.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { HighlightedCode } from "../CodeWindow.js";
import {
  renderGatewaySnippet,
  type SnippetLanguage,
} from "./gateway-snippets.js";

export type { SnippetLanguage };

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
   * is the mmr-shell idiom used by the rest of the account flow.
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
 * Read the dashboard's configured daemon base URL, falling back to the
 * page's own origin. The old "https://murmur.verdict" placeholder made
 * copied snippets fail on every unconfigured deploy; the origin fallback
 * matches the API client's relative-URL behavior (dev proxies /v1, and
 * same-host deploys serve it directly), so pasted snippets always target
 * a resolvable host.
 */
function getApiBase(): string {
  const env = (import.meta.env.VITE_VERDICT_API_URL ?? "").toString().trim();
  if (env.length > 0) return env.replace(/\/$/, "");
  return window.location.origin;
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

  // Same as ApiKeyMintModal: only set "copied"
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
  const body = useMemo(
    () => renderGatewaySnippet(active, base, runtimeKey),
    [active, base, runtimeKey],
  );

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
                  "ck-btn ck-btn-bracket " + (active === l ? "ck-btn-active" : "")
                }
                aria-pressed={active === l}
              >
                {TAB_LABEL[l]}
              </button>
            ))}
          </span>
          <span className="flex items-center gap-2">
            {copyFallback && (
              <span
                className="confirm-enter text-[12px]"
                style={{ color: "var(--color-accent-ink)" }}
                aria-live="polite"
              >
                × clipboard blocked — Cmd-C / Ctrl-C
              </span>
            )}
            <button
              type="button"
              onClick={() => void doCopy()}
              className="ck-btn ck-btn-bracket"
              aria-label={`copy ${TAB_LABEL[active]} snippet`}
            >
              {copied ? "copied" : "copy"}
            </button>
          </span>
        </div>
      )}
      <pre
        key={active}
        className="snippet-fade whitespace-pre overflow-x-auto px-3 py-2 leading-tight"
      >
        <HighlightedCode
          code={body}
          lang={active === "curl" ? "bash" : active}
        />
      </pre>
    </section>
  );
}
