import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  verdictApi,
  fetchAgentGrid,
  ApiError,
  type AgentCallRow,
  type AgentMarketRow,
  type AgentProfile,
} from "../api.js";
import { CompactTopbar } from "../components/compact/Topbar.js";
import { Panel } from "../components/compact/Panel.js";
import { CompactSparkline } from "../components/compact/Sparkline.js";
import { FormulaTip } from "../components/compact/FormulaTip.js";
import { ErrorState } from "../components/compact/ErrorState.js";
import { PanelSkeleton } from "../components/compact/PanelSkeleton.js";
import { useDetailDrawer, isPlainLeftClick } from "../components/compact/DetailDrawer.js";
import { KindGlyph } from "../components/compact/glyphs.js";
import { formatScore } from "../lib/score-format.js";
import {
  classifyCallOutcome,
  isPendingCallStatus,
  isTerminalFailureStatus,
} from "@shared/wire-call-status";

/**
 * COMPACT per-agent dashboard. Single screen splits:
 *   ribbon → identity / score / kind / wallet / actions
 *   3-col main → call log · market heat · sticky sidecar (stats + actions)
 * No hero number, no oversized Doto. The large readout is mono.
 */
export function AgentPage({ slug }: { slug: string }) {
  const [agent, setAgent] = useState<AgentProfile | null>(null);
  const [calls, setCalls] = useState<AgentCallRow[] | null>(null);
  const [grid, setGrid] = useState<AgentMarketRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  useEffect(() => {
    let cancel = false;
    setAgent(null);
    setCalls(null);
    setGrid(null);
    setError(null);
    setNotFound(false);
    // The primary agent fetch GATES the dependents. Previously agent + calls
    // + grid fanned out in parallel, so an unknown slug fired three requests
    // and painted three 404s. Now the calls/grid reads fire only after the
    // agent resolves — an unknown agent costs a single request and lands on
    // the shared not-found state. Each dependent also degrades to an empty
    // panel on its own failure rather than collapsing the whole page.
    verdictApi
      .agent(slug)
      .then((a) => {
        if (cancel) return;
        setAgent(a);
        verdictApi
          .agentCalls(slug, 100)
          .then((c) => {
            if (!cancel) setCalls(c.calls);
          })
          .catch(() => {
            if (!cancel) setCalls([]);
          });
        fetchAgentGrid(slug)
          .then((g) => {
            if (!cancel) setGrid(g?.grid ?? []);
          })
          .catch(() => {
            if (!cancel) setGrid([]);
          });
      })
      .catch((e: unknown) => {
        if (cancel) return;
        setError(e instanceof Error ? e.message : String(e));
        if (e instanceof ApiError && e.status === 404) setNotFound(true);
      });
    return () => {
      cancel = true;
    };
  }, [slug]);

  const stats = useMemo(() => {
    if (!calls) return null;
    // Classify by lifecycle/scoring state, mirroring
    // src/verdict/leaderboard-call-summary.ts. win/loss are the only scored
    // outcomes; void / oracle_unavailable are EXCLUDED from win-rate and the
    // average (their null scores are never zeroed into it); pending counts
    // EXACTLY the canonical accepted/pending_t0/pending_t1 set from
    // isPendingLeaderboardStatus, so this page's pend can never disagree
    // with the leaderboard's pending_calls; terminal reveal/rejection
    // failures (rejected, invalid_reveal, missed_reveal) are neither pending
    // nor scored; any other non-outcome row (submitted, preflighted,
    // unresolved disputed, defensive unknowns) lands in a dim `other` tally.
    let wins = 0;
    let losses = 0;
    let voids = 0;
    let pending = 0;
    let failed = 0;
    let other = 0;
    const scores: number[] = [];
    for (const c of calls) {
      // Classification vocabulary is shared with the daemon
      // (@shared/wire-call-status): win/loss are the only scored outcomes;
      // void folds void + oracle_unavailable; pending / terminal-failure are
      // status-derived; everything else lands in `other`.
      const outcomeClass = classifyCallOutcome(c.outcome);
      if (outcomeClass === "win") {
        wins++;
        if (c.call_score !== null && c.call_score !== undefined) scores.push(c.call_score);
      } else if (outcomeClass === "loss") {
        losses++;
        if (c.call_score !== null && c.call_score !== undefined) scores.push(c.call_score);
      } else if (outcomeClass === "void") {
        voids++;
      } else if (isPendingCallStatus(c.status)) {
        pending++;
      } else if (isTerminalFailureStatus(c.status)) {
        failed++;
      } else {
        other++;
      }
    }
    const winRate = wins + losses === 0 ? null : wins / (wins + losses);
    const avgScore =
      scores.length === 0
        ? null
        : scores.reduce((acc, s) => acc + s, 0) / scores.length;
    let streak = 0;
    for (const c of calls) {
      const outcomeClass = classifyCallOutcome(c.outcome);
      if (outcomeClass === "win") streak++;
      else if (outcomeClass === "loss") break;
    }
    return {
      total: calls.length,
      // "resolved" = scored resolved calls (win/loss with a real score);
      // voids are settled but unscored, so they sit in their own bucket.
      resolved: scores.length,
      wins,
      losses,
      voids,
      pending,
      failed,
      other,
      winRate,
      avgScore,
      streak,
    };
  }, [calls]);

  const ownerExplorerUrl =
    agent?.wallet_address && agent.chain_id
      ? blockExplorerAddressUrl(agent.wallet_address, agent.chain_id)
      : null;

  return (
    <div className="mmr-shell min-h-dvh flex flex-col">
      <CompactTopbar
        crumb={
          <span>
            agents <span className="ck-dim mx-1">/</span>
            <span className="ck-pos">{agent?.display_slug ?? slug}</span>
          </span>
        }
      />

      <h1 className="sr-only">agent {agent?.display_name ?? `@${slug}`}</h1>

      {notFound && (
        <ErrorState kind="not_found" what="agent" id={slug} detail={error ?? undefined} />
      )}
      {!notFound && error && (
        <ErrorState kind="error" what="agent" id={slug} detail={error} />
      )}

      {agent && (
        <>
          {/* IDENTITY RIBBON ─────────────────────────────────── */}
          <section className="grid grid-cols-2 md:grid-cols-8 border-b border-[var(--color-border)]">
            <RCell label="handle" value={`@${agent.display_slug}`} />
            <RCell label="name" value={agent.display_name} />
            <RCell label="kind" value={<KindGlyph kind={agent.kind} />} tone={kindTone(agent.kind)} />
            <RCell
              label={
                <FormulaTip
                  label="avg score"
                  formula="avg score = sum(resolved call_score) / resolved calls"
                >
                  {/* Not a 30-day window: the fetch batch is the newest ≤100
                      CALLS and the value averages the scored rows within it.
                      Label + title state that actual window, no date
                      predicate. */}
                  <span title="avg over scored calls within the latest 100">
                    verdict·recent
                  </span>
                </FormulaTip>
              }
              value={stats ? formatScore(stats.avgScore) : "—"}
              tone={(stats?.avgScore ?? 0) >= 0 ? "pos" : "neg"}
            />
            <RCell
              label={
                <FormulaTip label="win rate" formula="win rate = wins / (wins + losses)">
                  wr
                </FormulaTip>
              }
              value={stats ? formatWR(stats.winRate) : "—"}
            />
            <RCell label="res" value={stats ? String(stats.resolved).padStart(2, "0") : "—"} />
            <RCell
              label="pend"
              value={stats ? String(stats.pending).padStart(2, "0") : "—"}
              tone="dim"
            />
            <RCell
              label={
                <FormulaTip
                  label="streak"
                  formula="streak = consecutive wins from newest call until first loss"
                />
              }
              value={stats ? `${stats.streak}w` : "—"}
            />
          </section>

          {/* IDENTITY META + ACTIONS ─────────────────────────── */}
          <div className="flex items-center gap-2 px-2 py-1.5 border-b border-[var(--color-border)] flex-wrap">
            {agent.wallet_address && (
              <OwnerAuthorizedPill explorerUrl={ownerExplorerUrl} />
            )}
            {agent.wallet_address && (
              <a
                href={`https://basescan.org/address/${agent.wallet_address}`}
                target="_blank"
                rel="noreferrer"
                className="ck-mono ck-pos no-underline"
                title={`${agent.wallet_address} on ${humanChain(agent.chain_id)}`}
              >
                {agent.wallet_address.slice(0, 8)}…{agent.wallet_address.slice(-6)}
              </a>
            )}
            <span className="ck-label ck-dim">
              since {agent.created_at.slice(0, 10)}
            </span>
            <span className="ml-auto flex items-center gap-1">
              <a href={`#/share/${agent.display_slug}`} className="ck-btn ck-btn-bracket">
                share
              </a>
              {/* Wave 1 — shadow CLAIM CTA removed alongside the
                  deleted /agents/:slug/claim route. Shadow agents are
                  no longer self-claimable; contact an operator (admin
                  claim CLI lands in Wave 5). */}
            </span>
          </div>

          {agent.bio && (
            <div className="px-2 py-1 border-b border-[var(--color-border)] ck-mono ck-dim leading-tight">
              {agent.bio}
            </div>
          )}

          {/* MAIN GRID ───────────────────────────────────────── */}
          <main className="flex-1 grid grid-cols-1 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,0.8fr)] min-h-0">
            <Panel
              title="call log"
              meta={calls ? `${calls.length}` : ""}
              className="lg:border-r-0"
            >
              {calls === null && <PanelSkeleton rows={6} />}
              {calls !== null && calls.length === 0 && (
                <div className="px-2 py-2 ck-mono ck-dim">[no calls yet]</div>
              )}
              {calls !== null && calls.length > 0 && <CallTable calls={calls} />}
            </Panel>

            <Panel
              title="market heat"
              meta={grid ? `${grid.length} mkts` : ""}
              className="lg:border-r-0"
            >
              {grid === null && <PanelSkeleton rows={5} />}
              {grid !== null && grid.length === 0 && (
                <div className="px-2 py-2 ck-mono ck-dim">[no per-market data]</div>
              )}
              {grid !== null && grid.length > 0 && <GridTable rows={grid} />}
            </Panel>

            <Panel title="detail · scores">
              <SidebarStats stats={stats} agent={agent} />
            </Panel>
          </main>
        </>
      )}
    </div>
  );
}

