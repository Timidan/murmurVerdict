import type { ReactNode } from "react";

/**
 * The page's KPI row: hairline-divided cells (see .ck-stats in compact.css).
 */
export function StatStrip({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <section className={"ck-stats " + (className ?? "")}>{children}</section>;
}

/** One cell: column header, the figure, and an optional note under it. */
export function Stat({
  label,
  value,
  note,
  tone = "default",
  title,
  kind = "num",
}: {
  /** ReactNode so a FormulaTip can stand in for a bare word. */
  label: ReactNode;
  value: ReactNode;
  note?: ReactNode;
  tone?: "pos" | "neg" | "dim" | "default";
  /** Plain-language definition for a label with no FormulaTip of its own. */
  title?: string;
  /** "num" is the Doto display tier; "text" keeps a word in mono. */
  kind?: "num" | "text";
}) {
  const toneClass =
    tone === "pos" ? " ck-pos" : tone === "neg" ? " ck-neg" : tone === "dim" ? " ck-dim" : "";
  // Doto has no em dash, so a missing value falls back to mono whatever the kind.
  const missing = value === null || value === undefined;
  const valueClass = missing || kind === "text" ? "ck-mono" : "ck-stat-value";
  return (
    <div className="ck-stat" title={title}>
      <span className="ck-colhead">{label}</span>
      <span className={valueClass + toneClass}>{missing ? "—" : value}</span>
      {note && <span className="ck-dim text-[12px]">{note}</span>}
    </div>
  );
}
