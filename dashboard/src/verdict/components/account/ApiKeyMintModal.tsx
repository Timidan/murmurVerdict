// ─── ApiKeyMintModal — one-time plaintext key reveal ────────────────────────
// The mint response is the only time the API returns the raw key, so dismissal
// requires the "saved" checkbox; click-outside and Escape are ignored.

import { useCallback, useEffect, useRef, useState } from "react";
import type { MintApiKeyResponse } from "../../api.js";
import { Ik } from "../../icons.js";
import { useFocusTrap } from "../compact/useFocusTrap.js";

export interface ApiKeyMintModalProps {
  /** The mint response. `secret` is the plaintext key (one-time). */
  result: MintApiKeyResponse;
  slug: string;
  /** Fires on DONE, after the "saved" checkbox is ticked. */
  onDone: () => void;
}

export function ApiKeyMintModal({ result, slug, onDone }: ApiKeyMintModalProps) {
  const [saved, setSaved] = useState(false);
  const [copiedAt, setCopiedAt] = useState<"raw" | "env" | null>(null);
  // Set when the clipboard write fails; a false "copied" on a one-time key
  // could get it dismissed unsaved, so show a manual-copy hint instead.
  const [copyFallback, setCopyFallback] = useState<"raw" | "env" | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const firstCopyRef = useRef<HTMLButtonElement | null>(null);

  // Lock body scroll while open.
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

  // Block Escape; the user must tick the checkbox and click DONE.
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

  // Focus the first copy button on mount; restore previous focus on unmount.
  useEffect(() => {
    const prevFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    (firstCopyRef.current ?? panelRef.current)?.focus();
    return () => {
      prevFocus?.focus();
    };
  }, []);

  useFocusTrap(panelRef);

  const copyToClipboard = useCallback(async (text: string, which: "raw" | "env") => {
    // Only show "copied" after a successful write.
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
      // No onClick: click-outside must not dismiss.
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
          <span id="mint-modal-title" className="ck-title ck-neg ck-title-ik">
            <Ik name="api" /> ⚠ Your new API key
            {/* One-shot seal stamp on mount. */}
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
            Put it in your secrets manager or your environment now. If you lose
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
