// Tiny shared style tokens used across pages. No CSS framework — just inline.

export const colors = {
  bg: "#0a0a0c",
  surface: "#13131a",
  surfaceHi: "#1a1a23",
  border: "#262630",
  text: "#e6e6f0",
  textDim: "#7d7d93",
  accent: "#7cf3a0",
  accentDim: "#3d8a55",
  win: "#4ade80",
  loss: "#f87171",
  void: "#94a3b8",
  warn: "#fbbf24",
} as const;

export const fonts = {
  mono: 'ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, monospace',
  sans: '"Inter", system-ui, -apple-system, sans-serif',
} as const;

export const layout = {
  maxWidth: 1080,
  pad: 24,
  gap: 16,
} as const;

export function shellStyle(): React.CSSProperties {
  return {
    minHeight: "100dvh",
    background: colors.bg,
    color: colors.text,
    fontFamily: fonts.sans,
    fontSize: 14,
    lineHeight: 1.5,
    padding: `${layout.pad}px`,
    boxSizing: "border-box",
  };
}

export function containerStyle(): React.CSSProperties {
  return {
    maxWidth: layout.maxWidth,
    margin: "0 auto",
    display: "flex",
    flexDirection: "column",
    gap: layout.gap,
  };
}

export function cardStyle(): React.CSSProperties {
  return {
    background: colors.surface,
    border: `1px solid ${colors.border}`,
    borderRadius: 8,
    padding: 16,
  };
}

export function tableStyle(): React.CSSProperties {
  return {
    width: "100%",
    borderCollapse: "collapse",
    fontFamily: fonts.mono,
    fontSize: 13,
  };
}

export function thStyle(): React.CSSProperties {
  return {
    textAlign: "left",
    padding: "8px 12px",
    color: colors.textDim,
    fontWeight: 500,
    borderBottom: `1px solid ${colors.border}`,
    textTransform: "uppercase",
    fontSize: 11,
    letterSpacing: 0.5,
  };
}

export function tdStyle(): React.CSSProperties {
  return {
    padding: "10px 12px",
    borderBottom: `1px solid ${colors.border}`,
  };
}

export function pillStyle(tone: "neutral" | "good" | "bad" | "warn" = "neutral"): React.CSSProperties {
  const bg = {
    neutral: colors.surfaceHi,
    good: "rgba(74,222,128,0.12)",
    bad: "rgba(248,113,113,0.12)",
    warn: "rgba(251,191,36,0.12)",
  }[tone];
  const fg = {
    neutral: colors.textDim,
    good: colors.win,
    bad: colors.loss,
    warn: colors.warn,
  }[tone];
  return {
    display: "inline-block",
    padding: "2px 8px",
    borderRadius: 4,
    background: bg,
    color: fg,
    fontFamily: fonts.mono,
    fontSize: 12,
  };
}
