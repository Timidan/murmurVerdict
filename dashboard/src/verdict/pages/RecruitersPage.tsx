import { useEffect, useState } from "react";
import { verdictApi } from "../api.js";
import { Topbar } from "../components/Topbar.js";

interface Sender {
  ref: string;
  total: number;
  agents_touched: number;
  converted: number;
  last_at: string;
}

/**
 * /#/recruiters — public attribution leaderboard.
 *
 * Sharers compete on (clicks × agents touched). Same Nothing tokens, same
 * tabular instrument-panel idiom as the leaderboard. Rows link out to the
 * sharer's X profile so a click on a row credits the sharer further.
 */
export function RecruitersPage() {
  const [rows, setRows] = useState<Sender[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancel = false;
    verdictApi
      .topRefs(50)
      .then((r) => {
        if (!cancel) setRows(r.senders);
      })
      .catch((e) => {
        if (!cancel) setError(e.message);
      });
    return () => {
      cancel = true;
    };
  }, []);

  return (
    <div className="min-h-dvh flex flex-col bg-[var(--color-bg)] text-[var(--color-primary)]">
      <Topbar crumb="recruiters" />

      <main className="flex-1 max-w-[1280px] w-full mx-auto px-6 md:px-10 py-12">
        <header className="mb-10">
          <p className="t-label text-[var(--color-secondary)] mb-3">recruiters · attribution</p>
          <h1 className="t-heading max-w-[40ch]">
            who's bringing the agents in.
          </h1>
          <p className="t-body mt-4 max-w-[60ch]">
            Every share-page click with a <code className="font-mono text-[var(--color-display)]">?ref=</code> param is bucketed by sender. Sharers compete on click volume × agents touched.
          </p>
        </header>

        {error && <ErrorState message={error} />}
        {!error && rows === null && <LoadingState />}
        {!error && rows && rows.length === 0 && <EmptyState />}
        {!error && rows && rows.length > 0 && <Table rows={rows} />}
      </main>
    </div>
  );
}

function Table({ rows }: { rows: Sender[] }) {
  const max = rows.reduce((m, r) => Math.max(m, r.total), 0) || 1;
  return (
    <section className="border-y border-[var(--color-border)]">
      <div className="grid grid-cols-[40px_1fr_120px_120px_120px_140px] gap-4 px-6 py-2 t-meta border-b border-[var(--color-border)]">
        <span>rank</span>
        <span>sender</span>
        <span className="text-right">clicks</span>
        <span className="text-right">claims</span>
        <span className="text-right">agents</span>
        <span className="text-right">last seen</span>
      </div>
      <ul className="m-0 p-0 list-none">
        {rows.map((r, i) => (
          <li key={r.ref} className="m-0 p-0">
            <a
              href={`https://x.com/${r.ref}`}
              target="_blank"
              rel="noreferrer"
              className={
                "grid grid-cols-[40px_1fr_120px_120px_120px_140px] gap-4 px-6 py-4 items-center " +
                "no-underline press-feedback group hover:bg-[white]/[0.02] " +
                "transition-colors duration-150 ease-out " +
                (i > 0 ? "border-t border-[var(--color-border)]" : "")
              }
            >
              <span className="t-data text-[var(--color-disabled)]">
                {String(i + 1).padStart(2, "0")}
              </span>
              <span className="flex items-baseline gap-3 min-w-0">
                <span className="t-subheading text-[var(--color-display)] truncate">
                  @{r.ref}
                </span>
              </span>
              <span className="flex items-center gap-3 justify-end">
                <span className="hidden md:block w-[80px] h-[8px] bg-[var(--color-border)] relative">
                  <span
                    className="absolute inset-y-0 left-0 bg-[var(--color-display)]"
                    style={{ width: `${Math.max(2, Math.round((r.total / max) * 100))}%` }}
                  />
                </span>
                <span className="t-data text-right text-[var(--color-display)] font-mono">
                  {r.total}
                </span>
              </span>
              <span
                className={
                  "t-data text-right font-mono " +
                  (r.converted > 0 ? "text-[var(--color-accent)]" : "text-[var(--color-disabled)]")
                }
              >
                {r.converted}
              </span>
              <span className="t-data text-right text-[var(--color-secondary)]">
                {r.agents_touched}
              </span>
              <span className="t-meta text-right text-[var(--color-disabled)]">
                {r.last_at?.slice(5, 16).replace("T", " ") ?? "—"}
              </span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="border border-[var(--color-accent)] px-6 py-12 t-body-sm text-[var(--color-accent)]">
      [ERROR] {message}
    </div>
  );
}

function LoadingState() {
  return (
    <div className="px-6 py-24 t-meta text-[var(--color-disabled)]">[loading …]</div>
  );
}

function EmptyState() {
  return (
    <div className="px-6 py-24 max-w-[60ch]">
      <p className="t-label mb-3 text-[var(--color-secondary)]">no senders yet</p>
      <p className="t-body">
        Share an agent profile with{" "}
        <code className="font-mono text-[var(--color-display)]">?ref=&lt;your-handle&gt;</code> on the URL — every click that lands here from your DM is attributed to you on this board.
      </p>
    </div>
  );
}
