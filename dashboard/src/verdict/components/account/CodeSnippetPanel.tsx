// ─── CodeSnippetPanel — tabbed multi-language snippet renderer ─────────────
// Snippet text lives in ./gateway-snippets.ts; see its header for the auth and
// sealing contract.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { HighlightedCode } from "../CodeWindow.js";
import {
  renderGatewaySnippet,
  type SnippetLanguage,
} from "./gateway-snippets.js";

export type { SnippetLanguage };

export interface CodeSnippetPanelProps {
  /** Not read by the panel. */
  agentSlug?: string;
  /** Plaintext key to inline (post-mint only); omitted uses env-var placeholders. */
  runtimeKey?: string;
  /** Subset of languages to render. Defaults to all three. */
  languages?: SnippetLanguage[];
  initialLanguage?: SnippetLanguage;
  /** False hides the tab + copy strip; the body still renders. */
  showHeader?: boolean;
  /** Pass "" to skip the frame. */
  containerClass?: string;
}

const ALL_LANGUAGES: SnippetLanguage[] = ["typescript", "python", "curl"];

const TAB_LABEL: Record<SnippetLanguage, string> = {
  typescript: "TypeScript",
  python: "Python",
  curl: "curl",
};

/** Configured API base URL, else the page origin (dev proxies /v1). */
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

  // Clamp the initial tab to the available subset.
  const [active, setActive] = useState<SnippetLanguage>(() =>
    langs.includes(initialLanguage) ? initialLanguage : langs[0]!,
  );

  // "copied" only after writeText resolves; otherwise a manual-copy hint.
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

  // Reset copy feedback on tab switch.
  useEffect(() => {
    setCopied(false);
    setCopyFallback(false);
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
  }, [active]);

  const containerProps = containerClass ? { className: containerClass } : {};

  return (
    <section {...containerProps}>
      {showHeader && (
        <div className="ck-header flex-wrap gap-y-1">
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
