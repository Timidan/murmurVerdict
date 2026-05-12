import { useEffect, useState } from "react";
import { verdictApi, type FullCall } from "../api.js";
import { CompactTopbar } from "../components/compact/Topbar.js";
import { Panel } from "../components/compact/Panel.js";
import { PrivacyTierBadge } from "../components/PrivacyTierBadge.js";

export function CallPage({ callId }: { callId: string }) {
  const [data, setData] = useState<FullCall | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancel = false;
    verdictApi
      .call(callId)
      .then((r) => {
        if (!cancel) setData(r);
      })
      .catch((e) => {
        if (!cancel) setError(e.message);
      });
    return () => {
      cancel = true;
    };
  }, [callId]);

  // Wave 2b — FHE-mandatory. Every call is operator-blind; subject and
  // signed_return rendering collapse to the FHE-direct branch. The
  // PrivacyTierBadge still surfaces the literal privacy_mode label.
  const subjectLabel = !data ? "" : "OPERATOR-BLIND";
  const outcomeText = !data
    ? ""
    : data.resolution
      ? data.resolution.outcome.toUpperCase()
      : "PEND";
  const outcomeTone = !data
    ? "ck-dim"
    : !data.resolution
      ? "ck-dim"
      : data.resolution.outcome === "win"
        ? "ck-pos"
        : data.resolution.outcome === "loss"
          ? "ck-neg"
          : "ck-dim";

  return (
    <div className="compact-shell min-h-dvh flex flex-col">
      <CompactTopbar
        crumb={
          <span>
            CALLS <span className="ck-dim mx-1">/</span>
            <span className="ck-pos">{callId.slice(0, 8)}</span>
          </span>
        }
      />

      <main className="flex-1 grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] min-h-0">
        {error && (
          <div className="lg:col-span-2 px-2 py-2 ck-mono ck-neg border-b border-[var(--color-border)]">
            [ERROR] {error}
          </div>
        )}

        {!error && !data && (
          <div className="lg:col-span-2 px-2 py-4 ck-label ck-dim">[LOADING…]</div>
        )}

        {data && (
          <>
            <div className="lg:col-span-2 grid grid-cols-3 border-b border-[var(--color-border)]">
              <Stat label="SUBJECT" value={subjectLabel} mono />
              <Stat label="OUTCOME" value={outcomeText} tone={outcomeTone} />
              <Stat label="SCORE" value={data.resolution?.call_score?.toFixed(4) ?? "—"} mono />
            </div>

            <Panel title="SUBMISSION" className="lg:border-r-0">
              <Kv k="call_id" v={data.submission.call_id} mono />
              <Kv k="agent_id" v={data.submission.agent_id} mono />
              {data.submission.privacy_mode && (
                <div className="flex items-center justify-between px-2 py-1">
                  <span className="ck-label ck-dim">privacy_mode</span>
                  <PrivacyTierBadge mode={data.submission.privacy_mode} />
                </div>
              )}
              {data.submission.commit_hash && (
                <Kv k="commit_hash" v={data.submission.commit_hash} mono />
              )}
              {data.submission.confidence !== undefined && (
                <Kv k="confidence" v={`${(data.submission.confidence * 100).toFixed(0)}%`} />
              )}
              {data.submission.submitted_at && (
                <Kv k="submitted_at" v={data.submission.submitted_at} />
              )}
              <Kv k="accepted_at" v={data.submission.accepted_at} />
              {data.submission.strategy_tag && (
                <Kv k="strategy_tag" v={data.submission.strategy_tag} />
              )}
            </Panel>

            <Panel title="ANCHOR · RESOLUTION">
              {data.t0 ? (
                <>
                  <Kv k="t0" v={data.t0.t0} />
                  <Kv k="p0" v={data.t0.p0} />
                  <Kv k="t0_feed" v={data.t0.feed} />
                </>
              ) : (
                <Kv k="t0" v="awaiting anchor" tone="ck-dim" />
              )}
              <KvDivider />
              {data.resolution ? (
                <>
                  <Kv k="t1" v={data.resolution.t1} />
                  <Kv k="p1" v={data.resolution.p1} />
                  <Kv k="t1_feed" v={data.resolution.t1_feed} />
                  {/* Wave 2b — FHE-mandatory. signed_return is a
                      native-price post-resolution stat; FHE-direct
                      calls release a bounded score, no return concept.
                      Hidden from the active call display. */}
                  {data.resolution.call_score !== null && (
                    <Kv k="call_score" v={data.resolution.call_score.toFixed(4)} />
                  )}
                  <Kv k="resolved_at" v={data.resolution.resolved_at} />
                </>
              ) : (
                <Kv k="t1" v="awaiting resolution" tone="ck-dim" />
              )}
            </Panel>
          </>
        )}
      </main>

      <footer className="flex items-center gap-3 px-2 py-1 border-t border-[var(--color-border)] ck-mono ck-dim">
        <a href="#/" className="ck-mono ck-dim hover:ck-pos no-underline">
          ← HOME
        </a>
        <span>·</span>
        <a href="#/leaderboard" className="ck-mono ck-dim hover:ck-pos no-underline">
          LEADERBOARD
        </a>
        <span className="ml-auto ck-mono ck-dim">CALL · {callId.slice(0, 8)}</span>
      </footer>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
  mono,
}: {
  label: string;
  value: React.ReactNode;
  tone?: string;
  mono?: boolean;
}) {
  const cls = tone ?? "ck-pos";
  return (
    <div className="px-2 py-2 border-r border-[var(--color-border)] last:border-r-0 flex flex-col gap-1 min-w-0">
      <span className="ck-label">{label}</span>
      <span
        className={(mono ? "ck-mono " : "") + cls + " truncate"}
        style={{ fontSize: 13, fontWeight: 700 }}
      >
        {value || "—"}
      </span>
    </div>
  );
}

function Kv({
  k,
  v,
  mono,
  tone,
}: {
  k: string;
  v: React.ReactNode;
  mono?: boolean;
  tone?: string;
}) {
  return (
    <div className="grid grid-cols-[140px_1fr] gap-x-3 px-2 py-1 border-b border-[var(--color-border)]">
      <span className="ck-label truncate">{k}</span>
      <span className={(mono ? "ck-mono " : "ck-mono ") + (tone ?? "ck-pos") + " break-all"}>
        {v}
      </span>
    </div>
  );
}

function KvDivider() {
  return <div className="h-2 border-b border-[var(--color-border)]" />;
}
