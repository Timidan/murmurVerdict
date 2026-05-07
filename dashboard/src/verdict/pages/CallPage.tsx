import { useEffect, useState } from "react";
import { verdictApi, type FullCall, type VerifyResult } from "../api.js";
import { Header } from "../components/Header.js";
import { cardStyle, colors, containerStyle, fonts, pillStyle, shellStyle } from "../theme.js";

export function CallPage({ callId }: { callId: string }) {
  const [data, setData] = useState<FullCall | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [verify, setVerify] = useState<VerifyResult | null>(null);
  const [verifyExpanded, setVerifyExpanded] = useState(false);

  useEffect(() => {
    let cancel = false;
    verdictApi
      .call(callId)
      .then((d) => {
        if (!cancel) setData(d);
      })
      .catch((e) => {
        if (!cancel) setError(e.message);
      });
    verdictApi
      .verifyCall(callId)
      .then((v) => {
        if (!cancel) setVerify(v);
      })
      .catch(() => {
        // verify is best-effort; CallPage still renders without it
      });
    return () => {
      cancel = true;
    };
  }, [callId]);

  return (
    <div style={shellStyle()}>
      <div style={containerStyle()}>
        <Header />

        {error && (
          <div style={{ ...cardStyle(), color: colors.warn, fontFamily: fonts.mono }}>{error}</div>
        )}

        {data && (
          <>
            <section style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <a
                href={`#/agents/${data.submission.agent_id}`}
                style={{ color: colors.textDim, fontFamily: fonts.mono, fontSize: 12, textDecoration: "none" }}
              >
                ← agent {data.submission.agent_id.slice(0, 8)}…
              </a>
              <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
                <h1 style={{ fontSize: 24, margin: 0, fontFamily: fonts.mono }}>
                  {data.submission.side} {data.submission.asset_id} {data.submission.horizon_hours}h
                </h1>
                <span style={pillStyle("neutral")}>conf {(data.submission.confidence * 100).toFixed(0)}%</span>
                <span style={pillStyle(statusTone(data.submission.status))}>{data.submission.status}</span>
              </div>
              {data.submission.rationale && (
                <p style={{ color: colors.textDim, margin: "6px 0 0", maxWidth: 720 }}>
                  “{data.submission.rationale}”
                </p>
              )}
              {verify && <VerifyBadge result={verify} expanded={verifyExpanded} onToggle={() => setVerifyExpanded(!verifyExpanded)} />}
            </section>

            <Section title="Submission">
              <Kv k="call_id" v={data.submission.call_id} />
              <Kv k="client_order_id" v={data.submission.client_order_id} />
              <Kv k="submitted_at" v={data.submission.submitted_at} />
              <Kv k="accepted_at" v={data.submission.accepted_at} />
              {data.submission.strategy_tag && <Kv k="strategy_tag" v={data.submission.strategy_tag} />}
            </Section>

            <Section title="Murmur preflight">
              <Kv k="composite_score" v={data.preflight.murmur_score.toFixed(3)} />
              <Kv k="top_playbook" v={data.preflight.murmur_playbook} />
              <Kv k="market_regime" v={data.preflight.market_regime} />
              <Kv k="data_freshness" v={`${data.preflight.data_freshness_seconds}s`} />
              <Kv k="risk_flags" v={data.preflight.risk_flags.length ? data.preflight.risk_flags.join(", ") : "none"} />
            </Section>

            <Section title="Acceptance receipt">
              <Kv k="receipt_hash" v={data.acceptance_receipt.hash} mono />
              {data.acceptance_receipt.filecoin_cid && (
                <Kv k="filecoin_cid" v={data.acceptance_receipt.filecoin_cid} mono />
              )}
            </Section>

            {data.t0 && (
              <Section title="t0 anchor">
                <Kv k="t0" v={data.t0.t0} />
                <Kv k="p0" v={data.t0.p0} />
                <Kv k="feed" v={data.t0.feed} />
              </Section>
            )}

            {data.resolution ? (
              <Section title="Resolution">
                <Kv k="t1" v={data.resolution.t1} />
                <Kv k="p1" v={data.resolution.p1} />
                <Kv k="t1_feed" v={data.resolution.t1_feed} />
                <Kv k="signed_return" v={`${(Number(data.resolution.signed_return) * 100).toFixed(3)}%`} />
                <Kv
                  k="outcome"
                  v={
                    <span style={pillStyle(outcomeTone(data.resolution.outcome))}>
                      {data.resolution.outcome}
                    </span>
                  }
                />
                <Kv
                  k="call_score"
                  v={data.resolution.call_score === null ? "—" : data.resolution.call_score.toFixed(4)}
                />
                <Kv k="resolved_at" v={data.resolution.resolved_at} />
                <Kv k="receipt_hash" v={data.resolution.receipt_hash} mono />
                {data.resolution.filecoin_cid && (
                  <Kv k="filecoin_cid" v={data.resolution.filecoin_cid} mono />
                )}
              </Section>
            ) : (
              <div style={{ ...cardStyle(), color: colors.textDim, fontFamily: fonts.mono, fontSize: 13 }}>
                pending resolution — t1 will be anchored when the oracle delivers a fresh feed update.
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ ...cardStyle() }}>
      <h3
        style={{
          margin: "0 0 12px",
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: 0.5,
          color: colors.textDim,
          fontFamily: fonts.mono,
        }}
      >
        {title}
      </h3>
      <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "max-content 1fr", gap: "6px 16px" }}>
        {children}
      </dl>
    </section>
  );
}

