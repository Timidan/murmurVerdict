// Account-wide agent activity history — what each runtime key DID: gateway
// attempt rows (sealed calls + feed packets) with key identity, auth proof,
// and outcome. History, not forensic audit: rows advance as attempts
// broadcast/confirm.

import { useCallback, useEffect, useState } from "react";
import { getAccessToken } from "@privy-io/react-auth";

import { verdictApi, type AccountActivityRow } from "../../api.js";

const PAGE_SIZE = 25;

export function ActivityPanel() {
  const [rows, setRows] = useState<AccountActivityRow[]>([]);
  const [next, setNext] = useState<{ before: string; before_id: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (cursor?: { before: string; before_id: string }) => {
      setLoading(true);
      setError(null);
      try {
        const token = await getAccessToken();
        if (!token) throw new Error("session expired — sign in again");
        const page = await verdictApi.getAccountActivity(token, {
          limit: PAGE_SIZE,
          before: cursor?.before,
          before_id: cursor?.before_id,
        });
        setRows((prev) => (cursor ? [...prev, ...page.activity] : page.activity));
        setNext(page.next);
      } catch (e) {
        setError((e as Error)?.message ?? "unknown error");
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="ck-frame">
      <div className="ck-header">
        <span className="ck-title">agent activity</span>
        <span className="ck-mono ck-dim">{rows.length} shown</span>
      </div>
      {error && (
        <p className="px-3 py-2 ck-mono text-[10px]" style={{ color: "var(--color-accent-ink)" }}>
          × {error}
        </p>
      )}
      {rows.length === 0 && !loading && !error ? (
        <p className="px-3 py-2 ck-mono text-[11px] ck-dim">
          no gateway activity yet — rows appear when an agent submits through a
          runtime key.
        </p>
      ) : (
        <ul className="flex flex-col">
          {rows.map((r) => (
            <li
              key={r.attempt_id}
              className="px-3 py-1.5 border-b border-[var(--color-border)] last:border-b-0 ck-mono text-[11px] flex flex-wrap items-baseline gap-x-3 gap-y-0.5"
            >
              <span className="ck-dim">{r.created_at.slice(0, 19).replace("T", " ")}</span>
              <span>{r.agent_slug ?? r.agent_id.slice(0, 8)}</span>
              <span>{r.kind === "sealed_call" ? "sealed call" : `feed ${r.feed_id ?? ""}`}</span>
              {r.market_id && <span className="ck-dim">{r.market_id}</span>}
              <span title={r.runtime_key_id ?? undefined}>
                {r.runtime_key_prefix ?? "—"}
                {r.auth_proof === "pop-v1" ? " ✓signed" : ""}
              </span>
              <span
                className={r.status.startsWith("failed") ? "" : "ck-dim"}
                style={r.status.startsWith("failed") ? { color: "var(--color-accent-ink)" } : undefined}
                title={r.last_error ?? undefined}
              >
                {r.status}
              </span>
            </li>
          ))}
        </ul>
      )}
      {next && (
        <button
          type="button"
          className="ck-btn ck-btn-bracket m-2 self-start"
          onClick={() => void load(next)}
          disabled={loading}
        >
          {loading ? "loading…" : "load older"}
        </button>
      )}
    </section>
  );
}
