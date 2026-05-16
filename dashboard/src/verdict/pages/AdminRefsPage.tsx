import { useEffect, useState } from "react";
import { verdictApi } from "../api.js";
import { Topbar } from "../components/Topbar.js";
import { PillButton } from "../components/PillButton.js";

interface FullSender {
  ref: string;
  total: number;
  agents_touched: number;
  converted: number;
  last_at: string;
}

const TOKEN_KEY = "murmur-verdict.admin-token.v1";

/**
 * /#/admin/refs — token-gated full sender board.
 *
 * Mirrors /#/recruiters but with admin-only data (full unfiltered list)
 * and per-row delete actions. The token is read from ?token=<...> on
 * first visit and persisted to localStorage so the operator doesn't
 * paste it on every refresh. Token never enters the request URL —
 * always sent as X-Admin-Token header.
 */
export function AdminRefsPage() {
  const [token, setToken] = useState<string>(() => readToken());
  const [tokenInput, setTokenInput] = useState("");
  const [rows, setRows] = useState<FullSender[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    let cancel = false;
    setError(null);
    setRows(null);
    fetch(`${verdictApi.apiUrl.replace(/\/$/, "")}/v1/refs?limit=200`, {
      headers: { "X-Admin-Token": token },
    })
      .then(async (r) => {
        if (r.status === 403) throw new Error("admin token rejected");
        if (!r.ok) throw new Error(`/v1/refs → ${r.status}`);
        const j = (await r.json()) as { senders: FullSender[] };
        if (!cancel) setRows(j.senders);
      })
      .catch((e) => {
        if (!cancel) setError((e as Error).message);
      });
    return () => {
      cancel = true;
    };
  }, [token]);

  const submit = () => {
    if (!tokenInput) return;
    writeToken(tokenInput);
    setToken(tokenInput);
    setTokenInput("");
  };

  const remove = async (ref: string) => {
    setBusy(ref);
    try {
      const r = await fetch(
        `${verdictApi.apiUrl.replace(/\/$/, "")}/v1/refs/${encodeURIComponent(ref)}`,
        { method: "DELETE", headers: { "X-Admin-Token": token } },
      );
      if (!r.ok) throw new Error(`DELETE → ${r.status}`);
      setRows((prev) => prev?.filter((row) => row.ref !== ref) ?? null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const signOut = () => {
    writeToken("");
    setToken("");
    setRows(null);
  };

  if (!token) return <TokenPrompt value={tokenInput} onChange={setTokenInput} onSubmit={submit} error={error} />;

  return (
    <div className="min-h-dvh flex flex-col bg-[var(--color-bg)] text-[var(--color-primary)]">
      <Topbar crumb="admin · refs" />

      <main className="flex-1 max-w-[1280px] w-full mx-auto px-6 md:px-10 py-12">
        <header className="mb-10 flex items-baseline justify-between flex-wrap gap-4">
          <div>
            <p className="t-label text-[var(--color-secondary)] mb-3">admin · sender board</p>
            <h1 className="t-heading" style={{ textWrap: "balance" }}>full attribution data.</h1>
          </div>
          <PillButton variant="secondary" onClick={signOut}>sign out</PillButton>
        </header>

        {error && (
          <div className="border border-[var(--color-accent)] px-6 py-4 mb-8 t-body-sm text-[var(--color-accent)]">
            [ERROR] {error}
          </div>
        )}

        {!rows && !error && (
          <div className="px-6 py-24 t-meta text-[var(--color-disabled)]">[loading …]</div>
        )}

        {rows && rows.length === 0 && (
          <div className="px-6 py-24 max-w-[60ch]">
            <p className="t-label mb-3 text-[var(--color-secondary)]">no sender data yet</p>
            <p className="t-body">
              Refs accumulate as visitors land on{" "}
              <code className="font-mono text-[var(--color-display)]">/share/&lt;slug&gt;?ref=&lt;handle&gt;</code> URLs from outreach DMs.
            </p>
          </div>
        )}

        {rows && rows.length > 0 && (
          <section className="border-y border-[var(--color-border)]">
            <div className="grid grid-cols-[40px_1fr_120px_100px_100px_140px_100px] gap-4 px-6 py-2 t-meta border-b border-[var(--color-border)]">
              <span>rank</span>
              <span>sender</span>
              <span className="text-right">clicks</span>
              <span className="text-right">claims</span>
              <span className="text-right">agents</span>
              <span className="text-right">last seen</span>
              <span className="text-right">actions</span>
            </div>
            <ul className="m-0 p-0 list-none">
              {rows.map((r, i) => (
                <li
                  key={r.ref}
                  className={
                    "grid grid-cols-[40px_1fr_120px_100px_100px_140px_100px] gap-4 px-6 py-4 items-center " +
                    (i > 0 ? "border-t border-[var(--color-border)]" : "")
                  }
                >
                  <span className="t-data text-[var(--color-disabled)]">{String(i + 1).padStart(2, "0")}</span>
                  <a
                    href={`https://x.com/${r.ref}`}
                    target="_blank"
                    rel="noreferrer"
                    className="t-subheading text-[var(--color-display)] no-underline hover:text-[var(--color-display)]"
                  >
                    @{r.ref}
                  </a>
                  <span className="t-data text-right text-[var(--color-display)] font-mono">{r.total}</span>
                  <span
                    className={
                      "t-data text-right font-mono " +
                      (r.converted > 0 ? "text-[var(--color-display)]" : "text-[var(--color-disabled)]")
                    }
                  >
                    {r.converted}
                  </span>
                  <span className="t-data text-right text-[var(--color-secondary)]">{r.agents_touched}</span>
                  <span className="t-meta text-right text-[var(--color-disabled)]">
                    {r.last_at?.slice(5, 16).replace("T", " ") ?? "—"}
                  </span>
                  <span className="text-right">
                    <button
                      onClick={() => remove(r.ref)}
                      disabled={busy === r.ref}
                      className="t-button text-[var(--color-accent)] hover:underline press-feedback"
                    >
                      {busy === r.ref ? "…" : "delete"}
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>
    </div>
  );
}

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
  // On first render, peek at ?token= and pre-fill if present.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const hash = window.location.hash || "";
    const idx = hash.indexOf("?");
    if (idx < 0) return;
    const t = new URLSearchParams(hash.slice(idx + 1)).get("token");
    if (t && !value) onChange(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="min-h-dvh flex flex-col bg-[var(--color-bg)] text-[var(--color-primary)]">
      <Topbar crumb="admin · refs" />
      <main className="flex-1 max-w-[640px] w-full mx-auto px-6 md:px-10 py-12">
        <p className="t-label text-[var(--color-secondary)] mb-3">admin</p>
        <h1 className="t-heading mb-6">paste the admin token to continue.</h1>
        <p className="t-body mb-8 max-w-[60ch]">
          Reads from <code className="font-mono text-[var(--color-display)]">VERDICT_ADMIN_TOKEN</code> on the daemon. Never
          shared in URLs after first paste — stored in localStorage and sent
          as <code className="font-mono text-[var(--color-display)]">X-Admin-Token</code>.
        </p>
        {error && (
          <div className="border border-[var(--color-accent)] px-6 py-4 mb-6 t-body-sm text-[var(--color-accent)]">
            [ERROR] {error}
          </div>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit();
          }}
          className="flex flex-col gap-4"
        >
          <input
            type="password"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className="bg-transparent border-b border-[var(--color-border-vis)] py-2 t-body font-mono text-[var(--color-display)] focus:outline-none focus:border-[var(--color-display)]"
            placeholder="VERDICT_ADMIN_TOKEN"
            autoFocus
          />
          <PillButton variant="primary" type="submit">unlock</PillButton>
        </form>
      </main>
    </div>
  );
}

function readToken(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

function writeToken(v: string): void {
  try {
    if (v) window.localStorage.setItem(TOKEN_KEY, v);
    else window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    // storage disabled / quota — silent fail
  }
}
