import { text } from "../ui/tokens.js";

interface ScoreProps {
  /** Numeric score; e.g. 0.218, -0.118. null → ——. */
  value: number | null;
  /** Unit subscript (e.g. "σ"). */
  unit?: string;
  /** Period subscript (e.g. "30d"). Stacked under unit. */
  period?: string;
  /** Optional explicit label above the readout. */
  label?: React.ReactNode;
  /** Smaller display variant for the landing-page mini hero. */
  size?: "lg" | "md";
}

/**
 * Hero score readout. The Doto numerals are the page protagonist —
 * sized to fill the canvas, fractional digits in the accent color so
 * the eye latches onto the precision instantly.
 *
 * Sign + integer = white. Fractional = accent. Unit + period stacked
 * to the right in Space Mono caption — like a Nothing battery readout.
 */
export function Score({ value, unit, period, label, size = "lg" }: ScoreProps) {
  const cls = size === "lg" ? text.display : text.displayMd;

  if (value === null || Number.isNaN(value)) {
    return (
      <div>
        {label && <div className="t-label mb-3">{label}</div>}
        <div className={`${cls} text-[var(--color-secondary)]`}>——</div>
      </div>
    );
  }

  const sign = value >= 0 ? "+" : "−";
  const abs = Math.abs(value);
  const integer = Math.trunc(abs).toString();
  // 3 decimal places, drop the leading "0."
  const frac = abs.toFixed(3).split(".")[1] ?? "000";

  const aria = `${sign === "+" ? "plus" : "minus"} ${integer} point ${frac
    .split("")
    .join(" ")}${unit ? ` ${unit}` : ""}${period ? ` ${period} rolling` : ""}`;

  return (
    <div>
      {label && <div className="t-label mb-3">{label}</div>}
      <div className={`${cls} flex items-baseline gap-0`} role="text" aria-label={aria}>
        <span className="text-[var(--color-display)]">{sign}</span>
        <span className="text-[var(--color-display)]">{integer}</span>
        <span className="text-[var(--color-accent)]">.{frac}</span>
        {(unit || period) && (
          <span className="ml-4 self-end pb-[1.2em] flex flex-col gap-0.5 t-label">
            {unit && <span>{unit}</span>}
            {period && <span>{period}</span>}
          </span>
        )}
      </div>
    </div>
  );
}
