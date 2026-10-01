import type { ReactElement, ReactNode } from "react";

interface PanelProps {
  /**
   * An element must start with its own `<Ik/>` glyph. Not ReactNode, since any
   * non-string takes the glyph branch.
   */
  title: string | ReactElement;
  /** Right-aligned annotation (count, status, timestamp). */
  meta?: ReactNode;
  /** Optional buttons / filter affordances on the header right side. */
  actions?: ReactNode;
  /** Body element — caller supplies all padding/grid; panel just heads it. */
  children: ReactNode;
  className?: string;
}

/** Open section: Doto title over a hairline rule, body grows with its content. */
export function Panel({ title, meta, actions, children, className }: PanelProps) {
  // A node title brings its own glyph; ck-title-ik spaces it off the words.
  const titleCls = typeof title === "string" ? "ck-title" : "ck-title ck-title-ik";
  return (
    <section className={"ck-section " + (className ?? "")}>
      <div className="ck-section-head">
        <h2 className={titleCls}>{title}</h2>
        <span className="flex items-center gap-2">
          {actions}
          {meta && <span className="ck-mono ck-dim">{meta}</span>}
        </span>
      </div>
      <div>{children}</div>
    </section>
  );
}