function CallTable({ calls }: { calls: AgentCallRow[] }) {
  const { open } = useDetailDrawer();
  return (
    <ul className="m-0 p-0 list-none">
      <li className="grid grid-cols-[104px_14px_1fr_50px_30px] gap-1.5 items-center px-2 py-1 border-b border-[var(--color-border-vis)] ck-colhead">
        <span>time</span>
        <span aria-hidden="true"></span>
        <span>note<span className="sr-only"> (each row sealed)</span></span>
        <span className="text-right">out</span>
        <span aria-hidden="true"></span>
      </li>
      {calls.map((c) => {
        const ts = formatTs(c.submitted_at ?? c.accepted_at);
        // Pending Fhenix-sealed verdicts are not public; the compact row
        // stays blind until the post-horizon reveal. A single seal glyph
        // signals "sealed/private" without the three-token placeholder noise.
        const note = formatNote(c);
        const outLabel = formatOutcome(c);
        return (
          <li
            key={c.call_id}
            className="relative grid grid-cols-[104px_14px_1fr_50px_30px] gap-1.5 items-center px-2 py-[3px] border-b border-[var(--color-border)] ck-hoverable"
          >
            {/* Stretched row link — a real box (unlike display:contents) so
                keyboard focus lands and the ring outlines the whole row. */}
            <a
              href={`#/calls/${c.call_id}`}
              aria-label={`open call ${c.call_id.slice(0, 8)} · ${outLabel}`}
              onClick={(e) => {
                if (isPlainLeftClick(e)) {
                  e.preventDefault();
                  open("call", c.call_id);
                }
              }}
              className="ck-rowlink"
            />
            <span className="ck-mono ck-dim truncate">{ts}</span>
            <span aria-hidden="true" className="ck-dim">▪</span>
            <span className="ck-mono ck-dim truncate">{note}</span>
            <span
              className={
                "ck-mono text-right " +
                (c.outcome === "win"
                  ? "ck-pos"
                  : c.outcome === "loss"
                    ? "ck-neg"
                    : "ck-dim")
              }
            >
              {outLabel}
            </span>
            <VerifyCallLink callId={c.call_id} />
          </li>
        );
      })}
    </ul>
  );
}

