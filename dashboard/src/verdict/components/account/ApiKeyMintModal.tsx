// ─── ApiKeyMintModal — one-time plaintext key reveal ────────────────────────
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
import { Ik } from "../../icons.js";
import { useFocusTrap } from "../compact/useFocusTrap.js";

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
  // When navigator.clipboard is unavailable (insecure
  // origins, certain webviews) writeText() silently failed but the UI
  // still claimed success. The key is one-time, so a false "copied"
  // could trick the user into dismissing without saving. When we can't
  // write, surface an explicit manual-copy hint instead.
  const [copyFallback, setCopyFallback] = useState<"raw" | "env" | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const firstCopyRef = useRef<HTMLButtonElement | null>(null);

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

  // Focus lifecycle — same pattern as compact/MobileNav: move focus into
  // the dialog on mount (first copy button, panel as fallback) and return
  // it to the previously-focused element on unmount. Escape stays blocked
  // (effect above) — only the focus handling is added here.
  useEffect(() => {
    const prevFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    (firstCopyRef.current ?? panelRef.current)?.focus();
    return () => {
      prevFocus?.focus();
    };
  }, []);

  // Keep Tab / Shift+Tab within the dialog. The panel is mounted for this
  // component's whole life, so the trap is unconditionally active.
  useFocusTrap(panelRef);

  const copyToClipboard = useCallback(async (text: string, which: "raw" | "env") => {
    // Gate "copied" feedback on an actual successful write.
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
      className="modal-enter fixed inset-0 z-50 grid place-items-center bg-[var(--color-scrim)] p-3"
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        // Bounded by the viewport and scrolled internally: Escape and body
        // scroll are both blocked, so an unbounded panel hides its own [done].
        className="modal-enter-panel ck-frame-strong w-full max-w-[560px] max-h-full overflow-y-auto bg-[var(--color-bg)]"
      >
        <div className="ck-header">
          {/* Title-marker upgrade (P2): the api glyph replaces the generic
              ::before square. The ⚠ that follows is the error-prefix text
              idiom, not a second marker; both sit in the title's ck-neg ink. */}
          <span id="mint-modal-title" className="ck-title ck-neg ck-title-ik">
            <Ik name="api" /> ⚠ your new api key
            {/* Seal stamp — the credential is sealed the instant this modal
                mounts, so the glyph plays its one-shot close here and then
                holds. Trailing, so the leading api marker keeps its slot; the
                seal inherits the title's ck-neg ink like the ⚠ does. */}
            <span className="mmr-seal-stamp" aria-hidden="true">
              <Ik name="seal" size={16} />
            </span>
          </span>
          <span className="ck-mono ck-dim">{slug}</span>
        </div>

        <div className="px-4 py-4 flex flex-col gap-3">
          <p
            className="ck-mono ck-neg leading-relaxed"
            style={{ color: "var(--color-accent-ink)" }}
          >
            ⚠ Shown once. Copy it now.
          </p>
          <p className="ck-dim text-[12px] leading-relaxed">
            Put it in your secrets manager or your environment now. Murmur
            stores only a hash, so there is no way to get it back. If you lose
            it, rotate the key on your account page and mint a new one.
          </p>

          <div
            className="ck-frame px-3 py-3 ck-mono break-all"
            style={{ userSelect: "all", WebkitUserSelect: "all" }}
          >
            {result.secret}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <button
              ref={firstCopyRef}
              type="button"
              onClick={() => void copyToClipboard(result.secret, "raw")}
              className="ck-btn ck-btn-bracket ck-btn-accent justify-center"
              aria-label="copy key"
            >
              copy key
            </button>
            <button
              type="button"
              onClick={() => void copyToClipboard(envLine, "env")}
              className="ck-btn ck-btn-bracket justify-center"
              aria-label="copy as .env line"
            >
              copy as .env line
            </button>
          </div>

          {copiedAt && (
            <p className="confirm-enter ck-pos text-[12px]" aria-live="polite">
              Copied the {copiedAt === "env" ? ".env line" : "key"}.
            </p>
          )}

          {copyFallback && (
            <p
              className="text-[12px]"
              style={{ color: "var(--color-accent-ink)" }}
              aria-live="polite"
            >
              × The clipboard is blocked. Triple-click the key above, then press ⌘C or Ctrl-C.
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
              I have saved this key somewhere safe.
              <br />
              <span className="text-[12px]">
                This box unlocks the done button. Clearing it does not undo the
                mint — the key is already live.
              </span>
            </span>
          </label>

          <div className="flex justify-end pt-1">
            <button
              type="button"
              onClick={onDone}
              disabled={!saved}
              className="ck-btn ck-btn-bracket ck-pos justify-center disabled:opacity-40 disabled:cursor-not-allowed"
              aria-label="done"
            >
              done →
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
