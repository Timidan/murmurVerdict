import type { ReactNode } from "react";

/**
 * Root wrapper for any CALM page. Sets `data-variant="calm"` so the
 * CSS in `styles/calm.css` activates for this subtree only — the
 * default Nothing pages remain untouched.
 *
 * Layout: a single column with paper canvas + max reading width
 * (1080px). Children own their internal vertical rhythm via
 * `.calm-section`.
 */
export function CalmShell({ children }: { children: ReactNode }) {
  return (
    <div data-variant="calm" className="min-h-dvh">
      {children}
    </div>
  );
}
