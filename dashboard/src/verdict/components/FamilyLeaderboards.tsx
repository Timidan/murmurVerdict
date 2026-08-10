// ─── FamilyLeaderboards (Phase 10) ─────────────────────────────────────────
//
// Per-family + general leaderboards. A `market_family` (e.g.
// 'financial-direction', 'prediction-market-binary') groups markets that
// share a scoring shape so single-family specialists aren't penalized
// against generalists. This component:
//
//   1. Fetches /v1/families and renders a switcher of available families
//      (sorted by submission count desc).
//   2. Default view: top-10 general practitioners by conservative family
//      coverage. Click a family chip to switch into that family's LB.
//
// Visual rhythm matches CompactSparkline/LiveFeed (Nothing density).

import { useEffect, useState } from "react";
import { verdictApi, type AgentFamilyRow, type AgentCrossFamilyRow } from "../api.js";
import { IkNav } from "../icons.js";
import { InlineError } from "./compact/InlineError.js";
import { formatScore } from "../lib/score-format.js";

type View = "cross" | { family: string };

interface FamiliesMeta {
  market_family: string;
  submissions: number;
  resolved: number;
}

export function FamilyLeaderboards() {
  const [families, setFamilies] = useState<FamiliesMeta[] | null>(null);
  const [view, setView] = useState<View>("cross");
  const [cross, setCross] = useState<AgentCrossFamilyRow[] | null>(null);
  const [family, setFamily] = useState<AgentFamilyRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancel = false;
    verdictApi
      .families()
      .then((r) => {
        if (!cancel) setFamilies(r.families);
      })
      .catch((e) => {
        if (!cancel) setError(e.message);
      });
    return () => {
      cancel = true;
    };
  }, []);

  useEffect(() => {
    let cancel = false;
    if (view === "cross") {
      setCross(null);
      verdictApi
        .crossFamilyLeaderboard({ limit: 10 })
        .then((r) => {
          if (!cancel) setCross(r.agents);
        })
        .catch((e) => {
          if (!cancel) setError(e.message);
        });
    } else {
      setFamily(null);
      verdictApi
        .familyLeaderboard(view.family, { limit: 10 })
        .then((r) => {
          if (!cancel) setFamily(r.agents);
        })
        .catch((e) => {
          if (!cancel) setError(e.message);
        });
    }
    return () => {
      cancel = true;
    };
  }, [view]);

  return (
    <div className="border border-[var(--color-border-vis)]">
      <div className="ck-header flex items-center gap-2 px-2 py-1">
        {/* ck-title-ik: the `market` glyph REPLACES the generic ::before
            square — one marker per title, never two. The 24-grid nav drawing
            is the one that belongs beside 18px/700 title ink. */}
        <span className="ck-title ck-title-ik">
          <IkNav name="market" /> families
        </span>
        <span className="ck-mono ck-dim">
          {view === "cross" ? "general" : `per-family · ${view.family}`}
        </span>
      </div>
      <div className="flex flex-wrap gap-1 px-2 py-1 border-b border-[var(--color-border)]">
        <FamilyChip
          active={view === "cross"}
          label="general"
          onClick={() => setView("cross")}
        />
        {families?.map((f) => (
          <FamilyChip
            key={f.market_family}
            active={view !== "cross" && view.family === f.market_family}
            label={f.market_family}
            sub={`${f.resolved}/${f.submissions}`}
            onClick={() => setView({ family: f.market_family })}
          />
        ))}
      </div>
      {error && (
        <InlineError error={error} className="px-2 py-2 ck-mono" />
      )}
      {view === "cross" ? (
        cross === null ? (
          <SkelRows />
        ) : (
          <CrossRows rows={cross} />
        )
      ) : family === null ? (
        <SkelRows />
      ) : (
        <FamilyRows rows={family} />
      )}
    </div>
  );
}

function FamilyChip({
  active,
  label,
  sub,
  onClick,
}: {
  active: boolean;
  label: string;
  sub?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "ck-label inline-flex items-center px-[6px] py-[1px] border " +
        "border-[var(--color-border-vis)] " +
        (active ? "ck-pos" : "ck-dim hover:ck-pos")
      }
    >
      [ {label}
      {sub ? <span className="ck-dim ml-1">{sub}</span> : null} ]
    </button>
  );
}

function SkelRows() {
  return (
    <div className="px-2 py-3 ck-mono ck-dim">loading…</div>
  );
}

function CrossRows({ rows }: { rows: AgentCrossFamilyRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="px-2 py-3 ck-mono ck-dim">
        no agents qualify in ≥2 families yet
      </div>
    );
  }
  return (
    <ul className="divide-y divide-[var(--color-border)] ck-mono">
      {rows.map((r, i) => (
        <li key={r.agent_id} className="flex items-center gap-2 px-2 py-1">
          <span className="ck-dim w-6 text-right">
            {r.cross_family_main_tier ? i + 1 : "—"}
          </span>
          <a
            href={`#/agents/${encodeURIComponent(r.display_slug)}`}
            className="ck-pos flex-1 truncate hover:underline"
          >
            {r.display_slug}
          </a>
          <span className="ck-dim">
            {formatScore(r.general_score)}
          </span>
          <span className="ck-dim">
            {Math.round(r.coverage_ratio * 100)}% covered
          </span>
        </li>
      ))}
    </ul>
  );
}

function FamilyRows({ rows }: { rows: AgentFamilyRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="px-2 py-3 ck-mono ck-dim">no agents yet</div>
    );
  }
  return (
    <ul className="divide-y divide-[var(--color-border)] ck-mono">
      {rows.map((r, i) => (
        <li key={r.agent_id} className="flex items-center gap-2 px-2 py-1">
          <span className="ck-dim w-6 text-right">
            {r.family_main_tier ? i + 1 : "—"}
          </span>
          <a
            href={`#/agents/${encodeURIComponent(r.display_slug)}`}
            className="ck-pos flex-1 truncate hover:underline"
          >
            {r.display_slug}
          </a>
          <span className="ck-dim">
            {formatScore(r.verdict_score)}
          </span>
          <span className="ck-dim">{r.resolved_calls} res</span>
        </li>
      ))}
    </ul>
  );
}
