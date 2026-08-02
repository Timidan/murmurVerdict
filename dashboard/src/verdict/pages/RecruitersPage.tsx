import { useEffect, useRef, useState } from "react";
import { verdictApi } from "../api.js";
import { CompactTopbar } from "../components/compact/Topbar.js";
import { Panel } from "../components/compact/Panel.js";

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
 * Sharers compete on (clicks × agents touched). Compact cockpit idiom —
 * CompactTopbar + hairline Panel + ck-* type scale, matching the leaderboard.
 * Rows link out to the sharer's X profile so a click on a row credits the
 * sharer further.
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
    <div className="mmr-shell min-h-dvh flex flex-col">
      <CompactTopbar
        crumb={
          <span>
            recruiters <span className="ck-dim mx-1">/</span>
            <span className="ck-pos">attribution</span>
          </span>
        }
      />

      {/* INTRO STRIP ─────────────────────────────────── */}
      <section className="border-b border-[var(--color-border)] px-3 py-3 flex flex-col gap-1">
        <span className="ck-title">who&rsquo;s bringing the agents in</span>
        <span className="ck-mono ck-dim">
          every share-page click with a <code className="ck-pos">?ref=</code>{" "}
          param is bucketed by sender · sharers compete on clicks × agents
          touched
        </span>
        <RefLinkHelper />
      </section>

      <main className="flex-1 min-h-0 flex flex-col">
        <Panel title="sender ladder" meta={rows ? `${rows.length}` : ""}>
          {error && <div className="px-2 py-2 ck-mono ck-neg">[error] {error}</div>}
          {!error && rows === null && <LoadingRows />}
          {!error && rows && rows.length === 0 && <EmptyState />}
          {!error && rows && rows.length > 0 && <Table rows={rows} />}
        </Panel>
      </main>
    </div>
  );
}

/** Lowercase-slug sanitizer: keep [a-z0-9_-], drop everything else. */
function sanitizeHandle(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9_-]/g, "");
}

/**
 * Inline "copy your ref" helper. Copies the `?ref=<handle>` SUFFIX rather
 * than a full templated /share/<agent> URL: agent slugs vary per share, so
 * a suffix that appends to any share link beats a template whose literal
 * <agent> placeholder pastes as a broken URL.
 */
function RefLinkHelper() {
  const [handle, setHandle] = useState("");
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, []);

  const suffix = `?ref=${handle}`;

  const copy = () => {
    if (!handle) return;
    try {
      // navigator.clipboard is undefined on insecure origins — the visible
      // suffix doubles as the manual-copy fallback, so failures are no-ops.
      void navigator.clipboard?.writeText(suffix)?.then(
        () => {
          setCopied(true);
          if (timer.current !== null) window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => setCopied(false), 1500);
        },
        () => {},
      );
    } catch {
      // clipboard unavailable — nothing to do
    }
  };

  return (
    <div className="flex items-center gap-2 flex-wrap pt-1.5">
      <input
        value={handle}
        onChange={(e) => setHandle(sanitizeHandle(e.target.value))}
        placeholder="your-handle"
        aria-label="your handle"
        className="w-[160px] bg-transparent border border-[var(--color-border-vis)] px-2 py-1 ck-mono ck-pos focus:outline-none focus:border-[var(--color-display)]"
      />
      <button className="ck-btn ck-btn-bracket" onClick={copy} disabled={!handle}>
        {copied ? "copied ✓" : "copy link"}
      </button>
      <span className="ck-mono ck-dim">
        {handle ? (
          <>
            <code className="ck-pos">{suffix}</code> → append to any share
            link you send
          </>
        ) : (
          <>type your handle to build your ?ref= suffix</>
        )}
      </span>
    </div>
  );
}

const COLS =
  "grid grid-cols-[44px_1fr_130px_80px_80px_130px] gap-2 items-center px-2 py-1.5";

function Table({ rows }: { rows: Sender[] }) {
  const max = rows.reduce((m, r) => Math.max(m, r.total), 0) || 1;
  return (
    <ul className="m-0 p-0 list-none">
      <li className={COLS + " border-b border-[var(--color-border-vis)] ck-colhead"}>
        <span>#</span>
        <span>sender</span>
        <span className="text-right">clicks</span>
        <span className="text-right">claims</span>
        <span className="text-right">agents</span>
        <span className="text-right">last seen</span>
      </li>
      {rows.map((r, i) => (
        <li key={r.ref}>
          <a
            href={`https://x.com/${r.ref}`}
            target="_blank"
            rel="noreferrer"
            className={
              COLS +
              " no-underline border-b border-[var(--color-border)] " +
              "hover:bg-[color-mix(in_srgb,var(--color-primary),transparent_97%)] " +
              "transition-colors duration-[var(--dur-fast)] ease-out"
            }
          >
            <span className="ck-mono ck-dim tabular-nums">
              {String(i + 1).padStart(2, "0")}
            </span>
            <span className="ck-mono ck-pos truncate">@{r.ref}</span>
            <span className="flex items-center gap-2 justify-end">
              <span className="hidden md:block w-[64px] h-[6px] bg-[var(--color-border)] relative">
                <span
                  className="absolute inset-y-0 left-0 bg-[var(--color-display)]"
                  style={{
                    width: `${Math.max(2, Math.round((r.total / max) * 100))}%`,
                  }}
                />
              </span>
              <span className="ck-mono ck-pos tabular-nums">{r.total}</span>
            </span>
            <span
              className={
                "ck-mono text-right tabular-nums " +
                (r.converted > 0 ? "ck-pos" : "ck-dim")
              }
            >
              {r.converted}
            </span>
            <span className="ck-mono ck-dim text-right tabular-nums">
              {r.agents_touched}
            </span>
            <span className="ck-mono ck-dim text-right">
              {r.last_at?.slice(5, 16).replace("T", " ") ?? "—"}
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}

function LoadingRows() {
  return (
    <div className="opacity-50">
      {Array.from({ length: 8 }).map((_, i) => (
        <div
          key={i}
          className={COLS.replace("items-center ", "") + " border-b border-[var(--color-border)]"}
        >
          {Array.from({ length: 6 }).map((__, j) => (
            <div key={j} className="h-3 bg-[var(--color-surface)] rounded-sm" />
          ))}
        </div>
      ))}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="px-3 py-8 max-w-[70ch] flex flex-col gap-2">
      <span className="ck-label ck-pos">no senders yet</span>
      <span className="ck-mono ck-dim">
        share an agent profile with{" "}
        <code className="ck-pos">?ref=&lt;your-handle&gt;</code> on the URL —
        every click that lands here from your DM is attributed to you on this
        board.
      </span>
    </div>
  );
}
