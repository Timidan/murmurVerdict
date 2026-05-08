import type { ReactNode } from "react";

interface Stat {
  label: string;
  value: ReactNode;
  unit?: string;
}

interface CalmStatRowProps {
  stats: Stat[];
}

/**
 * Inline placard row — replaces the boxed StatsGrid. Hairline rule
 * above + below the row, no internal grid lines. Wide gaps. Numbers
 * in the heavy display weight, labels recede into ink-faint.
 */
export function CalmStatRow({ stats }: CalmStatRowProps) {
  return (
    <dl className="calm-rule calm-rule-bottom grid grid-cols-2 md:grid-cols-4">
      {stats.map((s) => (
        <div key={s.label} className="py-10 px-2 first:pl-0 last:pr-0 flex flex-col gap-3">
          <dt className="calm-eyebrow">{s.label}</dt>
          <dd className="calm-stat m-0">
            {s.value}
            {s.unit && (
              <span className="calm-meta ml-2" style={{ fontSize: "0.6em" }}>
                {s.unit}
              </span>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}
