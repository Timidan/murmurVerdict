import type { ReactElement, ReactNode } from "react";

interface PanelProps {
  /**
   * A string keeps the ::before square; an element must start with its own
   * `<Ik/>` glyph. Not ReactNode, since any non-string takes the glyph branch.
   */
  title: string | ReactElement;
  /** Right-aligned annotation (count, status, timestamp). */
  meta?: ReactNode;
  /** Optional buttons / filter affordances on the header right side. */
  actions?: ReactNode;
  /** Body element — caller supplies all padding/grid; panel just frames it. */
  children: ReactNode;
  className?: string;
}

/** Cockpit panel: hairline frame + header strip. */
export function Panel({ title, meta, actions, children, className }: PanelProps) {
  // A node title brings its own glyph; ck-title-ik drops the ::before square.
  const titleCls = typeof title === "string" ? "ck-title" : "ck-title ck-title-ik";
  return (
    <section className={"ck-frame flex flex-col min-h-0 " + (className ?? "")}>
      <div className="ck-header">
        <h2 className={titleCls}>{title}</h2>
        <span className="flex items-center gap-2">
          {actions}
          {meta && <span className="ck-mono ck-dim">{meta}</span>}
        </span>
      </div>
      <div className="flex-1 min-h-0 overflow-auto ck-scroll">{children}</div>
    </section>
  );
}
