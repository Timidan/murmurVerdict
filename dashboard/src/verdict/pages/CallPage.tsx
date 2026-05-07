import { useEffect, useState } from "react";
import { verdictApi, type FullCall, type VerifyResult } from "../api.js";
import { Topbar } from "../components/Topbar.js";
import { OutcomeChip } from "../components/OutcomeChip.js";
import { PillButton } from "../components/PillButton.js";

/**
 * Call detail / receipt chain. Three sections: submission + preflight,
 * t0 anchor, t1 resolution. Receipts shown as raw hashes (no truncation).
 * Run-the-verifier button surfaces the full check matrix inline.
 */
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

  return (
    <div className="min-h-dvh flex flex-col bg-[var(--color-bg)] text-[var(--color-primary)]">
      <Topbar
        crumb={
          <span>
            calls <span className="text-[var(--color-border-vis)] mx-2">/</span>
            <strong className="text-[var(--color-display)] font-bold font-mono">
              {callId.slice(0, 8)}
            </strong>
          </span>
        }
      />

      <main className="flex-1 max-w-[1024px] w-full mx-auto px-6 md:px-10 py-12">
        {error && (
          <div className="border border-[var(--color-accent)] px-6 py-8 t-body-sm text-[var(--color-accent)]">
            [ERROR] {error}
          </div>
        )}

        {!error && !data && (
          <div className="px-6 py-24 t-meta text-[var(--color-disabled)]">[loading …]</div>
        )}

        {data && (
          <>
            {(() => {
              const scrubbed =
                data.submission.privacy_mode === "committed" &&
                data.submission.side === undefined;
              const subjectLabel = scrubbed
                ? "COMMITTED · SEALED"
                : `${data.submission.side} · ${data.submission.asset_id?.split(":").pop()} · ${data.submission.horizon_hours}H`;
              return (
                <>
            <header className="mb-10 flex flex-wrap items-baseline justify-between gap-4">
              <div>
                <p className="t-label text-[var(--color-secondary)] mb-3">
                  {subjectLabel}
                </p>
                <h1 className="t-subheading text-[var(--color-display)]">
                  {scrubbed
                    ? data.submission.commit_hash ?? "(committed call)"
                    : data.submission.rationale ?? "(no rationale provided)"}
                </h1>
              </div>
              <OutcomeChip outcome={data.resolution?.outcome ?? "live"}>
                {data.resolution
                  ? `${data.resolution.outcome.toUpperCase()} · ${(Number(data.resolution.signed_return) * 100).toFixed(2)}%`
                  : "PEND"}
              </OutcomeChip>
            </header>

            <Section title="SUBMISSION">
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
            </Section>

            <Section title="PREFLIGHT">
              <Kv k="murmur_score" v={data.preflight.murmur_score.toFixed(3)} />
              <Kv k="playbook" v={data.preflight.murmur_playbook} />
              <Kv k="market_regime" v={data.preflight.market_regime} />
              <Kv k="freshness" v={`${data.preflight.data_freshness_seconds}s`} />
              <Kv k="risk_flags" v={data.preflight.risk_flags.join(", ") || "none"} />
            </Section>

            <Section title="ACCEPTANCE RECEIPT">
              <Kv k="receipt_hash" v={data.acceptance_receipt.hash} mono />
              {data.acceptance_receipt.filecoin_cid && (
                <Kv k="filecoin_cid" v={data.acceptance_receipt.filecoin_cid} mono />
              )}
            </Section>

            {data.t0 && (
              <Section title="T0 ANCHOR">
                <Kv k="t0" v={data.t0.t0} />
                <Kv k="p0" v={data.t0.p0} />
                <Kv k="feed" v={data.t0.feed} />
              </Section>
            )}

            {data.resolution ? (
              <Section title="RESOLUTION">
                <Kv k="t1" v={data.resolution.t1} />
                <Kv k="p1" v={data.resolution.p1} />
                <Kv k="t1_feed" v={data.resolution.t1_feed} />
                <Kv k="signed_return" v={`${(Number(data.resolution.signed_return) * 100).toFixed(3)}%`} />
                {data.resolution.call_score !== null && (
                  <Kv k="call_score" v={data.resolution.call_score.toFixed(4)} />
                )}
                <Kv k="resolved_at" v={data.resolution.resolved_at} />
                <Kv k="receipt_hash" v={data.resolution.receipt_hash} mono />
                {data.resolution.filecoin_cid && (
                  <Kv k="filecoin_cid" v={data.resolution.filecoin_cid} mono />
                )}
              </Section>
            ) : (
              <p className="t-meta text-[var(--color-disabled)] mt-6">
                Awaiting resolution …
              </p>
            )}

            <div className="mt-10 flex flex-wrap items-center gap-3">
              <PillButton variant="primary" onClick={runVerify} disabled={verifying}>
                {verifying ? "VERIFYING …" : "VERIFY CALL"}
              </PillButton>
              {verify && <VerifyResultCard result={verify} />}
            </div>
                </>
              );
            })()}
          </>
        )}
      </main>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-[var(--color-border)] py-6">
      <h2 className="t-label mb-4">{title}</h2>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-8 gap-y-2">{children}</dl>
    </section>
  );
}

function Kv({ k, v, mono }: { k: string; v: React.ReactNode; mono?: boolean }) {
  return (
    <>
      <dt className="t-label text-[var(--color-secondary)]">{k}</dt>
      <dd
        className={
          "m-0 t-body-sm " +
          (mono ? "font-mono text-[var(--color-display)] break-all" : "text-[var(--color-primary)]")
        }
      >
        {v}
      </dd>
    </>
  );
}

function VerifyResultCard({ result }: { result: VerifyResult }) {
  return (
    <span
      className={
        "t-label px-3 py-1 border " +
        (result.passes
          ? "border-[var(--color-display)] text-[var(--color-display)]"
          : "border-[var(--color-accent)] text-[var(--color-accent)]")
      }
    >
      {result.passes ? "VERIFIED" : "MISMATCH"} · {result.checks.length} checks
    </span>
  );
}