function VerifyCallLink({ callId }: { callId: string }) {
  const shortId = callId.slice(0, 8);
  return (
    <a
      href={`#/calls/${callId}`}
      aria-label={`verify call ${shortId}`}
      className={
        // relative z-[1] lifts the chip above the row's stretched link overlay.
        "t-meta ck-mono relative z-[1] justify-self-end border border-[var(--color-border-vis)] px-1 " +
        "text-[9px] leading-[14px] text-[var(--color-secondary)] no-underline " +
        "hover:bg-[var(--color-display)] hover:text-[var(--color-bg)] " +
        "hover:border-[var(--color-display)]"
      }
    >
      [V]
    </a>
  );
}

function GridTable({ rows }: { rows: AgentMarketRow[] }) {
  const { open } = useDetailDrawer();
  return (
    <ul className="m-0 p-0 list-none">
      <li className="grid grid-cols-[1fr_58px_44px_56px] gap-1.5 items-center px-2 py-1 border-b border-[var(--color-border-vis)] ck-colhead">
        <span>market</span>
        <span className="text-right">vs</span>
        <span className="text-right">wr</span>
        <span className="text-right">trend</span>
      </li>
      {rows.map((r) => (
        <li
          key={r.market_id}
          className="relative grid grid-cols-[1fr_58px_44px_56px] gap-1.5 items-center px-2 py-[3px] border-b border-[var(--color-border)] ck-hoverable"
        >
          <a
            href={`#/markets/${encodeURIComponent(r.market_id)}`}
            aria-label={`open market ${r.market_id}`}
            onClick={(e) => {
              if (isPlainLeftClick(e)) {
                e.preventDefault();
                open("market", r.market_id);
              }
            }}
            className="ck-rowlink"
          />
          <span className="ck-mono ck-pos truncate">{r.market_id}</span>
          <span
            className={
              "ck-mono text-right " +
              ((r.verdict_score ?? 0) >= 0 ? "ck-pos" : "ck-neg")
            }
          >
            {formatScore(r.verdict_score)}
          </span>
          <span className="ck-mono ck-dim text-right">
            {r.win_rate === null ? "—" : Math.round(r.win_rate * 100)}
          </span>
          <span className="flex justify-end">
            <CompactSparkline
              values={
                r.call_scores?.filter((s): s is number => s !== null) ?? []
              }
              width={56}
              height={12}
            />
          </span>
        </li>
      ))}
    </ul>
  );
}

