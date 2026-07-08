// ─── ApiKeyMintModal — one-time plaintext key reveal (Phase 7b) ─────────────
//
// Renders once on a successful POST /v1/account/agents/:slug/api-keys. The
// plaintext `secret` is the ONE place the API ever returns the raw key, so
// the UX deliberately friction-loads dismissal:
//
//   · heavy danger banner ("⚠ THIS KEY WILL NOT BE SHOWN AGAIN. COPY IT NOW.")
//   · monospace box with text-select: all so triple-click + Cmd-C works
//   · TWO copy buttons — raw key + `.env` line
//   · "I have saved this key" checkbox guards the DONE button
//   · click-outside + Escape are explicitly NOT honored (footgun prevention)
//
// On DONE: caller decides where to navigate. The modal itself stays
// storage-agnostic — onDone is still just a void callback. Today the
// only caller is ApiKeysPanel under the `/keys` settings tab; callers
// that want the `/integrate` snippet panel to show the freshly-minted
// key can stash it in sessionStorage under
// `murmur_just_minted:<slug>` (5-min TTL) before hash-navigating.

import { useCallback, useEffect, useRef, useState } from "react";
import type { MintApiKeyResponse } from "../../api.js";

export interface ApiKeyMintModalProps {
  /** The mint response. `secret` is the plaintext key (one-time). */
  result: MintApiKeyResponse;
  /** Display slug of the agent the key belongs to — used in the .env line. */
  slug: string;
  /**
   * Fires when the user ticks the "saved" checkbox and clicks DONE. The
   * parent decides what to do next (refresh agents list + navigate).
   */
  onDone: () => void;
}

export function ApiKeyMintModal({ result, slug, onDone }: ApiKeyMintModalProps) {
  const [saved, setSaved] = useState(false);
  const [copiedAt, setCopiedAt] = useState<"raw" | "env" | null>(null);
  // Codex P2 fix — when navigator.clipboard is unavailable (insecure
  // origins, certain webviews) writeText() silently failed but the UI
  // still claimed success. The key is one-time, so a false "copied"
  // could trick the user into dismissing without saving. When we can't
  // write, surface an explicit manual-copy hint instead.
  const [copyFallback, setCopyFallback] = useState<"raw" | "env" | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Lock body scroll while the modal is open so the user can't accidentally
  // scroll past + lose the key behind a stale rerender.
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

  // Block Escape — by spec, the user MUST tick the checkbox + click DONE.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const copyToClipboard = useCallback(async (text: string, which: "raw" | "env") => {
    // Codex P2 fix — gate "copied" feedback on an actual successful write.
    // Pre-flight check + try/catch around writeText; on either branch fail
    // we flip to copyFallback so the UI shows a manual-copy hint and the
    // saved-checkbox conscience doesn't ride on a no-op success message.
    if (!navigator.clipboard?.writeText) {
      setCopyFallback(which);
      setCopiedAt(null);
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setCopiedAt(which);
      setCopyFallback(null);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopiedAt(null), 3000);
    } catch {
      setCopyFallback(which);
      setCopiedAt(null);
    }
  }, []);

  const envLine = `MURMUR_API_KEY=${result.secret}`;

  return (
    <div
      // Click-outside MUST NOT dismiss — the user has to acknowledge first.
      // We render the backdrop as a non-interactive element + omit any
      // onClick handler. Aria-modal blocks shortcut closure in screenreaders.
      role="dialog"
      aria-modal="true"
      aria-labelledby="mint-modal-title"
      className="fixed inset-0 z-50 grid place-items-center bg-[var(--color-scrim)] px-3"
    >
      <div className="ck-frame-strong w-full max-w-[560px] bg-[var(--color-bg)]">
        <div className="ck-header">
          <span id="mint-modal-title" className="ck-label ck-neg">
            ⚠ api key · one-time reveal
          </span>
          <span className="ck-mono ck-dim">{slug}</span>
        </div>

        <div className="px-4 py-4 flex flex-col gap-3">
          <p
            className="ck-mono ck-neg leading-relaxed"
            style={{ color: "var(--color-accent)" }}
          >
            ⚠ key revealed once — copy it now.
          </p>
          <p className="ck-mono ck-dim text-[10px] leading-relaxed">
            store it in your secrets manager or environment now. murmur stores
            only a hash — there is no recovery path. if you lose it, rotate
            via your account page and mint a fresh one.
          </p>

          <div
            className="ck-frame px-3 py-3 ck-mono break-all"
            style={{ userSelect: "all", WebkitUserSelect: "all" }}
          >
            {result.secret}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => void copyToClipboard(result.secret, "raw")}
              className="ck-btn ck-btn-accent justify-center"
              aria-label="copy key"
            >
              [ copy key ]
            </button>
            <button
              type="button"
              onClick={() => void copyToClipboard(envLine, "env")}
              className="ck-btn justify-center"
              aria-label="copy as .env line"
            >
              [ copy as .env line ]
            </button>
          </div>

          {copiedAt && (
            <p className="ck-mono ck-pos text-[10px]" aria-live="polite">
              copied {copiedAt === "env" ? ".env line" : "key"} · 3s
            </p>
          )}

          {copyFallback && (
            <p
              className="ck-mono text-[10px]"
              style={{ color: "var(--color-accent)" }}
              aria-live="polite"
            >
              × clipboard blocked — triple-click the key above and Cmd-C / Ctrl-C.
            </p>
          )}

          <label className="flex items-start gap-2 pt-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={saved}
              onChange={(e) => setSaved(e.currentTarget.checked)}
              className="mt-[3px]"
            />
            <span className="ck-mono ck-dim leading-relaxed">
              i have saved this key somewhere safe.
              <br />
              <span className="text-[10px]">
                checking this box enables the done button. unchecking it again
                does not retroactively undo the mint — the key is already
                active.
              </span>
            </span>
          </label>

          <div className="flex justify-end pt-1">
            <button
              type="button"
              onClick={onDone}
              disabled={!saved}
              className="ck-btn ck-pos justify-center disabled:opacity-40 disabled:cursor-not-allowed"
              aria-label="done"
            >
              [ done → ]
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
