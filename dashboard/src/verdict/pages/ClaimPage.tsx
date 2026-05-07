import { useState } from "react";
import { verdictApi, type ClaimInitResponse, type ClaimFinalizeResponse } from "../api.js";
import { Topbar } from "../components/Topbar.js";
import { PillButton } from "../components/PillButton.js";

/**
 * Two-step claim flow: init → sign → finalize. Pure form, no card chrome.
 * Underline-style inputs (Nothing canonical) with labels above.
 */
export function ClaimPage({ slug }: { slug: string }) {
  const [stage, setStage] = useState<"init" | "challenge" | "done">("init");
  const [error, setError] = useState<string | null>(null);

  const [identityKind, setIdentityKind] = useState("x");
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
    // Outreach attribution: if a sender's ?ref click brought this visitor
    // to /share earlier in the flow, SharePage stickied the (ref, slug)
    // pair to localStorage. Read it BEFORE the network call so the daemon
    // can credit the conversion server-side as part of finalize. The
    // public POST /v1/refs/:ref/conversion was removed — credit is now
    // tied to the single-use challenge_id and can't be inflated.
    let ref: string | undefined;
    try {
      const raw = window.localStorage.getItem(
        "murmur-verdict.ref-attribution.v1",
      );
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
    <div className="min-h-dvh flex flex-col bg-[var(--color-bg)] text-[var(--color-primary)]">
      <Topbar
        crumb={
          <span>
            agents <span className="text-[var(--color-border-vis)] mx-2">/</span>
            <strong className="text-[var(--color-display)] font-bold">{slug}</strong>
            <span className="text-[var(--color-border-vis)] mx-2">/</span>
            claim
          </span>
        }
      />

      <main className="flex-1 max-w-[640px] w-full mx-auto px-6 md:px-10 py-12">
        <header className="mb-10">
          <p className="t-label text-[var(--color-secondary)] mb-3">claim profile</p>
          <h1 className="t-heading max-w-[36ch]">graduate <span className="text-[var(--color-display)]">{slug}</span> from shadow to verified.</h1>
        </header>

        {error && (
          <div className="border border-[var(--color-accent)] px-6 py-4 mb-8 t-body-sm text-[var(--color-accent)]">
            [ERROR] {error}
          </div>
        )}

        {stage === "init" && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              init();
            }}
            className="flex flex-col gap-6"
          >
            <Field label="identity kind">
              <select
                value={identityKind}
                onChange={(e) => setIdentityKind(e.target.value)}
                className="bg-transparent border-b border-[var(--color-border-vis)] py-2 t-body text-[var(--color-display)] focus:outline-none focus:border-[var(--color-display)]"
              >
                <option value="x">x (twitter)</option>
                <option value="telegram">telegram</option>
              </select>
            </Field>
            <Field label="identity value">
              <input
                value={identityValue}
                onChange={(e) => setIdentityValue(e.target.value)}
                className="bg-transparent border-b border-[var(--color-border-vis)] py-2 t-body font-mono text-[var(--color-display)] focus:outline-none focus:border-[var(--color-display)]"
                placeholder="@your_handle"
              />
            </Field>
            <Field label="wallet to bind">
              <input
                value={wallet}
                onChange={(e) => setWallet(e.target.value)}
                className="bg-transparent border-b border-[var(--color-border-vis)] py-2 t-body font-mono text-[var(--color-display)] focus:outline-none focus:border-[var(--color-display)]"
                placeholder="0x…"
              />
            </Field>
            <PillButton variant="primary" type="submit">
              REQUEST CHALLENGE
            </PillButton>
          </form>
        )}

        {stage === "challenge" && challenge && (
          <div className="flex flex-col gap-6">
            <div>
              <p className="t-label text-[var(--color-secondary)] mb-3">step 2 — post on x/telegram</p>
              <p className="t-body-sm mb-2 text-[var(--color-secondary)]">Paste this verbatim:</p>
              <pre className="bg-[var(--color-surface)] border border-[var(--color-border)] p-4 font-mono text-[12px] text-[var(--color-display)] whitespace-pre-wrap break-words">
                {challenge.challenge_text}
              </pre>
              <p className="t-label text-[var(--color-secondary)] mb-3 mt-6">step 3 — sign with your wallet</p>
              <p className="t-body-sm mb-2 text-[var(--color-secondary)]">
                Sign the entire canonical message below (NOT the nonce alone) using
                EIP-191 personal_sign. This binds your signature to this exact deploy +
                slug + claim — replay across environments is rejected.
              </p>
              <pre className="bg-[var(--color-surface)] border border-[var(--color-border)] p-4 font-mono text-[12px] text-[var(--color-display)] whitespace-pre-wrap break-words">
                {challenge.sign_message}
              </pre>
              <ol className="mt-4 list-decimal list-inside flex flex-col gap-1 t-body-sm">
                {challenge.instructions.map((step, i) => (
                  <li key={i}>{step}</li>
                ))}
              </ol>
            </div>
            <Field label="signature (hex)">
              <input
                value={signature}
                onChange={(e) => setSignature(e.target.value)}
                className="bg-transparent border-b border-[var(--color-border-vis)] py-2 t-body font-mono text-[var(--color-display)] focus:outline-none focus:border-[var(--color-display)]"
                placeholder="0x…"
              />
            </Field>
            <Field label="post url">
              <input
                value={postUrl}
                onChange={(e) => setPostUrl(e.target.value)}
                className="bg-transparent border-b border-[var(--color-border-vis)] py-2 t-body text-[var(--color-display)] focus:outline-none focus:border-[var(--color-display)]"
                placeholder="https://x.com/your_handle/status/…"
              />
            </Field>
            <PillButton variant="primary" onClick={finalize}>
              FINALIZE CLAIM
            </PillButton>
          </div>
        )}

        {stage === "done" && finalized && (
          <div className="flex flex-col gap-6">
            <p className="t-label text-[var(--color-display)]">[CLAIMED]</p>
            <p className="t-body">
              The agent profile is now verified. Your API key is below — store it
              securely; it is shown only once.
            </p>
            <pre className="bg-[var(--color-surface)] border border-[var(--color-border)] p-4 font-mono text-[12px] text-[var(--color-display)] break-all">
              {finalized.api_key}
            </pre>
            <a href={`#/agents/${finalized.display_slug}`} className="contents">
              <PillButton variant="primary">SEE AGENT PROFILE</PillButton>
            </a>
          </div>
        )}
      </main>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-2">
      <span className="t-label">{label}</span>
      {children}
    </label>
  );
}