function Kv({ k, v, mono = false }: { k: string; v: React.ReactNode; mono?: boolean }) {
  return (
    <>
      <dt
        style={{
          color: colors.textDim,
          fontFamily: fonts.mono,
          fontSize: 12,
          textTransform: "uppercase",
          letterSpacing: 0.5,
        }}
      >
        {k}
      </dt>
      <dd
        style={{
          margin: 0,
          fontFamily: mono ? fonts.mono : fonts.sans,
          wordBreak: mono ? "break-all" : "normal",
          fontSize: 13,
        }}
      >
        {v}
      </dd>
    </>
  );
}

function outcomeTone(o: string): "good" | "bad" | "neutral" | "warn" {
  if (o === "win") return "good";
  if (o === "loss") return "bad";
  if (o === "void") return "neutral";
  return "warn";
}

function statusTone(s: string): "good" | "bad" | "neutral" | "warn" {
  if (s === "resolved") return "good";
  if (s === "rejected") return "bad";
  return "neutral";
}

function VerifyBadge({
  result,
  expanded,
  onToggle,
}: {
  result: VerifyResult;
  expanded: boolean;
  onToggle: () => void;
}) {
  const matched = result.checks.filter((c) => c.status === "match").length;
  const mismatched = result.checks.filter((c) => c.status === "mismatch").length;
  const skipped = result.checks.filter((c) => c.status === "skipped").length;
  const tone: "good" | "bad" | "warn" = result.passes
    ? mismatched === 0 && matched > 0
      ? "good"
      : "warn"
    : "bad";
  const label = result.passes
    ? mismatched === 0 && matched > 0
      ? `Verified ✓ — ${matched} checks match`
      : `Pending — ${matched} match · ${skipped} skipped`
    : `Mismatch ✗ — ${mismatched} mismatch · ${matched} match`;
  return (
    <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
      <button
        type="button"
        onClick={onToggle}
        style={{
          alignSelf: "flex-start",
          background: "transparent",
          border: "none",
          padding: 0,
          cursor: "pointer",
          fontFamily: fonts.mono,
        }}
      >
        <span style={pillStyle(tone)}>{label}</span>
        <span style={{ marginLeft: 8, color: colors.textDim, fontSize: 12 }}>
          {expanded ? "hide details" : "how we verified this"}
        </span>
      </button>
      {expanded && (
        <div
          style={{
            ...cardStyle(),
            background: colors.surfaceHi,
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          <p style={{ margin: 0, color: colors.textDim, fontSize: 12, fontFamily: fonts.mono }}>
            Independent recomputation against the canonical receipt JSON. A third party with the
            same receipt can run <code>npx tsx tools/verify-receipt.ts {result.call_id}</code> and
            get the same answer. Schema v{result.schema_version} · scoring v{result.scoring_version}.
          </p>
          <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: fonts.mono, fontSize: 12 }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", padding: "4px 8px", color: colors.textDim }}>Check</th>
                <th style={{ textAlign: "left", padding: "4px 8px", color: colors.textDim }}>Status</th>
                <th style={{ textAlign: "left", padding: "4px 8px", color: colors.textDim }}>Stored</th>
                <th style={{ textAlign: "left", padding: "4px 8px", color: colors.textDim }}>Recomputed</th>
              </tr>
            </thead>
            <tbody>
              {result.checks.map((c) => {
                const statusTone =
                  c.status === "match"
                    ? "good"
                    : c.status === "mismatch"
                    ? "bad"
                    : "neutral";
                return (
                  <tr key={c.name}>
                    <td style={{ padding: "4px 8px" }}>{c.name}</td>
                    <td style={{ padding: "4px 8px" }}>
                      <span style={pillStyle(statusTone)}>{c.status}</span>
                    </td>
                    <td style={{ padding: "4px 8px", color: colors.textDim, wordBreak: "break-all" }}>
                      {short(String(c.stored ?? "—"))}
                    </td>
                    <td style={{ padding: "4px 8px", color: colors.textDim, wordBreak: "break-all" }}>
                      {short(String(c.recomputed ?? "—"))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function short(s: string): string {
  if (s.length <= 22) return s;
  return `${s.slice(0, 10)}…${s.slice(-8)}`;
}
