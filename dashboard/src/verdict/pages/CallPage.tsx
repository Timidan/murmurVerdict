import { useEffect, useState } from "react";
import { verdictApi, type FullCall, type VerifyResult } from "../api.js";
import { CompactTopbar } from "../components/compact/Topbar.js";
import { Panel } from "../components/compact/Panel.js";

export function CallPage({ callId }: { callId: string }) {
  const [data, setData] = useState<FullCall | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [verify, setVerify] = useState<VerifyResult | null>(null);
  const [verifying, setVerifying] = useState(false);

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

  const runVerify = async () => {
    setVerifying(true);
    try {
      const r = await verdictApi.verifyCall(callId);
      setVerify(r);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setVerifying(false);
    }
  };

  const scrubbed =
    data?.submission.privacy_mode === "committed" && data.submission.side === undefined;
  const subjectLabel = !data
    ? ""
    : scrubbed
      ? "COMMITTED · SEALED"
      : `${data.submission.side} · ${data.submission.asset_id?.split(":").pop()} · ${data.submission.horizon_hours}H`;
  const outcomeText = !data
    ? ""
    : data.resolution
      ? `${data.resolution.outcome.toUpperCase()} · ${(Number(data.resolution.signed_return) * 100).toFixed(2)}%`
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

            <Panel title="SUBMISSION · PREFLIGHT" className="lg:border-r-0">
              <Kv k="call_id" v={data.submission.call_id} mono />
              <Kv k="agent_id" v={data.submission.agent_id} mono />
              {data.submission.privacy_mode && (
                <Kv k="privacy_mode" v={data.submission.privacy_mode} />
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
              <KvDivider />
              <Kv k="murmur_score" v={data.preflight.murmur_score.toFixed(3)} />
              <Kv k="playbook" v={data.preflight.murmur_playbook} />
              <Kv k="market_regime" v={data.preflight.market_regime} />
              <Kv k="freshness" v={`${data.preflight.data_freshness_seconds}s`} />
              <Kv k="risk_flags" v={data.preflight.risk_flags.join(", ") || "none"} />
              <KvDivider />
              <Kv k="acceptance.hash" v={data.acceptance_receipt.hash} mono />
              {data.acceptance_receipt.filecoin_cid && (
                <Kv k="acceptance.cid" v={data.acceptance_receipt.filecoin_cid} mono />
              )}
            </Panel>

            <Panel title="ANCHOR · RESOLUTION · VERIFY">
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
                  <Kv
                    k="signed_return"
                    v={`${(Number(data.resolution.signed_return) * 100).toFixed(3)}%`}
                  />
                  {data.resolution.call_score !== null && (
                    <Kv k="call_score" v={data.resolution.call_score.toFixed(4)} />
                  )}
                  <Kv k="resolved_at" v={data.resolution.resolved_at} />
                  <Kv k="resolution.hash" v={data.resolution.receipt_hash} mono />
                  {data.resolution.filecoin_cid && (
                    <Kv k="resolution.cid" v={data.resolution.filecoin_cid} mono />
                  )}
                </>
              ) : (
                <Kv k="t1" v="awaiting resolution" tone="ck-dim" />
              )}
              <KvDivider />
              <div className="flex items-center gap-3 px-2 py-2">
                <button
                  className="ck-btn"
                  onClick={runVerify}
                  disabled={verifying}
                  type="button"
                >
                  {verifying ? "VERIFYING…" : "[V] VERIFY CALL"}
                </button>
                {verify && (
                  <span className={"ck-label " + (verify.passes ? "ck-pos" : "ck-neg")}>
                    {verify.passes ? "VERIFIED" : "MISMATCH"} · {verify.checks.length} CHECKS
                  </span>
                )}
              </div>
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
