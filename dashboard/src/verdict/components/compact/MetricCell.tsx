import type { ReactNode } from "react";

interface MetricCellProps {
  /** Short ALL CAPS label, e.g. "RES" / "WR" / "PEND". */
  label: string;
  /** Primary numeric readout. */
  value: ReactNode;
  /** Optional unit suffix, e.g. "%" / "σ". */
  unit?: ReactNode;
  /** Tone for the number — defaults to display-white. */
  tone?: "pos" | "neg" | "dim" | "default";
  /** Optional sub-line under the value (sparkline, delta). */
  trail?: ReactNode;
}

/** Tiny stat readout — 4-6px padding, bordered cell. */
export function MetricCell({ label, value, unit, tone = "default", trail }: MetricCellProps) {
  const toneClass =
    tone === "pos" ? "ck-pos" : tone === "neg" ? "ck-neg" : tone === "dim" ? "ck-dim" : "ck-pos";
  return (
    <div className="ck-cell flex flex-col gap-0.5 min-w-0">
      <span className="ck-label">{label}</span>
      <span className="flex items-baseline gap-1">
        <span className={"ck-num " + toneClass} style={{ fontSize: 13, fontWeight: 700 }}>
          {value}
        </span>
        {unit && <span className="ck-label ck-dim">{unit}</span>}
      </span>
      {trail && <span className="ck-mono ck-dim text-[10px]">{trail}</span>}
    </div>
  );
}
