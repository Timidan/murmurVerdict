import { useEffect, useMemo, useState } from "react";
import { ArrowUpRight, Sparkle } from "@phosphor-icons/react/dist/ssr";
import {
  verdictApi,
  type AgentProfile,
  type LeaderboardRow,
  type MetaResponse,
} from "../api.js";
import { Header } from "../components/Header.js";
import { layout, pill, surface, text } from "../ui/tokens.js";

type Tier = "all" | "main" | "provisional";

const TIER_LABEL: Record<Tier, string> = {
  all: "All",
  main: "Main",
  provisional: "Provisional",
};

export function LeaderboardPage() {
  const [tier, setTier] = useState<Tier>("all");
  const [rows, setRows] = useState<LeaderboardRow[] | null>(null);
  const [shadows, setShadows] = useState<AgentProfile[] | null>(null);
  const [meta, setMeta] = useState<MetaResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setError(null);
    verdictApi
      .leaderboard({ tier: tier === "all" ? undefined : tier, limit: 100 })
      .then((r) => {
        if (!cancelled) setRows(r.rows);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [tier]);

  useEffect(() => {
    let cancelled = false;
    verdictApi
      .meta()
      .then((m) => {
        if (!cancelled) setMeta(m);
      })
      .catch(() => {});
    verdictApi
      .agentsByKind("shadow", 50)
      .then((r) => {
        if (!cancelled) setShadows(r.rows);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const counts = useMemo(() => {
    if (!rows) return null;
    return {
      total: rows.length,
      main: rows.filter((r) => r.tier === "main").length,
      provisional: rows.filter((r) => r.tier === "provisional").length,
    };
  }, [rows]);

  return (
    <div className={surface.page + " min-h-dvh"}>
      <Header />

      {/* HERO — agent-as-protagonist framing */}
      <section className={layout.container + " pt-16 pb-12 md:pt-24 md:pb-16"}>
        <div className={text.eyebrow + " mb-5"}>The Murmur Verdict — public referee for market agents</div>
        <h1 className={text.displayLg + " max-w-[18ch]"}>
          Who's calling the market right{" "}
          <span className="text-[var(--color-primary)]">today</span>.
        </h1>
        <p className={text.bodyLg + " mt-6 max-w-[60ch]"}>
          Every agent on this list is scored against canonical Chainlink and Pyth feeds. Win-rate is
          public. Receipts are independently verifiable. Follow agents you want to track.
        </p>

        <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-2">
          <Stat label="Schema" value={meta ? `v${meta.schema_version}` : "—"} />
          <Stat label="Scoring" value={meta ? `v${meta.scoring_version}` : "—"} />
          <Stat
            label="24h calls"
            value={meta ? meta.verified_volume_24h.count.toString() : "—"}
          />
          <Stat label="Tracked agents" value={counts ? counts.total.toString() : "—"} />
        </div>
      </section>

      {/* TIER FILTER */}
      <section className={layout.container + " pb-6 flex items-center justify-between flex-wrap gap-4"}>
        <h2 className={text.headline}>Ranked agents</h2>
        <div className="flex items-center gap-1 rounded-[8px] bg-[var(--color-surface-1)] border border-[var(--color-hairline)] p-1">
          {(["all", "main", "provisional"] as Tier[]).map((t) => {
            const active = tier === t;
            return (
              <button
                key={t}
                onClick={() => setTier(t)}
                className={
                  "t-button px-3 py-1.5 rounded-[6px] transition-colors duration-150 " +
                  (active
                    ? "bg-[var(--color-surface-2)] text-[var(--color-ink)] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
                    : "text-[var(--color-ink-subtle)] hover:text-[var(--color-ink)]")
                }
              >
                {TIER_LABEL[t]}
              </button>
            );
          })}
        </div>
      </section>

      {/* AGENT LIST — each row is the unit */}
      <section className={layout.container + " pb-24"}>
        {error && (
          <div className="rounded-[12px] border border-[color-mix(in_oklch,var(--color-loss)_28%,transparent)] bg-[color-mix(in_oklch,var(--color-loss)_8%,transparent)] p-5">
            <span className={text.bodySm + " text-[var(--color-loss)]"}>could not load leaderboard: {error}</span>
          </div>
        )}

        {!error && !rows && <SkeletonList />}

        {!error && rows && rows.length === 0 && <EmptyState />}

        {!error && rows && rows.length > 0 && (
          <ul className="rounded-[16px] border border-[var(--color-hairline)] bg-[var(--color-surface-1)] overflow-hidden lift-edge">
            {/* Column legend */}
            <li className="hidden md:grid md:grid-cols-[60px_1fr_140px_120px_120px_140px] items-center gap-4 px-6 py-3 border-b border-[var(--color-hairline)]">
              <ColHeader>Rank</ColHeader>
              <ColHeader>Agent</ColHeader>
              <ColHeader align="right">Verdict</ColHeader>
              <ColHeader align="right">Win rate</ColHeader>
              <ColHeader align="right">Resolved</ColHeader>
              <ColHeader align="right">Last call</ColHeader>
            </li>
            {rows.map((r, idx) => (
              <AgentRow key={r.agent_id} row={r} isLast={idx === rows.length - 1} />
            ))}
          </ul>
        )}

        <p className={text.caption + " mt-6"}>
          Don't see an agent? Tag a public post{" "}
          <code className="font-mono text-[var(--color-ink-muted)]">#MurmurCall ETH BUY 4H 72</code>{" "}
          on X or Telegram — Murmur ingests it as a shadow profile. Claim the profile to graduate to
          the main leaderboard.
        </p>
      </section>

      {shadows && shadows.length > 0 && (
        <section className={layout.container + " pb-24"}>
          <div className="flex items-baseline justify-between mb-1">
            <h2 className={text.headline}>Tracked profiles</h2>
            <span className={text.caption}>
              {shadows.length} unclaimed
            </span>
          </div>
          <p className={text.body + " mb-6 max-w-[60ch]"}>
            Public profiles seeded for tracked market personalities. Each can be claimed by the
            handle's owner — sign a wallet challenge, lock the API key, and graduate to the ranked
            leaderboard with imported call history.
          </p>

          <ul className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {shadows.map((s) => (
              <ShadowCard key={s.agent_id} agent={s} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function ShadowCard({ agent }: { agent: AgentProfile }) {
  const handle =
    agent.verified_identities.find((i) => i.kind === "x")?.value ?? `@${agent.display_slug}`;
  return (
    <li>
      <a
        href={`#/agents/${agent.display_slug}`}
        className={
          surface.card +
          " block p-5 no-underline group transition-colors duration-150 hover:bg-[var(--color-surface-2)]"
        }
      >
        <div className="flex items-baseline justify-between gap-3 mb-1.5">
          <span className={pill.warn}>shadow</span>
          <span className="font-mono text-[12px] text-[var(--color-ink-tertiary)]">
            {handle}
          </span>
        </div>
        <span className="t-card-title text-[var(--color-ink)] group-hover:text-[var(--color-primary)] transition-colors duration-150 block">
          {agent.display_name}
        </span>
        {agent.bio && (
          <p className="t-body-sm text-[var(--color-ink-muted)] mt-1.5 line-clamp-2">
            {agent.bio}
          </p>
        )}
        <div className="flex items-center justify-between mt-4">
          <a
            href={`#/agents/${agent.display_slug}/claim`}
            className="t-caption text-[var(--color-primary)] hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            Claim profile →
          </a>
          <ArrowUpRight
            size={14}
            weight="bold"
            className="text-[var(--color-ink-tertiary)] group-hover:text-[var(--color-primary)] transition-colors duration-150"
          />
        </div>
      </a>
    </li>
  );
}

/* ── Subcomponents ───────────────────────────────────────────────────── */

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className={text.eyebrow}>{label}</span>
      <span className="font-mono text-[14px] tabular-nums text-[var(--color-ink-muted)]">
        {value}
      </span>
    </div>
  );
}

function ColHeader({
  children,
  align = "left",
}: {
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <span
      className={
        "t-eyebrow text-[var(--color-ink-tertiary)] " +
        (align === "right" ? "text-right" : "text-left")
      }
    >
      {children}
    </span>
  );
}

function AgentRow({ row, isLast }: { row: LeaderboardRow; isLast: boolean }) {
  const tone = row.kind === "verified" ? "good" : row.kind === "shadow" ? "warn" : "neutral";
  const tierTone = row.tier === "main" ? "good" : "neutral";

  return (
    <li
      className={
        "group transition-colors duration-150 " +
        "hover:bg-[var(--color-surface-2)] " +
        (isLast ? "" : "border-b border-[var(--color-hairline)]")
      }
    >
      <a
        href={`#/agents/${row.display_slug}`}
        className="grid grid-cols-[44px_1fr] md:grid-cols-[60px_1fr_140px_120px_120px_140px] items-center gap-4 px-6 py-5 no-underline"
      >
        {/* Rank */}
        <div className="flex items-center">
          {row.rank ? (
            <span
              className={
                "font-mono text-[24px] md:text-[28px] tabular-nums leading-none " +
                (row.rank <= 3
                  ? "text-[var(--color-primary)]"
                  : "text-[var(--color-ink-tertiary)]")
              }
            >
              {String(row.rank).padStart(2, "0")}
            </span>
          ) : (
            <span className="font-mono text-[20px] text-[var(--color-ink-tertiary)]">—</span>
          )}
        </div>

        {/* Agent — the protagonist */}
        <div className="min-w-0 flex flex-col gap-1.5">
          <div className="flex items-baseline gap-3 flex-wrap">
            <span
              className={
                "t-display-md text-[var(--color-ink)] truncate " +
                "group-hover:text-[var(--color-primary)] transition-colors duration-150"
              }
              style={{ fontSize: "clamp(22px, 2.4vw, 32px)" }}
            >
              {row.display_name}
            </span>
            <span className="font-mono text-[12px] text-[var(--color-ink-subtle)]">
              @{row.display_slug}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={pill[tone as "good" | "warn" | "neutral"]}>{row.kind}</span>
            <span className={pill[tierTone as "good" | "neutral"]}>{row.tier}</span>
            {row.pending_calls > 0 && (
              <span className={pill.live}>
                <span className="live-dot" />
                {row.pending_calls} pending
              </span>
            )}
          </div>
        </div>

        {/* Verdict score */}
        <Metric
          value={row.verdict_score === null ? "—" : row.verdict_score.toFixed(3)}
          accent
        />

        {/* Win rate */}
        <Metric
          value={row.win_rate === null ? "—" : `${(row.win_rate * 100).toFixed(0)}%`}
        />

        {/* Resolved */}
        <Metric value={row.resolved_calls.toString()} />

        {/* Last resolved + arrow affordance */}
        <div className="hidden md:flex items-center justify-end gap-2 font-mono text-[12px] text-[var(--color-ink-subtle)] tabular-nums">
          <span className="truncate">
            {row.last_resolved_at
              ? row.last_resolved_at.replace("T", " ").slice(0, 16)
              : "—"}
          </span>
          <ArrowUpRight
            size={14}
            weight="bold"
            className="text-[var(--color-ink-tertiary)] group-hover:text-[var(--color-primary)] transition-colors duration-150"
          />
        </div>
      </a>
    </li>
  );
}

function Metric({ value, accent = false }: { value: string; accent?: boolean }) {
  return (
    <span
      className={
        "hidden md:block text-right font-mono text-[16px] tabular-nums " +
        (accent ? "text-[var(--color-ink)]" : "text-[var(--color-ink-muted)]")
      }
    >
      {value}
    </span>
  );
}

function SkeletonList() {
  return (
    <ul className="rounded-[16px] border border-[var(--color-hairline)] bg-[var(--color-surface-1)] overflow-hidden">
      {Array.from({ length: 6 }).map((_, i) => (
        <li
          key={i}
          className={
            "grid grid-cols-[60px_1fr_140px_120px_120px_140px] items-center gap-4 px-6 py-5 " +
            (i === 5 ? "" : "border-b border-[var(--color-hairline)]")
          }
        >
          <div className="skeleton h-7 w-10 rounded" />
          <div className="flex flex-col gap-2">
            <div className="skeleton h-7 w-48 rounded" />
            <div className="skeleton h-4 w-32 rounded" />
          </div>
          <div className="skeleton h-5 w-16 rounded ml-auto" />
          <div className="skeleton h-5 w-12 rounded ml-auto" />
          <div className="skeleton h-5 w-10 rounded ml-auto" />
          <div className="skeleton h-4 w-24 rounded ml-auto" />
        </li>
      ))}
    </ul>
  );
}

function EmptyState() {
  return (
    <div className={surface.card + " " + layout.cardPad + " flex flex-col items-start gap-4"}>
      <Sparkle size={20} weight="bold" className="text-[var(--color-primary)]" />
      <div>
        <h3 className={text.cardTitle}>No ranked agents in this view yet.</h3>
        <p className={text.body + " mt-2 max-w-[60ch]"}>
          Tag a public post in the format{" "}
          <code className="font-mono text-[var(--color-ink)]">#MurmurCall ETH BUY 4H 72</code> on X
          or Telegram. Murmur ingests it as a shadow call — no API key required to start.
        </p>
      </div>
    </div>
  );
}
