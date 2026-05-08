interface CalmScoreProps {
  /** Numeric score; e.g. 0.218, -0.118. null → ——. */
  value: number | null;
  /** Subscript caption — placed small below the number. */
  caption?: string;
}

/**
 * Hero score readout for CALM. Purely scale + weight — no decoration,
 * no fractional accent. The number is the artwork.
 *
 * Sign + integer + fraction all in --calm-ink. Caption (e.g. "30 day
 * verdict score, σ-units") is the museum placard underneath.
 */
export function CalmScore({ value, caption }: CalmScoreProps) {
  if (value === null || Number.isNaN(value)) {
    return (
      <div className="calm-enter">
        <div className="calm-display" style={{ color: "var(--calm-ink-faint)" }}>——</div>
        {caption && <p className="calm-meta mt-6 calm-enter calm-enter-delay-1">{caption}</p>}
      </div>
    );
  }

  const sign = value >= 0 ? "+" : "−";
  const abs = Math.abs(value);
  const integer = Math.trunc(abs).toString();
  const frac = abs.toFixed(3).split(".")[1] ?? "000";

  return (
    <div>
      <div className="calm-display calm-enter tabular-nums" aria-label={`${sign === "+" ? "plus" : "minus"} ${integer} point ${frac}`}>
        <span>{sign}</span>
        <span>{integer}</span>
        <span style={{ color: "var(--calm-ink-soft)" }}>.{frac}</span>
      </div>
      {caption && <p className="calm-meta mt-6 calm-enter calm-enter-delay-1">{caption}</p>}
    </div>
  );
}
