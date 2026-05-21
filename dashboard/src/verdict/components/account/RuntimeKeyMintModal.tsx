// ─── RuntimeKeyMintModal — one-time plaintext runtime-key reveal ──────────
//
// Sibling of ApiKeyMintModal. Renders once on a successful POST
// /v1/account/agents/:slug/runtime-keys. The `secret` returned is the ONE
// place the API ever surfaces the raw runtime key.
//
// Same friction-load posture as the API-key modal: danger banner, two copy
// affordances (raw + .env), checkbox-guarded DONE, no click-outside dismiss.

import { useCallback, useEffect, useRef, useState } from "react";
import type { RuntimeKeyMintResponse } from "../../api.js";

export interface RuntimeKeyMintModalProps {
  /** Mint response — `secret` is the plaintext (one-time) runtime key. */
  result: RuntimeKeyMintResponse;
  /** Agent slug — used in the .env line copy. */
  slug: string;
  /** Fires when the user ticks "saved" and clicks DONE. */
  onDone: () => void;
}

export function RuntimeKeyMintModal({ result, slug, onDone }: RuntimeKeyMintModalProps) {
  const [saved, setSaved] = useState(false);
  const [copiedAt, setCopiedAt] = useState<"raw" | "env" | null>(null);
  const [copyFallback, setCopyFallback] = useState<"raw" | "env" | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, []);

  const copy = useCallback(
    async (kind: "raw" | "env", text: string) => {
      try {
        if (!navigator.clipboard?.writeText) throw new Error("no-clipboard");
        await navigator.clipboard.writeText(text);
        setCopiedAt(kind);
        setCopyFallback(null);
      } catch {
        setCopyFallback(kind);
        setCopiedAt(null);
      }
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => {
        setCopiedAt(null);
      }, 1800);
    },
    [],
  );

  const envLine = `MURMUR_RUNTIME_KEY=${result.secret}  # ${slug}`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="runtime-key-mint-title"
    >
      <section className="ck-frame-strong w-full max-w-[640px] bg-[var(--color-bg)] p-4 flex flex-col gap-3">
        <header className="flex items-baseline justify-between">
          <h3 id="runtime-key-mint-title" className="ck-label">
            new runtime key
          </h3>
          <span className="ck-mono text-[10px] ck-dim">prefix · {result.runtime_key_prefix}</span>
        </header>

        <p
          className="ck-mono text-[11px] leading-snug"
          style={{ color: "var(--color-accent)" }}
        >
          ⚠ this key will NOT be shown again. copy it now and store it where
          your agent can read it. anyone with this string can submit calls
          on behalf of {slug}.
        </p>

        {/* RAW SECRET ──────────────────────────────────────────── */}
        <div className="ck-frame px-3 py-2 flex flex-col gap-1">
          <span className="ck-label">runtime_key_secret</span>
          <code
            className="ck-mono text-[12px] break-all select-all"
            style={{ userSelect: "all" }}
          >
            {result.secret}
          </code>
          <div className="flex items-center gap-2 mt-1">
            <button
              className="ck-btn"
              onClick={() => void copy("raw", result.secret)}
              type="button"
            >
              {copiedAt === "raw" ? "copied ✓" : "[ copy ]"}
            </button>
            {copyFallback === "raw" && (
              <span className="ck-mono text-[10px] ck-dim">
                clipboard blocked — select + ⌘C / Ctrl-C
              </span>
            )}
          </div>
        </div>

        {/* ENV LINE ───────────────────────────────────────────── */}
        <div className="ck-frame px-3 py-2 flex flex-col gap-1">
          <span className="ck-label">.env</span>
          <code className="ck-mono text-[11px] break-all select-all">{envLine}</code>
          <div className="flex items-center gap-2 mt-1">
            <button
              className="ck-btn"
              onClick={() => void copy("env", envLine)}
              type="button"
            >
              {copiedAt === "env" ? "copied ✓" : "[ copy .env line ]"}
            </button>
            {copyFallback === "env" && (
              <span className="ck-mono text-[10px] ck-dim">
                clipboard blocked — select + ⌘C / Ctrl-C
              </span>
            )}
          </div>
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

        <button
          className="ck-btn-primary self-end"
          onClick={onDone}
          disabled={!saved}
          type="button"
        >
          {saved ? "[ done ]" : "[ done ] · save the key first"}
        </button>
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
