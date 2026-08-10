// ─── useFocusTrap — the one Tab-trap for dialog surfaces ───────────────────
//
// Extracted from four copies that were identical apart from their focusable
// selector (ApiKeyMintModal, RuntimeKeyMintModal, MobileNav, DetailDrawer).
// ONLY the wrap-around Tab behaviour is shared. Mount focus, focus return,
// scroll lock and — above all — each dialog's Escape policy stay LOCAL to the
// component, because they legitimately differ: the two key-reveal modals BLOCK
// Escape (dismissing loses a one-time credential), while the drawer and the
// mobile nav close on it.
//
// The selector is the union of what the four sites used — the two mint modals
// carried `input:not([disabled])`, the drawer and the nav did not — widened to
// the remaining natively-tabbable kinds. Widening only ever ADDS elements to
// the cycle, which is the safe direction: a tabbable element missing from the
// list is not merely untrapped, it is unreachable, because anything sitting
// after the computed `last` gets jumped over by the wrap.
//
// No visibility filtering, matching all four original sites: these dialogs
// unmount their inactive content rather than hiding it.

import { useEffect, type RefObject } from "react";

/** Natively-tabbable kinds, minus explicit `tabindex="-1"` opt-outs (which is
 *  how the mint modals mark their own panel as a focus fallback only). */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Keep Tab / Shift+Tab cycling inside `ref`'s subtree while `active`.
 *
 * `active` is not just an on/off switch: the listener is bound to whatever
 * `ref.current` holds when the effect runs, so a dialog that mounts its panel
 * conditionally MUST pass its open flag here. Passing `true` unconditionally
 * would bind once, against a null node, and trap nothing.
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
