// dashboard/src/verdict/components/Wordmark.tsx
//
// Horizontal or stacked wordmark: [MMark]  MURMUR.verdict
// Uses the same SVG mark from MMark; layout is CSS flex.

import { MMark } from "./MMark.js";

export interface WordmarkProps {
  /** px height. Defaults to 24. Mark sizes to height; text scales with it. */
  size?: number;
  orientation?: "horizontal" | "stacked";
  className?: string;
}

export function Wordmark({ size = 24, orientation = "horizontal", className }: WordmarkProps) {
  const markSize = orientation === "horizontal" ? Math.round(size * 1.2) : Math.round(size * 1.6);
  const textSize = size;

  if (orientation === "stacked") {
    return (
      <span
        className={className}
        style={{
          display: "inline-flex",
          flexDirection: "column",
          alignItems: "flex-start",
          gap: Math.round(size * 0.25),
        }}
        role="img"
        aria-label="Murmur Verdict"
      >
        <MMark size={markSize} decorative />
        <span
          aria-hidden
          style={{
            fontFamily: "var(--font-sans)",
            fontWeight: 700,
            fontSize: textSize,
            letterSpacing: "-0.01em",
            color: "var(--color-display)",
            lineHeight: 1,
          }}
        >
          MURMUR
          <span style={{ color: "var(--color-secondary)", fontWeight: 400 }}>.verdict</span>
        </span>
      </span>
    );
  }

  return (
    <span
      className={className}
      style={{ display: "inline-flex", alignItems: "center", gap: Math.round(size * 0.5) }}
      role="img"
      aria-label="Murmur Verdict"
    >
      <MMark size={markSize} decorative />
      <span
        aria-hidden
        style={{
          fontFamily: "var(--font-sans)",
          fontWeight: 700,
          fontSize: textSize,
          letterSpacing: "-0.01em",
          color: "var(--color-display)",
          lineHeight: 1,
        }}
      >
        MURMUR
        <span style={{ color: "var(--color-secondary)", fontWeight: 400 }}>.verdict</span>
      </span>
    </span>
  );
}
