// ─── useSlashFocus — the one "/" focus shortcut for search fields ──────────
//
// Extracted verbatim from the market grid's local listener (the only global
// key shortcut the dashboard had), so every search field can adopt the same
// terminal idiom instead of growing its own copy.
//
// The guards are the whole point: "/" is a printable character, so the listener
// must stand down whenever a field already owns the keystroke — otherwise
// typing a slash into ANY input on the page would yank focus to this one — and
// equally while a dialog owns the keyboard, or "/" would pull focus straight
// out of a modal's focus trap into a search field on the page behind it.
//
// Both conditions are the SAME questions <GlobalShortcuts/> asks, so both
// predicates live in lib/keyboard-target.ts and are shared rather than
// re-spelled here (the extracted original inlined the field check). That is
// also what keeps the two window listeners from fighting: they stand down
// together, and otherwise never both act on one keydown, because "/" is not a
// chord key and `g` is not this hook's key.

import { useEffect, type RefObject } from "react";
import { isInDialog, isTypingTarget } from "../lib/keyboard-target.js";

/**
 * Focus `ref`'s input when "/" is pressed outside a text field.
 *
 * Ignored while another field owns the keystroke (input/textarea/select or
 * contenteditable), while an open dialog owns the keyboard, and while any
 * modifier is held — so no browser shortcut and no typed slash is ever
 * hijacked. `preventDefault` stops the "/" from landing in the field it just
 * focused (and from opening Firefox's quick-find).
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
