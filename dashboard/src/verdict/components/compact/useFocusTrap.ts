// ─── useFocusTrap — the one Tab-trap for dialog surfaces ───────────────────
// Only the Tab wrap-around is shared; mount focus, focus return, scroll lock and
// Escape policy stay in each dialog. No visibility filtering: these dialogs
// unmount inactive content rather than hiding it.

import { useEffect, type RefObject } from "react";

/** Natively-tabbable kinds, minus explicit `tabindex="-1"` opt-outs (which is
 *  how the mint modals mark their own panel as a focus fallback only). */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Keep Tab / Shift+Tab cycling inside `ref` while `active`. The listener binds
 * to `ref.current` when the effect runs, so a conditionally mounted panel must
 * pass its open flag.
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active = true) {
  useEffect(() => {
    if (!active) return;
    const node = ref.current;
    if (!node) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const focusables = node.querySelectorAll<HTMLElement>(FOCUSABLE);
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
    node.addEventListener("keydown", onKeyDown);
    return () => node.removeEventListener("keydown", onKeyDown);
  }, [ref, active]);
}
