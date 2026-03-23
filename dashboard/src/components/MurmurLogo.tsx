interface MurmurLogoProps {
  size?: "sm" | "md" | "lg";
}

export function MurmurLogo({ size = "md" }: MurmurLogoProps) {
  const scale = size === "sm" ? 0.45 : size === "lg" ? 1 : 0.6;
  const fontSize = 14 * scale;
  const lineHeight = 1.15;

  return (
    <pre
      style={{
        fontFamily: "'Geist Mono', 'JetBrains Mono', 'Fira Code', monospace",
        fontSize,
        lineHeight,
        margin: 0,
        padding: 0,
        userSelect: "none",
        whiteSpace: "pre",
        display: "inline-block",
      }}
    >
      <span style={{ color: "#f472b6" }}>{"▓▓▓   ▓▓▓"}</span>
      {"\n"}
      <span style={{ color: "#f472b6" }}>{"▓▓▓▓ ▓▓▓▓ "}</span>
      <span style={{ color: "#a78bfa" }}>{"█ █ █▀▄ █▄ ▄█ █ █ █▀▄"}</span>
      {"\n"}
      <span style={{ color: "#67e8f9" }}>{"▓▓ ▓▓▓ ▓▓ "}</span>
      <span style={{ color: "#a78bfa" }}>{"█ █ ██▀ █ ▀ █ █ █ ██▀"}</span>
      {"\n"}
      <span style={{ color: "#67e8f9" }}>{"▓▓  ▓  ▓▓ "}</span>
      <span style={{ color: "#a78bfa" }}>{"▀▀▀ ▀ ▀ ▀   ▀ ▀▀▀ ▀ ▀"}</span>
      {"\n"}
      <span style={{ color: "#334155" }}>{"░░     ░░ ░░░░░░░░░░░░░░░░░░░░░░░"}</span>
      {"\n"}
      <span style={{ color: "#52525b" }}>{"═══ LISTEN. TRADE. REPEAT. ═══"}</span>
    </pre>
  );
}

/** Compact inline version for the header bar */
export function MurmurLogoInline() {
  return (
    <span
      style={{
        fontFamily: "'Geist Mono', 'JetBrains Mono', 'Fira Code', monospace",
        fontSize: 11,
        letterSpacing: 0,
        userSelect: "none",
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
      }}
    >
      <span style={{ color: "#f472b6" }}>{"▓▓"}</span>
      <span style={{ color: "#67e8f9" }}>{"▓▓"}</span>
      <span style={{ color: "#a78bfa", fontWeight: 700, fontSize: 14, letterSpacing: 2 }}>
        MURMUR
      </span>
    </span>
  );
}
