import type { ReactNode } from "react";

interface PanelProps {
  /** Panel name (lowercase chrome label). */
  title: string;
  /** Right-aligned annotation (count, status, timestamp). */
  meta?: ReactNode;
  /** Optional buttons / filter affordances on the header right side. */
  actions?: ReactNode;
  /** Body element — caller supplies all padding/grid; panel just frames it. */
  children: ReactNode;
  className?: string;
}

/**
 * Cockpit panel — hairline frame + 22px header strip. No card chrome,
 * no rounding. Reach for this whenever you want a labeled region of
 * the screen (leaderboard panel, live feed panel, market matrix panel).
 */
export function Panel({ title, meta, actions, children, className }: PanelProps) {
  return (
    <section className={"ck-frame flex flex-col min-h-0 " + (className ?? "")}>
      <div className="ck-header">
        <span className="ck-label ck-pos">{title}</span>
        <span className="flex items-center gap-2">
          {actions}
          {meta && <span className="ck-mono ck-dim">{meta}</span>}
        </span>
      </div>
      <div className="flex-1 min-h-0 overflow-auto ck-scroll">{children}</div>
    </section>
  );
}
