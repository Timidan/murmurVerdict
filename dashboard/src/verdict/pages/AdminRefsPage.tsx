import { useEffect, useState } from "react";
import { verdictApi, ApiError, type AdminRefSender } from "../api.js";
import { readAdminToken, writeAdminToken, clearAdminToken } from "../admin-session.js";
import { TopbarCrumb } from "../components/compact/TopbarCrumb.js";
import { Panel } from "../components/compact/Panel.js";
import { InlineError } from "../components/compact/InlineError.js";
import { TimeAgo } from "../components/compact/TimeAgo.js";
import { LogoLoader } from "../components/LogoLoader.js";

const REFS_CRUMB = (
  <span>
    admin <span className="ck-dim mx-1">/</span>
    <span className="ck-pos">refs</span>
  </span>
);

/**
 * /#/admin/refs: token-gated sender board (first 200 senders) with per-row delete.
 * The token is sent as the X-Admin-Token header, never in a request URL.
 */
export function AdminRefsPage() {
  const [token, setToken] = useState<string>(() => readAdminToken());
  const [tokenInput, setTokenInput] = useState("");
  const [rows, setRows] = useState<AdminRefSender[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    let cancel = false;
    setError(null);
    setRows(null);
    verdictApi
      .adminRefs(token, { limit: 200 })
      .then((j) => {
        if (!cancel) setRows(j.senders);
      })
      .catch((e) => {
        if (!cancel) {
          setError(
            e instanceof ApiError && e.status === 403
              ? "admin token rejected"
              : (e as Error).message,
          );
        }
      });
    return () => {
      cancel = true;
    };
  }, [token]);

  const submit = () => {
    if (!tokenInput) return;
    writeAdminToken(tokenInput);
    setToken(tokenInput);
    setTokenInput("");
  };

  const remove = async (ref: string) => {
    setBusy(ref);
    try {
      await verdictApi.adminDeleteRef(token, ref);
      setRows((prev) => prev?.filter((row) => row.ref !== ref) ?? null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const signOut = () => {
    clearAdminToken();
    setToken("");
    setRows(null);
  };

  if (!token) return <TokenPrompt value={tokenInput} onChange={setTokenInput} onSubmit={submit} error={error} />;

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <TopbarCrumb>{REFS_CRUMB}</TopbarCrumb>

      {/* INTRO STRIP ─────────────────────────────────── */}
      <section className="border-b border-[var(--color-border)] px-3 py-3 flex items-center justify-between gap-4 flex-wrap">
        <div className="flex flex-col gap-1">
          <span className="ck-title">full attribution data</span>
          <span className="ck-mono ck-dim">
            admin · sender board · the first 200 senders, with per-row delete
          </span>
        </div>
        <button onClick={signOut} className="ck-btn ck-btn-bracket">
          sign out
        </button>
      </section>

      <main className="flex-1 min-h-0 flex flex-col">
        <Panel title="sender board" meta={rows ? `${rows.length}` : ""}>
          {error && <InlineError error={error} className="px-2 py-2 ck-mono" />}

          {!rows && !error && (
            <div className="px-3 py-8 flex justify-center"><LogoLoader width={300} /></div>
          )}

          {rows && rows.length === 0 && (
            <div className="px-3 py-8 max-w-[70ch] flex flex-col gap-2">
              <span className="ck-label ck-pos">no sender data yet</span>
              <span className="ck-mono ck-dim">
                Refs accumulate as visitors land on{" "}
                <code className="ck-pos">/share/&lt;slug&gt;?ref=&lt;handle&gt;</code> URLs from outreach DMs.
              </span>
            </div>
          )}

          {rows && rows.length > 0 && (
            /* min-w: fixed tracks take 664px; without it the sender column collapses. */
            <ul className="m-0 p-0 list-none min-w-[860px]">
              <li className={COLS + " border-b border-[var(--color-border-vis)] ck-colhead"}>
                <span>rank</span>
                <span>sender</span>
                <span className="text-right">clicks</span>
                <span className="text-right">claims</span>
                <span className="text-right">agents</span>
                <span className="text-right">last seen</span>
                <span className="text-right">actions</span>
              </li>
              {rows.map((r, i) => (
                <li key={r.ref} className={COLS + " border-b border-[var(--color-border)]"}>
                  <span className="ck-mono ck-dim tabular-nums">{i + 1}</span>
                  <a
                    href={`https://x.com/${r.ref}`}
                    target="_blank"
                    rel="noreferrer"
                    className="ck-mono ck-pos no-underline truncate"
                  >
                    @{r.ref}
                  </a>
                  <span className="ck-mono ck-pos text-right tabular-nums">{r.total}</span>
                  <span
                    className={
                      "ck-mono text-right tabular-nums " +
                      (r.converted > 0 ? "ck-pos" : "ck-dim")
                    }
                  >
                    {r.converted}
                  </span>
                  <span className="ck-mono ck-dim text-right tabular-nums">{r.agents_touched}</span>
                  <TimeAgo iso={r.last_at} className="ck-mono ck-dim text-right" />
                  <span className="text-right">
                    <button
                      onClick={() => remove(r.ref)}
                      disabled={busy === r.ref}
                      className="ck-btn ck-btn-bracket ck-btn-accent"
                    >
                      {busy === r.ref ? "…" : "delete"}
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </main>
    </div>
  );
}

const COLS =
  "grid grid-cols-[40px_1fr_120px_100px_100px_140px_100px] gap-2 items-center px-2 py-1.5";

function TokenPrompt({
  value,
  onChange,
  onSubmit,
  error,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  error: string | null;
}) {
  return (
    <div className="flex-1 flex flex-col min-h-0">
      <TopbarCrumb>{REFS_CRUMB}</TopbarCrumb>
      <main className="flex-1 min-h-0 flex flex-col">
        <Panel title="admin token" meta="locked">
          <div className="px-3 py-3 max-w-[70ch] flex flex-col gap-3">
            <span className="ck-label ck-pos">paste the admin token to continue</span>
            <span className="ck-mono ck-dim">
              Reads from <code className="ck-pos">VERDICT_ADMIN_TOKEN</code> on the daemon. Never
              shared in URLs after first paste — stored in localStorage and sent
              as <code className="ck-pos">X-Admin-Token</code>.
            </span>

            {error && <InlineError error={error} className="px-2 py-2 ck-mono" />}

            <form
              onSubmit={(e) => {
                e.preventDefault();
                onSubmit();
              }}
              className="flex flex-col gap-3"
            >
              <label htmlFor="admin-token" className="ck-label">admin token</label>
              <input
                id="admin-token"
                type="password"
                value={value}
                onChange={(e) => onChange(e.target.value)}
                className="bg-transparent border-b border-[var(--color-border-vis)] py-2 ck-mono ck-pos focus:outline-none focus:border-[var(--color-display)]"
                placeholder="VERDICT_ADMIN_TOKEN"
                autoFocus
              />
              <button type="submit" className="ck-btn ck-btn-bracket ck-pos self-start">
                unlock
              </button>
            </form>
          </div>
        </Panel>
      </main>
    </div>
  );
}
