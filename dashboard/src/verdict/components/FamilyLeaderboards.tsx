// ─── FamilyLeaderboards ────────────────────────────────────────────────────
// Cross-family top 10 by default; a family chip switches to that family's
// leaderboard. Families group markets that score the same way.

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
    // Clear the previous view's error; this is a fresh request.
    setError(null);
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

  // One family has nothing to compare across; the ladder already shows it.
  if (families === null || families.length < 2) return null;

  return (
    <div>
      <div className="ck-section-head gap-2">
        {/* ck-title-ik: the glyph replaces the ::before square. */}
        <span
          className="ck-title ck-title-ik"
          title="a family groups markets that score the same way, so a specialist is not judged against a generalist"
        >
          <IkNav name="market" /> Families
        </span>
      </div>
      <div className="flex flex-wrap gap-1 px-2 py-1 border-b border-[var(--color-border)]">
        <FamilyChip
          active={view === "cross"}
          label="All families"
          onClick={() => setView("cross")}
        />
        {families?.map((f) => (
          <FamilyChip
            key={f.market_family}
            active={view !== "cross" && view.family === f.market_family}
            label={f.market_family}
            sub={`${f.resolved}/${f.submissions}`}
            title={`${f.resolved} of ${f.submissions} calls in this family have been scored`}
            onClick={() => setView({ family: f.market_family })}
          />
        ))}
      </div>
      {error && (
        <InlineError error={error} className="px-2 py-2 ck-mono" />
      )}
      {/* No skeleton once the request has failed. */}
      {view === "cross" ? (
        cross === null ? (
          error ? null : <SkelRows />
        ) : (
          <CrossRows rows={cross} />
        )
      ) : family === null ? (
        error ? null : <SkelRows />
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
  title,
  onClick,
}: {
  active: boolean;
  label: string;
  sub?: string;
  /** Plain-language reading of the `sub` ratio. */
  title?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className={"ck-seg " + (active ? "ck-seg-active" : "")}
    >
      {label}
      {/* The chosen chip is filled, so its ratio follows the label's ink. */}
      {sub ? <span className={active ? "ml-1" : "ck-dim ml-1"}>{sub}</span> : null}
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
      <div className="px-2 py-3 ck-mono ck-empty">
        No agent holds a rank in two or more families yet
      </div>
    );
  }
  return (
    <ul className="m-0 p-0 list-none ck-mono">
      <li className="ck-fam-row px-2 py-1 border-b border-[var(--color-border-vis)] ck-colhead">
        <span>#</span>
        <span>Agent</span>
        <span className="text-right" title="the agent's score across every family">
          Score
        </span>
        <span
          className="text-right"
          title="the share of families this agent holds a rank in"
        >
          Families
        </span>
      </li>
      {rows.map((r, i) => (
        <li
          key={r.agent_id}
          className="ck-fam-row px-2 py-1 border-b border-[var(--color-border)]"
        >
          <span className="ck-dim text-right">
            {r.cross_family_main_tier ? i + 1 : "—"}
          </span>
          <a
            href={`#/agents/${encodeURIComponent(r.display_slug)}`}
            className="ck-pos truncate hover:underline"
            title={r.display_slug}
          >
            {r.display_slug}
          </a>
          <span className="ck-num-key text-right">{formatScore(r.general_score)}</span>
          <span
            className="ck-dim text-right"
            title={`holds a rank in ${Math.round(r.coverage_ratio * 100)}% of families`}
          >
            {Math.round(r.coverage_ratio * 100)}%
          </span>
        </li>
      ))}
    </ul>
  );
}

function FamilyRows({ rows }: { rows: AgentFamilyRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="px-2 py-3 ck-mono ck-empty">No agents yet</div>
    );
  }
  return (
    <ul className="m-0 p-0 list-none ck-mono">
      <li className="ck-fam-row px-2 py-1 border-b border-[var(--color-border-vis)] ck-colhead">
        <span>#</span>
        <span>Agent</span>
        <span className="text-right" title="the agent's score in this family">
          Score
        </span>
        <span
          className="text-right"
          title="scored — calls that finished and earned a score"
        >
          Scored
        </span>
      </li>
      {rows.map((r, i) => (
        <li
          key={r.agent_id}
          className="ck-fam-row px-2 py-1 border-b border-[var(--color-border)]"
        >
          <span className="ck-dim text-right">
            {r.family_main_tier ? i + 1 : "—"}
          </span>
          <a
            href={`#/agents/${encodeURIComponent(r.display_slug)}`}
            className="ck-pos truncate hover:underline"
            title={r.display_slug}
          >
            {r.display_slug}
          </a>
          <span className="ck-num-key text-right">{formatScore(r.verdict_score)}</span>
          <span className="ck-dim text-right">{r.resolved_calls}</span>
        </li>
      ))}
    </ul>
  );
}
