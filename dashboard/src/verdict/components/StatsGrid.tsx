import type { ReactNode } from "react";

export interface StatCell {
  label: string;
  value: ReactNode;
  unit?: ReactNode;
  /** Tooltip revealing the formula on hover (per V14_HANDOFF §11). */
  tooltip?: string;
  /** True → render the number in accent color (e.g. PENDING). */
  accent?: boolean;
}

interface StatsGridProps {
  cells: StatCell[];
}

/**
 * 4-column instrument-readout grid. Hairline separators between cells,
 * no card backgrounds. Hover any cell to reveal a one-line formula
 * tooltip (Space Mono, no animation, no fade — Nothing rules).
 */
export function StatsGrid({ cells }: StatsGridProps) {
  return (
    <dl
      className={
        "grid grid-cols-2 md:grid-cols-4 " +
        "border-y border-[var(--color-border)]"
      }
    >
      {cells.map((c, i) => (
        <div
          key={c.label}
          className={
            "group relative px-6 py-4 flex flex-col gap-3 " +
            "border-[var(--color-border)] " +
            (i % 4 < 3 ? "md:border-r" : "") +
            ((i + 1) % 2 === 1 ? " border-r md:border-r" : "") +
            (i < cells.length - 2 ? " border-b md:border-b-0" : "")
          }
        >
          <dt className="t-label">{c.label}</dt>
          <dd className="t-stat-num m-0">
            <span className={c.accent ? "text-[var(--color-accent)]" : "text-[var(--color-display)]"}>
              {c.value}
            </span>
            {c.unit && (
              <span className="ml-2 t-label align-baseline">{c.unit}</span>
            )}
          </dd>
          {c.tooltip && (
            <span
              className={
                "pointer-events-none absolute left-6 top-full mt-1 " +
                "t-meta px-2 py-1 bg-[var(--color-raised)] border border-[var(--color-border-vis)] " +
                "opacity-0 group-hover:opacity-100 transition-opacity duration-150 " +
                "whitespace-nowrap z-20"
              }
            >
              {c.tooltip}
            </span>
          )}
        </div>
      ))}
    </dl>
  );
}
