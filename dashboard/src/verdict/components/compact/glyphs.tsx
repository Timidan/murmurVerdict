import type { ReactNode } from "react";

import { Ik, IkNav } from "../../icons.js";

/**
 * Monochrome glyphs (currentColor) standing in for enum text, each with a
 * `title` tooltip. `seal` and the `agent` kind come from the shared `Ik` set
 * and follow its 16/32 size contract; the rest are drawn here.
 */

const SVG_BASE = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

function Wrap({
  title,
  label,
  tone,
  className,
  children,
}: {
  title: string;
  label: string;
  tone?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={"inline-flex items-center " + (tone ?? "") + (className ? " " + className : "")}
      title={title}
      role="img"
      aria-label={label}
    >
      {children}
    </span>
  );
}

/* ── Agent kind ──────────────────────────────────────────────────────────────
   agent → bot head · benchmark → ruler · attested → shield+check · internal → flask. */

/** Either a shared-set `mark` (brings its own <svg>) or 24-grid `paths`. */
type KindMeta = { label: string; tone: string } & (
  | { mark: (size: 16 | 24 | 32 | 48) => ReactNode; paths?: never }
  | { paths: ReactNode; mark?: never }
);

const KIND_META: Record<string, KindMeta> = {
  agent: {
    label: "agent",
    tone: "ck-pos",
    // 24/48 use the nav-tier drawing; Ik only allows 16/32.
    mark: (size) =>
      size === 16 || size === 32 ? (
        <Ik name="agent" size={size} />
      ) : (
        <IkNav name="agent" size={size} />
      ),
  },
  benchmark: {
    label: "benchmark",
    tone: "ck-dim",
    paths: (
      <>
        <rect x="3" y="6.5" width="18" height="11" rx="1.75" />
        <path d="M6.5 6.5v3M9.25 6.5v2M12 6.5v5M14.75 6.5v2M17.5 6.5v3" />
      </>
    ),
  },
  attested: {
    label: "attested",
    tone: "ck-neg",
    paths: (
      <>
        <path d="M12 2.75 19.5 5.5v6.4c0 4.9-3.1 7.8-7.5 9.35-4.4-1.55-7.5-4.45-7.5-9.35V5.5L12 2.75Z" />
        <path d="m8.6 11.85 2.3 2.3 4.9-4.9" />
      </>
    ),
  },
  internal_test: {
    label: "internal test",
    tone: "ck-dim",
    paths: (
      <>
        <path d="M9 3h6M10 3v5.25l-5.24 9.08A2.45 2.45 0 0 0 6.88 21h10.24a2.45 2.45 0 0 0 2.12-3.67L14 8.25V3" />
        <path d="M7.2 16h9.6" />
        <circle cx="12.5" cy="12.75" r="0.9" fill="currentColor" stroke="none" />
      </>
    ),
  },
};

export function KindGlyph({
  kind,
  size = 16,
  className,
  tone = true,
}: {
  kind: string | null | undefined;
  /** px; the hand-drawn paths are a 24 grid. */
  size?: 16 | 24 | 32 | 48;
  className?: string;
  /** Apply the tier tone (agent=ink, attested=accent, else dim). */
  tone?: boolean;
}) {
  const k = (kind ?? "agent").toString();
  const meta = KIND_META[k];
  if (!meta) {
    // Unknown kind (stale enum): fall back to the raw label, no crash.
    return (
      <Wrap title={k} label={`kind ${k}`} tone="ck-dim" className={className}>
        <span className="ck-label">{k}</span>
      </Wrap>
    );
  }
  return (
    <Wrap
      title={meta.label}
      label={`kind ${meta.label}`}
      tone={tone ? meta.tone : undefined}
      className={className}
    >
      {meta.mark ? (
        meta.mark(size)
      ) : (
        <svg {...SVG_BASE} style={{ width: size, height: size, display: "block" }}>
          {meta.paths}
        </svg>
      )}
    </Wrap>
  );
}

/* ── Privacy mode → shared seal mark ────────────────────────────────────────── */

export function SealGlyph({
  mode,
  size = 16,
  className,
}: {
  mode: string | null | undefined;
  size?: 16 | 32;
  className?: string;
}) {
  if (!mode) return null;
  // Unknown modes show their raw value.
  const label = mode === "sealed_fhenix" ? "fhenix sealed" : mode;
  return (
    <Wrap title={label} label={`privacy ${label}`} tone="ck-pos" className={className}>
      <Ik name="seal" size={size} />
    </Wrap>
  );
}

/* ── Market venue → grayscale brand mark (polymarket today) ──────────────────── */

export function VenueGlyph({
  venue,
  size = 14,
  className,
}: {
  venue: string | null | undefined;
  size?: number;
  className?: string;
}) {
  const v = (venue ?? "").toString().toLowerCase();
  if (v.includes("polymarket")) {
    return (
      <span
        className={"inline-flex items-center " + (className ?? "")}
        title="polymarket"
        role="img"
        aria-label="venue polymarket"
      >
        <img
          src="/brand/tokens/polymarket.png"
          alt=""
          aria-hidden="true"
          className="opacity-80"
          style={{ width: Math.round(size * 0.85), height: size, display: "block" }}
        />
      </span>
    );
  }
  // Unknown venue: keep the text.
  return <span className={"ck-mono " + (className ?? "")}>{venue ?? "—"}</span>;
}
