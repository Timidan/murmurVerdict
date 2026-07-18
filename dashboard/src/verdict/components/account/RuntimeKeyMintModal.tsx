// ─── RuntimeKeyMintModal — one-time plaintext runtime-key reveal ──────────
//
// Sibling of ApiKeyMintModal. Renders once on a successful POST
// /v1/account/agents/:slug/runtime-keys. The `secret` returned is the ONE
// place the API ever surfaces the raw runtime key.
//
// Same friction-load posture as the API-key modal: danger banner, checkbox-
// guarded DONE, no click-outside dismiss. The reveal is a TABBED ONE-BOX:
// [ AGENT PROMPT ] [ KEY ] [ .ENV ] over a single scrolling content box with
// one [ copy ] button — the same bracketed tab-strip idiom as CodeSnippetPanel.
// AGENT PROMPT is the personalized operate-only runbook with the key baked in,
// so the operator can paste ONE thing and their agent knows how to run.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RuntimeKeyMintResponse } from "../../api.js";
import { stashJustMinted } from "../../pages/IntegratePage.js";
import { fetchAgentPromptTemplate, injectRuntimeKey } from "../../lib/agent-prompt.js";

export interface RuntimeKeyMintModalProps {
  /** Mint response — `secret` is the plaintext (one-time) runtime key. */
  result: RuntimeKeyMintResponse;
  /** Agent slug — used in the .env line + prompt fetch. */
  slug: string;
  /** Fires when the user ticks "saved" and clicks DONE. */
  onDone: () => void;
}

type MintTab = "prompt" | "key" | "env";

const TAB_LABEL: Record<MintTab, string> = {
  prompt: "AGENT PROMPT",
  key: "KEY",
  env: ".ENV",
};

const TAB_ORDER: MintTab[] = ["prompt", "key", "env"];

