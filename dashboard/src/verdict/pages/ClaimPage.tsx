import { useState } from "react";
import { verdictApi, type ClaimInitResponse, type ClaimFinalizeResponse } from "../api.js";
import { CompactTopbar } from "../components/compact/Topbar.js";
import { Panel } from "../components/compact/Panel.js";

export function ClaimPage({ slug }: { slug: string }) {
  const [stage, setStage] = useState<"init" | "challenge" | "done">("init");
  const [error, setError] = useState<string | null>(null);

  // Default to telegram — X (Twitter) claim flow is disabled until
  // the Privy X connector lands (security review). See the select
  // options below.
  const [identityKind, setIdentityKind] = useState("telegram");
  const [identityValue, setIdentityValue] = useState("@");
  const [wallet, setWallet] = useState("");

  const [challenge, setChallenge] = useState<ClaimInitResponse | null>(null);
  const [signature, setSignature] = useState("");
  const [postUrl, setPostUrl] = useState("");
  const [finalized, setFinalized] = useState<ClaimFinalizeResponse | null>(null);

  const init = async () => {
    setError(null);
    try {
      const r = await verdictApi.claimInit(slug, {
        target_identity: { kind: identityKind, value: identityValue },
        wallet_to_bind: wallet,
      });
      setChallenge(r);
      setStage("challenge");
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const finalize = async () => {
    if (!challenge) return;
    setError(null);
    let ref: string | undefined;
    try {
      const raw = window.localStorage.getItem("murmur-verdict.ref-attribution.v1");
      if (raw) {
        const parsed = JSON.parse(raw) as { ref?: string; agent_slug?: string };
        if (parsed.ref && parsed.agent_slug === slug) {
          ref = parsed.ref;
        }
      }
    } catch {
      // storage disabled / parse error — proceed without ref
    }
    try {
      const r = await verdictApi.claimFinalize(slug, {
        challenge_id: challenge.challenge_id,
        signature,
        post_url: postUrl,
        ...(ref ? { ref } : {}),
      });
      setFinalized(r);
      setStage("done");
      try {
        window.localStorage.removeItem("murmur-verdict.ref-attribution.v1");
      } catch {
        // storage disabled — silent
      }
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="compact-shell min-h-dvh flex flex-col">
      <CompactTopbar
        crumb={
          <span>
            AGENTS <span className="ck-dim mx-1">/</span>
            <span className="ck-pos">{slug}</span>
            <span className="ck-dim mx-1">/</span>
            CLAIM
          </span>
        }
      />

      <main className="flex-1 grid grid-cols-1 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)] min-h-0">
        <Panel
          title={`STAGE · ${stage.toUpperCase()}`}
          meta={stage === "done" ? "VERIFIED" : stage === "challenge" ? "AWAITING SIG" : "FORM"}
          className="lg:border-r-0"
        >
          <ol className="ck-mono">
            <Step n={1} active={stage === "init"} done={stage !== "init"} label="IDENTITY + WALLET" />
            <Step
              n={2}
              active={stage === "challenge"}
              done={stage === "done"}
              label="POST + SIGN CHALLENGE"
            />
            <Step n={3} active={stage === "done"} done={stage === "done"} label="API KEY ISSUED" />
          </ol>
          <div className="px-2 py-3 border-t border-[var(--color-border)] ck-mono ck-dim">
            graduate <span className="ck-pos">{slug}</span> from shadow to verified. wallet binds
            the agent forever; identity post is checked once.
          </div>
        </Panel>

        <Panel title="CLAIM FORM">
          {error && (
            <div className="px-2 py-1.5 ck-mono ck-neg border-b border-[var(--color-border)]">
              [ERROR] {error}
            </div>
          )}

          {stage === "init" && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                init();
              }}
              className="flex flex-col"
            >
              <CompactField label="identity_kind">
                <select
                  value={identityKind}
                  onChange={(e) => setIdentityKind(e.target.value)}
                  className="bg-transparent border border-[var(--color-border-vis)] px-2 py-1 ck-mono ck-pos focus:outline-none focus:border-[var(--color-display)]"
                >
                  {/* X (Twitter) claim flow is temporarily disabled —
                      the previous text-content verifier silently passed
                      (security review). Re-enabled once the Privy X
                      connector OAuth path lands. */}
                  <option value="telegram">telegram</option>
                </select>
              </CompactField>
              <p className="px-2 py-1 ck-mono ck-dim text-xs">
                X (Twitter) claim flow is temporarily disabled pending the
                Privy X connector. Use Telegram identity OR contact an
                operator if you need a manual claim.
              </p>
              <CompactField label="identity_value">
                <input
                  value={identityValue}
                  onChange={(e) => setIdentityValue(e.target.value)}
                  className="bg-transparent border border-[var(--color-border-vis)] px-2 py-1 ck-mono ck-pos focus:outline-none focus:border-[var(--color-display)]"
                  placeholder="@your_handle"
                />
              </CompactField>
              <CompactField label="wallet_to_bind">
                <input
                  value={wallet}
                  onChange={(e) => setWallet(e.target.value)}
                  className="bg-transparent border border-[var(--color-border-vis)] px-2 py-1 ck-mono ck-pos focus:outline-none focus:border-[var(--color-display)]"
                  placeholder="0x…"
                />
              </CompactField>
              <div className="px-2 py-2">
                <button type="submit" className="ck-btn">
                  REQUEST CHALLENGE →
                </button>
              </div>
            </form>
          )}

          {stage === "challenge" && challenge && (
            <div className="flex flex-col">
              <div className="px-2 py-1.5 border-b border-[var(--color-border)]">
                <p className="ck-label mb-1">CHALLENGE_TEXT — POST VERBATIM</p>
                <pre className="ck-mono ck-pos border border-[var(--color-border)] p-2 whitespace-pre-wrap break-words">
                  {challenge.challenge_text}
                </pre>
              </div>
              <div className="px-2 py-1.5 border-b border-[var(--color-border)]">
                <p className="ck-label mb-1">SIGN_MESSAGE — EIP-191 PERSONAL_SIGN</p>
                <pre className="ck-mono ck-pos border border-[var(--color-border)] p-2 whitespace-pre-wrap break-words">
                  {challenge.sign_message}
                </pre>
                <ol className="mt-2 ck-mono ck-dim list-decimal list-inside">
                  {challenge.instructions.map((step, i) => (
                    <li key={i}>{step}</li>
                  ))}
                </ol>
              </div>
              <CompactField label="signature_hex">
                <input
                  value={signature}
                  onChange={(e) => setSignature(e.target.value)}
                  className="bg-transparent border border-[var(--color-border-vis)] px-2 py-1 ck-mono ck-pos focus:outline-none focus:border-[var(--color-display)]"
                  placeholder="0x…"
                />
              </CompactField>
              <CompactField label="post_url">
                <input
                  value={postUrl}
                  onChange={(e) => setPostUrl(e.target.value)}
                  className="bg-transparent border border-[var(--color-border-vis)] px-2 py-1 ck-mono ck-pos focus:outline-none focus:border-[var(--color-display)]"
                  placeholder="https://x.com/your_handle/status/…"
                />
              </CompactField>
              <div className="px-2 py-2">
                <button onClick={finalize} className="ck-btn" type="button">
                  FINALIZE CLAIM →
                </button>
              </div>
            </div>
          )}

          {stage === "done" && finalized && (
            <div className="flex flex-col">
              <div className="px-2 py-1.5 ck-label ck-pos border-b border-[var(--color-border)]">
                [CLAIMED · VERIFIED]
              </div>
              <div className="px-2 py-1.5 border-b border-[var(--color-border)] ck-mono ck-dim">
                api_key shown ONCE. store it now.
              </div>
              <div className="px-2 py-1.5 border-b border-[var(--color-border)]">
                <p className="ck-label mb-1">API_KEY</p>
                <pre className="ck-mono ck-pos border border-[var(--color-border)] p-2 break-all">
                  {finalized.api_key}
                </pre>
              </div>
              <div className="px-2 py-2">
                <a href={`#/agents/${finalized.display_slug}`} className="ck-btn no-underline">
                  → SEE AGENT PROFILE
                </a>
              </div>
            </div>
          )}
        </Panel>
      </main>

      <footer className="flex items-center gap-3 px-2 py-1 border-t border-[var(--color-border)] ck-mono ck-dim">
        <a href="#/" className="ck-mono ck-dim hover:ck-pos no-underline">
          ← HOME
        </a>
        <span>·</span>
        <a href={`#/agents/${slug}`} className="ck-mono ck-dim hover:ck-pos no-underline">
          AGENT PROFILE
        </a>
        <span className="ml-auto ck-mono ck-dim">CLAIM · {slug}</span>
      </footer>
    </div>
  );
}

function CompactField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 px-2 py-1.5 border-b border-[var(--color-border)]">
      <span className="ck-label">{label}</span>
      {children}
    </label>
  );
}

function Step({
  n,
  active,
  done,
  label,
}: {
  n: number;
  active: boolean;
  done: boolean;
  label: string;
}) {
  const tone = active ? "ck-pos" : done ? "ck-dim" : "ck-dim";
  const marker = done ? "✓" : active ? "▶" : "·";
  return (
    <li
      className={
        "flex items-center gap-2 px-2 py-1.5 border-b border-[var(--color-border)] " + tone
      }
    >
      <span className="ck-mono w-3">{marker}</span>
      <span className="ck-label w-3">{n}</span>
      <span className="ck-mono">{label}</span>
    </li>
  );
}
