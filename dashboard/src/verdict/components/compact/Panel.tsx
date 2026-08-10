import type { ReactElement, ReactNode } from "react";

interface PanelProps {
  /**
   * Panel name (lowercase chrome label). A plain string keeps the generic
   * ::before square marker; pass an element beginning with an `<Ik/>` glyph
   * (icon-adoption pattern P2) to give the panel a semantic marker instead.
   *
   * Narrower than ReactNode on purpose: the marker branch below decides on
   * `typeof title === "string"`, so every non-string title MUST supply its own
   * glyph. ReactNode would also admit numbers, `null` and arrays — values that
   * fall into the glyph branch and render a title with no marker at all.
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

/**
 * Cockpit panel — hairline frame + 22px header strip. No card chrome,
 * no rounding. Reach for this whenever you want a labeled region of
 * the screen (leaderboard panel, live feed panel, market matrix panel).
 */
export function Panel({ title, meta, actions, children, className }: PanelProps) {
  // One marker per title, never two: a node title supplies its own glyph, so
  // ck-title-ik suppresses the ::before square. String titles are untouched.
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
