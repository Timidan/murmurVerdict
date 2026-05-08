import type { ReactNode } from "react";
import "../../styles/bold.css";

/**
 * BOLD-variant page wrapper. Loads bold.css and applies the .bold-variant
 * scoping class so all sub-component styles are namespaced. Pure black
 * canvas (Nothing's intentional override) — kept identical to default.
 *
 * The wrapper is the single CSS-import gate: if no .bold.tsx page mounts,
 * bold.css never loads.
 */
export function BoldShell({ children }: { children: ReactNode }) {
  return (
    <div className="bold-variant min-h-dvh bg-[var(--color-bg)] text-[var(--color-primary)] flex flex-col">
      {children}
    </div>
  );
}
