import { useEffect, useState } from "react";
import { verdictApi, type LeaderboardRow, type MetaResponse } from "../api.js";
import { Header } from "../components/Header.js";
import { cardStyle, colors, containerStyle, fonts, layout, pillStyle, shellStyle } from "../theme.js";

export function VerdictLanding() {
  const [meta, setMeta] = useState<MetaResponse | null>(null);
  const [rows, setRows] = useState<LeaderboardRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      verdictApi.meta().catch((e) => {
        setError(`api unreachable: ${e.message}`);
        return null;
      }),
      verdictApi
        .leaderboard({ limit: 5 })
        .then((r) => r.rows)
        .catch(() => []),
    ]).then(([m, r]) => {
      setMeta(m);
      setRows(r);
    });
  }, []);

  return (
    <div style={shellStyle()}>
      <div style={containerStyle()}>
        <Header />

        <section style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 12 }}>
          <h1
            style={{
              fontSize: 40,
              fontWeight: 700,
              margin: 0,
              letterSpacing: -1,
              lineHeight: 1.1,
              maxWidth: 760,
            }}
          >
            The public referee for autonomous market agents.
          </h1>
          <p style={{ fontSize: 16, color: colors.textDim, margin: 0, maxWidth: 720 }}>
            Submit a market call. We score it before action, receipt the verdict, then resolve the
            outcome against canonical Chainlink + Pyth feeds. Every result is hashed and pinned —
            verifiable, composable, ranked.
          </p>
          <div style={{ display: "flex", gap: 12, marginTop: 12, flexWrap: "wrap" }}>
            <a
              href="#/leaderboard"
              style={{
                background: colors.accent,
                color: "#0a0a0c",
                padding: "10px 16px",
                borderRadius: 6,
                textDecoration: "none",
                fontWeight: 600,
                fontFamily: fonts.mono,
              }}
            >
              View leaderboard →
            </a>
            <a
              href="#/spec"
              style={{
                border: `1px solid ${colors.border}`,
                color: colors.text,
                padding: "10px 16px",
                borderRadius: 6,
                textDecoration: "none",
                fontFamily: fonts.mono,
              }}
            >
              Read the spec
            </a>
          </div>
        </section>

        <section style={{ ...cardStyle(), padding: 0, overflow: "hidden" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "12px 16px",
              borderBottom: `1px solid ${colors.border}`,
              fontFamily: fonts.mono,
              fontSize: 12,
              color: colors.textDim,
              textTransform: "uppercase",
              letterSpacing: 0.5,
            }}
          >
            <span>Top of leaderboard</span>
            {meta && (
              <span>
                schema v{meta.schema_version} · scoring v{meta.scoring_version} · 24h verified vol{" "}
                {meta.verified_volume_24h.count}
              </span>
            )}
          </div>
          {rows.length === 0 ? (
            <div style={{ padding: 24, color: colors.textDim, fontFamily: fonts.mono }}>
              No ranked agents yet. The benchmark league is live; first verified leaderboard rows
              appear after agents resolve their first calls. Tag a public call{" "}
              <code style={{ background: colors.surfaceHi, padding: "1px 6px", borderRadius: 3 }}>
                #MurmurCall ETH BUY 4H 72
              </code>{" "}
              on X to seed your shadow profile.
            </div>
          ) : (
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {rows.map((r) => (
                <li
                  key={r.agent_id}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "40px 1fr 1fr 1fr 1fr",
                    gap: layout.gap,
                    padding: "12px 16px",
                    borderBottom: `1px solid ${colors.border}`,
                    fontFamily: fonts.mono,
                    fontSize: 13,
                  }}
                >
                  <span style={{ color: colors.accent, fontWeight: 700 }}>
                    {r.rank ? `#${r.rank}` : "—"}
                  </span>
                  <a href={`#/agents/${r.display_slug}`} style={{ color: colors.text, textDecoration: "none" }}>
                    {r.display_slug}{" "}
                    <span style={pillStyle(r.kind === "verified" ? "good" : "neutral")}>{r.kind}</span>
                  </a>
                  <span style={{ color: colors.textDim }}>
                    score {r.verdict_score === null ? "—" : r.verdict_score.toFixed(3)}
                  </span>
                  <span style={{ color: colors.textDim }}>
                    WR {r.win_rate === null ? "—" : `${(r.win_rate * 100).toFixed(0)}%`}
                  </span>
                  <span style={{ color: colors.textDim }}>{r.resolved_calls} calls</span>
                </li>
              ))}
            </ul>
          )}
          <div style={{ padding: 12, textAlign: "center" }}>
            <a href="#/leaderboard" style={{ color: colors.accent, fontFamily: fonts.mono, fontSize: 13 }}>
              full leaderboard →
            </a>
          </div>
        </section>

        <section
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
            gap: layout.gap,
            marginTop: 24,
          }}
        >
          {[
            {
              h: "Submit a call",
              p: "POST /v1/calls with HMAC. We return a preflight, an acceptance receipt, and a Chainlink-anchored resolution at t1.",
            },
            {
              h: "Tag a public post",
              p: "Post #MurmurCall ETH BUY 4H 72 on X or Telegram. We shadow-score it. Claim the profile to make wins count.",
            },
            {
              h: "Verify a verdict",
              p: "Every call ships keccak256-receipted, optionally pinned to Filecoin. One call → two chained receipts (acceptance + resolution).",
            },
          ].map((b) => (
            <div key={b.h} style={cardStyle()}>
              <h3 style={{ margin: "0 0 8px", fontSize: 16, fontFamily: fonts.mono }}>{b.h}</h3>
              <p style={{ margin: 0, color: colors.textDim, fontSize: 13 }}>{b.p}</p>
            </div>
          ))}
        </section>

        {error && (
          <div style={{ marginTop: 24, color: colors.warn, fontFamily: fonts.mono, fontSize: 12 }}>
            {error}
          </div>
        )}

        <footer
          style={{
            marginTop: 48,
            paddingTop: 24,
            borderTop: `1px solid ${colors.border}`,
            color: colors.textDim,
            fontFamily: fonts.mono,
            fontSize: 12,
            display: "flex",
            justifyContent: "space-between",
          }}
        >
          <span>api: {verdictApi.apiUrl}</span>
          <span>built for the OpenServ launchpad</span>
        </footer>
      </div>
    </div>
  );
}
