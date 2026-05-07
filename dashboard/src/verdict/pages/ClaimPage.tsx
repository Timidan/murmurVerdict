import { useState } from "react";
import { verdictApi, type ClaimInitResponse, type ClaimFinalizeResponse } from "../api.js";
import { Header } from "../components/Header.js";
import { cardStyle, colors, containerStyle, fonts, shellStyle } from "../theme.js";

type Step = "init" | "post_then_sign" | "finalize" | "done" | "error";

export function ClaimPage({ slug }: { slug: string }) {
  const [step, setStep] = useState<Step>("init");
  const [identityKind, setIdentityKind] = useState<"x" | "telegram">("x");
  const [identityValue, setIdentityValue] = useState("");
  const [wallet, setWallet] = useState("");
  const [init, setInit] = useState<ClaimInitResponse | null>(null);
  const [signature, setSignature] = useState("");
  const [postUrl, setPostUrl] = useState("");
  const [finalized, setFinalized] = useState<ClaimFinalizeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function startInit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const r = await verdictApi.claimInit(slug, {
        target_identity: { kind: identityKind, value: identityValue },
        wallet_to_bind: wallet,
      });
      setInit(r);
      setStep("post_then_sign");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "init failed");
      setStep("error");
    }
  }

  async function finalize(e: React.FormEvent) {
    e.preventDefault();
    if (!init) return;
    setError(null);
    try {
      const r = await verdictApi.claimFinalize(slug, {
        challenge_id: init.challenge_id,
        signature,
        post_url: postUrl,
      });
      setFinalized(r);
      setStep("done");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "finalize failed");
    }
  }

  return (
    <div style={shellStyle()}>
      <div style={containerStyle()}>
        <Header />

        <h1 style={{ margin: 0 }}>Claim {slug}</h1>
        <p style={{ color: colors.textDim, marginTop: 0, maxWidth: 720 }}>
          Bind a wallet to a shadow profile by posting a challenge text on the same external
          identity that produced the public calls. Once verified, the agent flips to{" "}
          <code style={{ background: colors.surfaceHi, padding: "1px 6px", borderRadius: 3 }}>verified</code>,
          your call history counts toward the leaderboard, and you receive an HMAC API key.
        </p>

        {error && (
          <div style={{ ...cardStyle(), color: colors.warn, fontFamily: fonts.mono }}>{error}</div>
        )}

        {step === "init" && (
          <form
            onSubmit={startInit}
            style={{ ...cardStyle(), display: "flex", flexDirection: "column", gap: 12 }}
          >
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontFamily: fonts.mono, fontSize: 12, color: colors.textDim, textTransform: "uppercase" }}>
                identity kind
              </span>
              <select
                value={identityKind}
                onChange={(e) => setIdentityKind(e.target.value as "x" | "telegram")}
                style={inputStyle()}
              >
                <option value="x">x</option>
                <option value="telegram">telegram</option>
              </select>
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontFamily: fonts.mono, fontSize: 12, color: colors.textDim, textTransform: "uppercase" }}>
                identity value
              </span>
              <input
                value={identityValue}
                onChange={(e) => setIdentityValue(e.target.value)}
                placeholder="@some_handle"
                style={inputStyle()}
                required
              />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontFamily: fonts.mono, fontSize: 12, color: colors.textDim, textTransform: "uppercase" }}>
                wallet to bind
              </span>
              <input
                value={wallet}
                onChange={(e) => setWallet(e.target.value)}
                placeholder="0x…"
                style={inputStyle()}
                required
                pattern="0x[a-fA-F0-9]{40}"
              />
            </label>
            <button type="submit" style={primaryButton()}>
              Generate challenge
            </button>
          </form>
        )}

        {step === "post_then_sign" && init && (
          <form onSubmit={finalize} style={{ ...cardStyle(), display: "flex", flexDirection: "column", gap: 12 }}>
            <div>
              <p style={{ margin: "0 0 8px", color: colors.textDim, fontSize: 13 }}>
                1. Post this verbatim on{" "}
                <code style={{ background: colors.surfaceHi, padding: "1px 6px", borderRadius: 3 }}>
                  {init.target_identity.kind}:{init.target_identity.value}
                </code>
                :
              </p>
              <pre
                style={{
                  margin: 0,
                  padding: 12,
                  background: colors.surfaceHi,
                  borderRadius: 4,
                  fontFamily: fonts.mono,
                  fontSize: 13,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-all",
                }}
              >
                {init.challenge_text}
              </pre>
              <p style={{ margin: "12px 0 0", color: colors.textDim, fontSize: 13 }}>
                2. Sign the nonce{" "}
                <code style={{ background: colors.surfaceHi, padding: "1px 6px", borderRadius: 3 }}>
                  {init.nonce}
                </code>{" "}
                with{" "}
                <code style={{ background: colors.surfaceHi, padding: "1px 6px", borderRadius: 3 }}>
                  {init.wallet_to_bind}
                </code>{" "}
                (personal_sign / EIP-191).
              </p>
              <p style={{ margin: "12px 0 0", color: colors.textDim, fontSize: 13 }}>
                Challenge expires {init.expires_at}.
              </p>
            </div>
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontFamily: fonts.mono, fontSize: 12, color: colors.textDim, textTransform: "uppercase" }}>
                signature (0x… 65 bytes)
              </span>
              <input
                value={signature}
                onChange={(e) => setSignature(e.target.value)}
                placeholder="0x…"
                style={inputStyle()}
                required
              />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontFamily: fonts.mono, fontSize: 12, color: colors.textDim, textTransform: "uppercase" }}>
                post url
              </span>
              <input
                value={postUrl}
                onChange={(e) => setPostUrl(e.target.value)}
                placeholder="https://x.com/handle/status/…"
                style={inputStyle()}
                required
              />
            </label>
            <button type="submit" style={primaryButton()}>
              Finalize claim
            </button>
          </form>
        )}

        {step === "done" && finalized && (
          <div style={{ ...cardStyle(), display: "flex", flexDirection: "column", gap: 12 }}>
            <h2 style={{ margin: 0, color: colors.accent }}>Claimed.</h2>
            <p style={{ color: colors.textDim, margin: 0, fontSize: 13 }}>
              Agent <strong>{finalized.display_slug}</strong> is now <strong>verified</strong>.
              We imported {finalized.imported_call_ids.length} historical calls; new submissions go
              through the HMAC pipeline.
            </p>
            <div>
              <span style={{ fontFamily: fonts.mono, fontSize: 12, color: colors.textDim, textTransform: "uppercase" }}>
                api key (shown once — save it now)
              </span>
              <pre
                style={{
                  margin: "4px 0 0",
                  padding: 12,
                  background: colors.surfaceHi,
                  borderRadius: 4,
                  fontFamily: fonts.mono,
                  fontSize: 13,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-all",
                }}
              >
                {finalized.api_key}
              </pre>
            </div>
            <a
              href={`#/agents/${finalized.display_slug}`}
              style={{
                color: colors.accent,
                fontFamily: fonts.mono,
                fontSize: 13,
                textDecoration: "none",
              }}
            >
              → view your agent profile
            </a>
          </div>
        )}
      </div>
    </div>
  );
}

function inputStyle(): React.CSSProperties {
  return {
    background: colors.surfaceHi,
    color: colors.text,
    border: `1px solid ${colors.border}`,
    borderRadius: 4,
    padding: "8px 12px",
    fontFamily: fonts.mono,
    fontSize: 13,
    outline: "none",
  };
}

function primaryButton(): React.CSSProperties {
  return {
    background: colors.accent,
    color: "#0a0a0c",
    border: "none",
    borderRadius: 4,
    padding: "10px 16px",
    fontFamily: fonts.mono,
    fontWeight: 600,
    cursor: "pointer",
    alignSelf: "flex-start",
  };
}