export function RuntimeKeyMintModal({ result, slug, onDone }: RuntimeKeyMintModalProps) {
  const [saved, setSaved] = useState(false);
  const [active, setActive] = useState<MintTab>("prompt");
  const [copied, setCopied] = useState(false);
  const [copyFallback, setCopyFallback] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const firstCopyRef = useRef<HTMLButtonElement | null>(null);

  // Personalized runbook — fetched once on mount and cached with the key
  // baked in. `promptText === null` while the fetch is in flight; on error we
  // still populate a minimal note that carries the raw key line so the modal
  // is never useless.
  const [promptText, setPromptText] = useState<string | null>(null);
  const [promptLoading, setPromptLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setPromptLoading(true);
    fetchAgentPromptTemplate(slug)
      .then((tpl) => {
        if (cancelled) return;
        setPromptText(injectRuntimeKey(tpl, result.secret));
        setPromptLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        // Fallback — never leave the operator without the key even if the
        // runbook route is unreachable. Still includes the raw key line.
        setPromptText(
          `# operate ${slug}\n\n` +
            `(the personalized runbook could not be loaded — the key is still\n` +
            `yours below; wire it into the environment your agent runs in)\n\n` +
            `MURMUR_RUNTIME_KEY=${result.secret}\n`,
        );
        setPromptLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [slug, result.secret]);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Focus lifecycle — same pattern as compact/MobileNav: move focus into
  // the dialog on mount (first copy button, panel as fallback) and return
  // it to the previously-focused element on unmount. Escape / click-outside
  // dismissal stays deliberately blocked — the one-time secret must be
  // acknowledged via the checkbox + done.
  useEffect(() => {
    const prevFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    (firstCopyRef.current ?? panelRef.current)?.focus();
    return () => {
      prevFocus?.focus();
    };
  }, []);

  // Lightweight focus trap — keep Tab / Shift+Tab within the dialog
  // (ported from compact/MobileNav).
  const onPanelKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Tab" || !panelRef.current) return;
    const focusables = panelRef.current.querySelectorAll<HTMLElement>(
      "a[href], button:not([disabled]), input:not([disabled])",
    );
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  // Stash the just-minted secret for the integrate page handoff. The
  // envelope auto-expires after 5 min and is single-use (consumeJustMinted
  // clears it on read), so this is safe even if the operator never
  // navigates — sessionStorage drops on tab close.
  useEffect(() => {
    stashJustMinted(slug, {
      secret: result.secret,
      source: "runtime",
      runtime_key_id: result.runtime_key_id,
      runtime_key_prefix: result.runtime_key_prefix,
    });
  }, [slug, result.secret, result.runtime_key_id, result.runtime_key_prefix]);

  const onOpenIntegrate = useCallback(() => {
    // Navigate to the integrate page where the snippet panel will pick
    // up the stashed secret. We deliberately DO NOT call onDone — some
    // parents (AgentOnboardPage) chain a "#/account" navigation inside
    // onDone, which would race with this hash assignment. The hash
    // change here naturally unmounts the current route (and the modal
    // with it), so the cleanup onDone normally does isn't needed.
    window.location.hash = `#/account/agent/${encodeURIComponent(slug)}/integrate`;
  }, [slug]);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, []);

  const envLine = `MURMUR_RUNTIME_KEY=${result.secret}  # ${slug}`;

  // The text the single [ copy ] button acts on — always the active tab's
  // content. Empty only while the prompt is still resolving.
  const activeText = useMemo(() => {
    if (active === "key") return result.secret;
    if (active === "env") return envLine;
    return promptText ?? "";
  }, [active, result.secret, envLine, promptText]);

  const doCopy = useCallback(async () => {
    if (!activeText) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("no-clipboard");
      await navigator.clipboard.writeText(activeText);
      setCopied(true);
      setCopyFallback(false);
    } catch {
      setCopyFallback(true);
      setCopied(false);
    }
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => setCopied(false), 1800);
  }, [activeText]);

  // Reset the copy-feedback state when switching tabs so a stale "copied ✓"
  // badge from the previous tab doesn't lie about the new one.
  useEffect(() => {
    setCopied(false);
    setCopyFallback(false);
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
  }, [active]);

  return (
    <div
      className="modal-enter fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="runtime-key-mint-title"
    >
      <section
        ref={panelRef}
        tabIndex={-1}
        onKeyDown={onPanelKeyDown}
        className="modal-enter-panel ck-frame-strong w-full max-w-[640px] bg-[var(--color-bg)] p-4 flex flex-col gap-3"
      >
        <header className="flex items-baseline justify-between">
          <h3 id="runtime-key-mint-title" className="ck-label">
            new runtime key
          </h3>
          <span className="ck-mono text-[10px] ck-dim">prefix · {result.runtime_key_prefix}</span>
        </header>

        <p
          className="ck-mono text-[11px] leading-snug"
          style={{ color: "var(--color-accent-ink)" }}
        >
          ⚠ shown once — copy the agent prompt (the key is baked in) and store it
          where your agent runs. this key will NOT be shown again; anyone with it
          can submit calls on behalf of {slug}.
        </p>

        {/* TABBED ONE-BOX ─────────────────────────────────────── */}
        <div className="ck-frame flex flex-col">
          <div className="ck-header">
            <span className="flex items-center gap-1">
              {TAB_ORDER.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setActive(t)}
                  className={
                    "ck-btn ck-btn-bracket " + (active === t ? "ck-btn-active" : "")
                  }
                  aria-pressed={active === t}
                >
                  {TAB_LABEL[t]}
                </button>
              ))}
            </span>
            <span className="flex items-center gap-2">
              {copyFallback && (
                <span className="ck-mono text-[10px] ck-dim" aria-live="polite">
                  clipboard blocked — select + ⌘C / Ctrl-C
                </span>
              )}
              <button
                ref={firstCopyRef}
                type="button"
                onClick={() => void doCopy()}
                className="ck-btn ck-btn-bracket"
                disabled={active === "prompt" && promptLoading}
                aria-label={`copy ${TAB_LABEL[active]}`}
              >
                {copied ? "copied ✓" : "copy"}
              </button>
            </span>
          </div>

          {active === "prompt" ? (
            promptLoading ? (
              <p className="ck-mono ck-dim text-[11px] px-3 py-2">resolving prompt…</p>
            ) : (
              <pre
                className="ck-mono whitespace-pre overflow-auto px-3 py-2 leading-tight text-[11px]"
                style={{ maxHeight: 240 }}
              >
                {promptText}
              </pre>
            )
          ) : active === "key" ? (
            <pre
              className="ck-mono whitespace-pre-wrap break-all select-all overflow-auto px-3 py-2 leading-tight text-[12px]"
              style={{ maxHeight: 240, userSelect: "all" }}
            >
              {result.secret}
            </pre>
          ) : (
            <pre
              className="ck-mono whitespace-pre-wrap break-all select-all overflow-auto px-3 py-2 leading-tight text-[11px]"
              style={{ maxHeight: 240, userSelect: "all" }}
            >
              {envLine}
            </pre>
          )}
        </div>

        {/* META ───────────────────────────────────────────────── */}
        <div className="grid grid-cols-2 gap-2 ck-mono text-[11px]">
          <KV k="created" v={result.created_at.slice(0, 19).replace("T", " ")} />
          <KV
            k="expires"
            v={result.expires_at ? result.expires_at.slice(0, 19).replace("T", " ") : "never"}
            tone={result.expires_at ? "pos" : "dim"}
          />
          <KV k="policy hash" v={result.policy_hash.slice(0, 16) + "…"} title={result.policy_hash} />
          {result.warning && <KV k="note" v={result.warning} tone="neg" />}
        </div>

        {/* CONFIRM + DONE ─────────────────────────────────────── */}
        <label className="ck-mono text-[11px] flex items-center gap-2 mt-2">
          <input
            type="checkbox"
            checked={saved}
            onChange={(e) => setSaved(e.target.checked)}
            aria-label="I have saved this runtime key"
          />
          I have saved this key somewhere safe.
        </label>

        <div className="flex flex-wrap items-center justify-end gap-2">
          <button
            className="ck-btn ck-btn-bracket"
            onClick={onOpenIntegrate}
            disabled={!saved}
            type="button"
            title={
              saved
                ? "open the integrate guide for this agent (skill.md + sample code + next steps)"
                : "save the key, then open the integrate guide"
            }
          >
            open integrate guide →
          </button>
          <button
            className="ck-btn ck-btn-bracket ck-pos"
            onClick={onDone}
            disabled={!saved}
            type="button"
          >
            {saved ? "done" : "done · save the key first"}
          </button>
        </div>
      </section>
    </div>
  );
}

function KV({ k, v, tone, title }: { k: string; v: string; tone?: "dim" | "neg" | "pos"; title?: string }) {
  const toneClass = tone === "neg" ? "ck-neg" : tone === "dim" ? "ck-dim" : "ck-pos";
  return (
    <div className="grid grid-cols-[100px_1fr] gap-2">
      <span className="ck-label">{k}</span>
      <span className={`${toneClass} truncate`} title={title}>{v}</span>
    </div>
  );
}
