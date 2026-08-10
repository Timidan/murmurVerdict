// ─── keyboard-target — who owns this keystroke? ────────────────────────────
//
// The two global `window` keydown listeners (<GlobalShortcuts/>'s `g` route
// chords and useSlashFocus's "/") must stand down under exactly the same
// conditions, or the app grows two different answers to "is this key mine?".
// Both predicates live here rather than on either listener because a hook must
// not import a component: useSlashFocus sits in hooks/, GlobalShortcuts in
// components/, and lib/ is the one place both can import downward from.
//
// Neither predicate touches React — they are pure DOM questions about an event
// target, which is also why they are trivially reusable by any future global
// shortcut.

/**
 * True while a text field owns the keystroke.
 *
 * Global single-key shortcuts are printable characters, so without this a "/"
 * or a "g" typed into any field on the page would be stolen by a listener the
 * user isn't thinking about.
 */
export function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/**
 * True while the keystroke came from inside an open dialog. An `aria-modal`
 * surface owns the keyboard for as long as it is up, so global shortcuts stand
 * down there completely.
 *
 * The load-bearing case is the credential modals: mount focus lands on their
 * copy BUTTON, which is not a typing target, so without this a stray `g` + a
 * route letter would navigate, unmount the panel behind the modal, and destroy
 * a plaintext key that exists nowhere else (ApiKeyMintModal has no recovery
 * path at all; RuntimeKeyMintModal's sessionStorage handoff makes it merely
 * wrong rather than fatal). The same guard keeps "/" from yanking focus out of
 * a dialog's focus trap into a search field on the page behind it.
 *
 * All four dialog surfaces (both mint modals, the detail drawer, the mobile
 * nav) already carry `role="dialog"`, so this needs no new markup — and any
 * future dialog inherits the guard by using the same role.
 */
export function isInDialog(t: EventTarget | null): boolean {
  return t instanceof HTMLElement && t.closest('[role="dialog"]') !== null;
}