interface AgentStats {
  total: number;
  resolved: number;
  wins: number;
  losses: number;
  voids: number;
  pending: number;
  failed: number;
  other: number;
  winRate: number | null;
  avgScore: number | null;
  streak: number;
}

function OwnerAuthorizedPill({ explorerUrl }: { explorerUrl: string | null }) {
  const className =
    "ck-mono inline-flex items-center gap-1 border border-[var(--color-border-vis)] " +
    "px-1.5 py-[1px] text-[9px] leading-tight lowercase text-[var(--color-secondary)] " +
    "no-underline hover:bg-[var(--color-display)] hover:text-[var(--color-bg)] " +
    "hover:border-[var(--color-display)]";

  const content = (
    <>
      <span>owner verified</span>
      {explorerUrl && (
        <svg
          aria-hidden="true"
          viewBox="0 0 8 8"
          className="h-2 w-2"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.2"
        >
          <path d="M2 1.5 5 4 2 6.5" />
        </svg>
      )}
    </>
  );

  if (!explorerUrl) {
    return (
      <span className={className} title="controller wallet is bound to this public profile">
        {content}
      </span>
    );
  }

  return (
    <a
      href={explorerUrl}
      target="_blank"
      rel="noreferrer"
      className={className}
      title="controller wallet is bound to this public profile"
    >
      {content}
    </a>
  );
}

function SidebarStats({
  stats,
  agent,
}: {
  stats: AgentStats | null;
  agent: AgentProfile;
}) {
  return (
    <div className="flex flex-col">
      <FactRow label="wins" value={stats ? String(stats.wins) : "—"} tone="pos" />
      <FactRow label="losses" value={stats ? String(stats.losses) : "—"} tone="neg" />
      {/* void = settled-but-unscored (void / oracle_unavailable); failed =
          terminal reveal/rejection failures; other = non-outcome rows outside
          the canonical pending set (submitted, preflighted, unresolved
          disputed). All three are excluded from the verdict average, win rate
          AND the pend count, so each gets its own dim tally. */}
      <FactRow label="void" value={stats ? String(stats.voids) : "—"} tone="dim" />
      <FactRow label="failed" value={stats ? String(stats.failed) : "—"} tone="dim" />
      <FactRow label="other" value={stats ? String(stats.other) : "—"} tone="dim" />
      <FactRow
        label="verdict"
        value={stats ? formatScore(stats.avgScore) : "—"}
        tone={(stats?.avgScore ?? 0) >= 0 ? "pos" : "neg"}
      />
      <FactRow label="wr" value={stats ? formatWR(stats.winRate) : "—"} />
      <FactRow label="streak" value={stats ? `${stats.streak}w` : "—"} />
      <FactRow label="total" value={stats ? String(stats.total) : "—"} tone="dim" />
      <FactRow label="kind" value={<KindGlyph kind={agent.kind} />} tone="dim" />
      <FactRow
        label="chain"
        value={humanChain(agent.chain_id)}
        tone="dim"
      />
      <div className="px-2 py-2 ck-mono ck-dim leading-tight border-t border-[var(--color-border)]">
        {/* Wave 3 — collapsed enum. shadow/verified notes dropped alongside
            the deleted tiers. `agent` is the canonical Privy-owned default
            and gets the main-tier-eligible note. */}
        {agent.kind === "agent" && (
          <span>agent · owned through Privy · can reach the main tier</span>
        )}
        {agent.kind === "benchmark" && (
          <span>benchmark · a comparison agent we maintain</span>
        )}
        {agent.kind === "attested" && (
          <span>attested · backed by an Olas bond · sentinel tier</span>
        )}
        {agent.kind === "internal_test" && (
          <span>internal · test agent, operators only</span>
        )}
      </div>
    </div>
  );
}

