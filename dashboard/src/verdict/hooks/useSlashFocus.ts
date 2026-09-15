// ─── useSlashFocus — the one "/" focus shortcut for search fields ──────────
// Shares its guards with <GlobalShortcuts/> via lib/keyboard-target.ts.

import { useEffect, type RefObject } from "react";
import { isInDialog, isTypingTarget } from "../lib/keyboard-target.js";

/**
 * Focus `ref`'s input when "/" is pressed, unless a field or open dialog owns
 * the keystroke or a modifier is held. `preventDefault` keeps the "/" out of the
 * field (and stops Firefox quick-find).
 */
export function useSlashFocus(ref: RefObject<HTMLInputElement | null>) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target) || isInDialog(e.target)) return;
      e.preventDefault();
      ref.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ref]);
}
