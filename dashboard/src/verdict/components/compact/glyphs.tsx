import type { ReactNode } from "react";

import { Ik, IkNav } from "../../icons.js";

/**
 * Compact monochrome glyphs — replace repeated enum TEXT with a recognizable
 * mark, always with a `title` tooltip carrying the full name. All glyphs are
 * single-color (inherit `currentColor`), so they never inject brand color into
 * the "color is an event" cockpit. Sizing is via the `size` prop (px).
 *
 * Marks the shared set covers are drawn from it (`icons.tsx` → `Ik`), so those
 * concepts have exactly one drawing everywhere they appear: that is `seal`, and
 * the `agent` case of the kind mark. Those two wrappers therefore inherit `Ik`'s
 * size contract — 16 or 32, nothing between — and pass it straight through, so a
 * kind mark can never be the fractional size the shared set forbids. The other
 * kinds render at the same size for one uniform column. The rest are still
 * hand-rolled here,
 * because `kind` and `side` are VARIANT sets (one drawing per enum value) whose
 * other values — benchmark, attested, internal_test, up, down — have no
 * shared-set equivalent. The venue mark reuses the grayscale
 * /brand/tokens/polymarket.png that AssetGlyph already ships.
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
   agent → bot head · benchmark → ruler · attested → shield+check · internal → flask.
   Tone follows the tier semantics: agent = full ink, attested = accent (its bond
   is an event), benchmark/internal = dim.

   `agent` is the one concept the shared 16-grid set covers, so it draws from
   there. The other three have no shared-set equivalent and keep their
   hand-rolled 24-grid geometry — see KindMeta. */

/**
 * A kind's mark is EITHER a shared-set drawing (`mark`, which renders its own
 * <svg> and therefore replaces the 24-grid wrapper) OR inline `paths` drawn
 * inside SVG_BASE. The arms are mutually exclusive, so adopting a shared-set
 * drawing for one kind does not change how the others render.
 */
type KindMeta = { label: string; tone: string } & (
  | { mark: (size: 16 | 24 | 32 | 48) => ReactNode; paths?: never }
  | { paths: ReactNode; mark?: never }
);

const KIND_META: Record<string, KindMeta> = {
  agent: {
    label: "agent",
    tone: "ck-pos",
    // 24/48 route through the nav tier: same silhouette, drawn FOR 24 (48 is
    // its integer 2×) — Ik's 16/32 guard stays intact for the hand-drawn grid.
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
  /** 16/32 per `Ik`'s contract, plus 24 — these paths are 24-grid natively,
   *  so 24 is their 1:1 render (the hero-tile size). */
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
      {/* Shared-set marks bring their own <svg> (and are aria-hidden by
          contract — Wrap already carries role="img" + aria-label). Every other
          kind renders through the untouched 24-grid path below. */}
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

/* ── Call side (UP / DOWN) ──────────────────────────────────────────────────── */

export function SideGlyph({
  side,
  size = 14,
  className,
}: {
  side: string | null | undefined;
  size?: number;
  className?: string;
}) {
  const s = (side ?? "").toString().toUpperCase();
  if (s !== "UP" && s !== "DOWN") {
    // sealed / unknown: pass the text through unchanged.
    return <span className={"ck-mono " + (className ?? "")}>{side ?? "—"}</span>;
  }
  const up = s === "UP";
  return (
    <Wrap
      title={up ? "up" : "down"}
      label={`side ${up ? "up" : "down"}`}
      tone={up ? "ck-pos" : "ck-neg"}
      className={className}
    >
      <svg {...SVG_BASE} style={{ width: size, height: size, display: "block" }}>
        {up ? <path d="M12 19V6M6 12l6-6 6 6" /> : <path d="M12 5v13M6 12l6 6 6-6" />}
      </svg>
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
  /** `Ik`'s contract — this mark IS the shared-set `seal` drawing. */
  size?: 16 | 32;
  className?: string;
}) {
  if (!mode) return null;
  // Human label for the tooltip. Only sealed_fhenix is known today; anything
  // else shows its raw value so a new privacy mode is never silently hidden.
  const label = mode === "sealed_fhenix" ? "fhenix sealed" : mode;
  return (
    // The wrapper keeps the accessible name (role="img" + aria-label + title);
    // `Ik` is aria-hidden by contract, so the mark stays a single image node.
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