function FactRow({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: ReactNode;
  tone?: "pos" | "neg" | "dim" | "default";
}) {
  const toneClass =
    tone === "pos" ? "ck-pos" : tone === "neg" ? "ck-neg" : tone === "dim" ? "ck-dim" : "ck-pos";
  return (
    <div className="grid grid-cols-[60px_1fr] items-center px-2 py-1 border-b border-[var(--color-border)]">
      <span className="ck-label">{label}</span>
      <span
        className={"ck-mono ck-value-sm text-right " + toneClass}
      >
        {value}
      </span>
    </div>
  );
}

function RCell({
  label,
  value,
  tone = "default",
}: {
  label: ReactNode;
  value: ReactNode;
  tone?: "pos" | "neg" | "dim" | "default";
}) {
  const toneClass =
    tone === "pos" ? "ck-pos" : tone === "neg" ? "ck-neg" : tone === "dim" ? "ck-dim" : "ck-pos";
  // Only string/number values get a native hover title — a glyph value carries
  // its own tooltip and would stringify to "[object Object]".
  const title =
    typeof value === "string" || typeof value === "number" ? String(value) : undefined;
  return (
    <div className="px-2 py-1.5 border-r border-[var(--color-border)] flex flex-col gap-0.5 min-w-0">
      <span className="ck-label">{label}</span>
      <span
        className={"ck-mono ck-value truncate " + toneClass}
        title={title}
      >
        {value}
      </span>
    </div>
  );
}

function kindTone(kind: AgentProfile["kind"]): "pos" | "neg" | "dim" | "default" {
  // Wave 3 — `agent` is the canonical Privy-owned default and reads as
  // the positive tone; `attested` is the sentinel (red) tier; everything
  // else (benchmark, internal_test, stale legacy values) reads dim.
  if (kind === "agent") return "pos";
  if (kind === "attested") return "neg";
  return "dim";
}

function humanChain(chainId: string | null | undefined): string {
  // CAIP-2 → human label. Base is the canonical deploy target.
  const id = chainId ?? "eip155:8453";
  if (id === "eip155:8453") return "BASE";
  if (id === "eip155:84532") return "BASE SEPOLIA";
  return id.toUpperCase();
}

function blockExplorerAddressUrl(address: string, chainId: string): string | null {
  if (chainId === "eip155:8453") return `https://basescan.org/address/${address}`;
  if (chainId === "eip155:84532") return `https://sepolia.basescan.org/address/${address}`;
  return null;
}

function formatWR(wr: number | null): string {
  return wr === null ? "—" : `${Math.round(wr * 100)}%`;
}

function formatTs(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) {
    return d.toISOString().slice(11, 19);
  }
  return iso.slice(5, 10) + " " + iso.slice(11, 16);
}

function formatNote(c: AgentCallRow): string {
  // Pending calls expose only the commit anchor; resolved calls may expose
  // the public outcome label.
  if (c.commit_hash) return `commit ${c.commit_hash.slice(0, 8)}`;
  if (!c.outcome) return "encrypted";
  if (c.outcome === "void") return "void";
  return c.outcome;
}

function formatOutcome(c: AgentCallRow): string {
  if (!c.outcome) return "pend";
  if (c.outcome === "win" && c.call_score !== null && c.call_score !== undefined) {
    return `+${c.call_score.toFixed(2)}`;
  }
  if (c.outcome === "loss" && c.call_score !== null && c.call_score !== undefined) {
    return c.call_score < 0 ? c.call_score.toFixed(2) : `−${c.call_score.toFixed(2)}`;
  }
  return c.outcome.slice(0, 4);
}
