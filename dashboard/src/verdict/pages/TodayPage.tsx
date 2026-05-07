import { useEffect, useState } from "react";
import { verdictApi, type TodayFeed, type TodayFeedRow } from "../api.js";
import { Topbar } from "../components/Topbar.js";
import { OutcomeChip } from "../components/OutcomeChip.js";
import { side as sideTokens } from "../ui/tokens.js";

/**
 * Today tape — every call accepted or resolved in the last 24h. SSE-fed
 * via /v1/feed/today on first paint, then live via the stream. Pure
 * tabular, no animations.
 */
export function TodayPage() {
  const [feed, setFeed] = useState<TodayFeed | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    verdictApi
      .todayFeed()
      .then((r) => {
        if (!cancelled) setFeed(r);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="min-h-dvh flex flex-col bg-[var(--color-bg)] text-[var(--color-primary)]">
      <Topbar crumb="today" />

      <main className="flex-1 max-w-[1280px] w-full mx-auto px-6 md:px-10 py-12">
        <header className="mb-8">
          <p className="t-label text-[var(--color-secondary)] mb-3">today · last 24h</p>
          <h1 className="t-heading max-w-[36ch]">
            every call <span className="text-[var(--color-display)]">resolved</span> against an oracle.
          </h1>
        </header>

        {error && (
          <div className="border border-[var(--color-accent)] px-6 py-12 t-body-sm text-[var(--color-accent)]">
            [ERROR] {error}
          </div>
        )}

        {!error && !feed && (
          <div className="px-6 py-24 t-meta text-[var(--color-disabled)]">[loading …]</div>
        )}

        {feed && (
          <>
            <Stats feed={feed} />
            <FeedSection title="LIVE · PENDING" rows={feed.pending_resolution} pending />
            <FeedSection title="RESOLVED · LAST 24H" rows={feed.resolved_recent} />
            <FeedSection title="ACCEPTED · LAST 24H" rows={feed.accepted_recent} />
          </>
        )}
      </main>
    </div>
  );
}

function Stats({ feed }: { feed: TodayFeed }) {
  return (
    <dl className="grid grid-cols-2 md:grid-cols-5 border-y border-[var(--color-border)] mb-12">
      <Cell label="accepted" value={feed.totals.accepted_24h} />
      <Cell label="resolved" value={feed.totals.resolved_24h} />
      <Cell label="wins" value={feed.totals.wins_24h} />
      <Cell label="losses" value={feed.totals.losses_24h} accent={feed.totals.losses_24h > 0} />
      <Cell label="void" value={feed.totals.void_24h} />
    </dl>
  );
}

function Cell({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div className="px-6 py-4 border-r border-[var(--color-border)] last:border-r-0 flex flex-col gap-3">
      <dt className="t-label">{label}</dt>
      <dd className={"t-stat-num m-0 " + (accent ? "text-[var(--color-accent)]" : "")}>
        {value.toString().padStart(2, "0")}
      </dd>
    </div>
  );
}

function FeedSection({
  title,
  rows,
  pending,
}: {
  title: string;
  rows: TodayFeedRow[];
  pending?: boolean;
}) {
  if (rows.length === 0) return null;
  return (
    <section className="border-y border-[var(--color-border)] mb-8">
      <div className="px-6 py-3 t-label">{title}</div>
      <ul className="m-0 p-0 list-none">
        {rows.map((row, i) => (
          <li
            key={row.call_id}
            className={
              "grid grid-cols-[110px_70px_60px_90px_1fr_100px] gap-4 px-6 py-3 items-center " +
              (i > 0 ? "border-t border-[var(--color-border)] " : "")
            }
          >
            <a href={`#/calls/${row.call_id}`} className="contents no-underline press-feedback">
              <span className="t-data text-[var(--color-secondary)]">
                {row.submitted_at.slice(11, 19)}
              </span>
              <span className={"t-button " + (row.side === "SELL" ? sideTokens.sell : sideTokens.buy)}>
                {row.side}
              </span>
              <span className="t-data text-[var(--color-display)]">
                {row.asset_id.split(":").pop() ?? row.asset_id}
              </span>
              <span className="t-data text-[var(--color-secondary)]">
                {row.horizon_hours}H · {(row.confidence * 100).toFixed(0)}%
              </span>
              <span className="t-body-sm text-[var(--color-secondary)]">
                @{row.agent_slug}
              </span>
              <span className="text-right">
                <OutcomeChip outcome={pending ? "live" : row.outcome ?? "live"}>
                  {pending
                    ? "PEND"
                    : row.call_score !== null && row.call_score !== undefined
                    ? `${row.call_score >= 0 ? "+" : ""}${row.call_score.toFixed(3)}`
                    : (row.outcome ?? "live").toUpperCase()}
                </OutcomeChip>
              </span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
