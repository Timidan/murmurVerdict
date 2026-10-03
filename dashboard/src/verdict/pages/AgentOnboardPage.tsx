// ─── AgentOnboardPage — full agent registration in one dashboard flow ─────
//
// Route: #/agent/onboard. Auth-gated.
//
// Per project_agent_self_onboarding (and the Q1-redux grilling decision):
// the human gives their bot ONE credential — `MURMUR_RUNTIME_KEY`. The Privy
// session NEVER leaves the dashboard browser. This page is the surface that
// produces that runtime key.
//
// The page chains seven calls in-browser, using the human's Privy
// embedded wallet to sign two challenges. External wallets are NOT used
// here: `useWallets()` returns any browser-injected wallet (MetaMask,
// etc.) regardless of whether the user actually linked it to their
// Privy account, so silently signing with one would produce confusing
// "I don't recognize this wallet" UX. We strictly filter on
// `walletClientType === "privy"` and provision an embedded wallet via
// `createWallet()` if missing.
//
//   1) POST /v1/account/agents               { display_slug, display_name }
//   2) POST /v1/account/agents/:slug/wallet/challenge { wallet_address, chain_id }
//   3) personal_sign the returned message via useSignMessage()
//   4) PATCH /v1/account/agents/:slug/wallet  { signature, ... }
//   5) POST /v1/account/agents/:slug/runtime-keys/challenge
//   6) personal_sign the runtime-key authorization message
//   7) POST /v1/account/agents/:slug/runtime-keys { signature, nonce, ... }
//
// On success the page opens RuntimeKeyMintModal which surfaces the
// plaintext runtime key once with the standard friction-loaded dismissal.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  getAccessToken,
  useCreateWallet,
  usePrivy,
  useSignMessage,
  useWallets,
  type ConnectedWallet,
} from "@privy-io/react-auth";
import { Ik, IkNav } from "../icons.js";
import { TopbarCrumb } from "../components/compact/TopbarCrumb.js";
import { InlineError } from "../components/compact/InlineError.js";
import { RuntimeKeyMintModal } from "../components/account/RuntimeKeyMintModal.js";
import { generateRuntimeKeySigningKeypair } from "../lib/runtime-key-signing.js";
import { useAccount } from "../hooks/useAccount.js";
import { verdictApi, ApiError, type RuntimeKeyMintResponse } from "../api.js";

const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/**
 * How long the field waits after a keystroke before asking whether the handle
 * is free. Short enough that it reads as an answer to the character just
 * typed, long enough that typing a whole handle costs one question and not
 * one per letter.
 */
const HANDLE_CHECK_DELAY_MS = 200;
/** How long a single check is allowed to hang before it is called unknown. */
const HANDLE_CHECK_TIMEOUT_MS = 6_000;

type HandleCheck =
  | { state: "idle" }
  | { state: "checking" | "free" | "taken" | "unknown"; slug: string };

const SLUG_MIN = 3;
const SLUG_MAX = 32;

type Phase =
  | "idle"
  | "creating-agent"
  | "challenging-wallet"
  | "signing-wallet"
  | "binding-wallet"
  | "challenging-runtime"
  | "signing-runtime"
  | "minting-runtime"
  | "done";

export function AgentOnboardPage() {
  const account = useAccount();
  const { ready, authenticated } = usePrivy();
  const { wallets } = useWallets();
  const { createWallet } = useCreateWallet();
  const { signMessage } = useSignMessage();

  const [slug, setSlug] = useState<string>("");
  // Whether the handle in the field is still free, answered while it is being
  // typed rather than at submit. The state carries the handle it describes so
  // a late answer about an earlier handle can be recognised and dropped.
  const [handleCheck, setHandleCheck] = useState<HandleCheck>({ state: "idle" });
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [minted, setMinted] = useState<RuntimeKeyMintResponse | null>(null);
  const [mintedSigning, setMintedSigning] = useState<string | null>(null);
  const [mintedSlug, setMintedSlug] = useState<string | null>(null);
  const [daemonChainId, setDaemonChainId] = useState<string | null>(null);
  const [metaFailed, setMetaFailed] = useState(false);
  // One automatic wallet-provision attempt. A failed one waits for the human.
  const [walletFailed, setWalletFailed] = useState(false);
  // When create-agent succeeds but a later step (sign, bind, mint) fails,
  // we've burned a slug — the operator can't re-create it. Surface a
  // recovery link so they can finish setup from #/account/agent/:slug
  // rather than re-typing a new slug and orphaning the first agent.
  const [strandedSlug, setStrandedSlug] = useState<string | null>(null);

  // Redirect to login when Privy is in a stable signed-out state.
  // AccountShell's AccountGuard normally blocks this page from mounting
  // unauthenticated, so this is defense-in-depth — clean path form (no
  // stacked `#/account/login` hash on a `/agent/onboard` path), replace()
  // so the guarded URL doesn't linger in history.
  useEffect(() => {
    if (!account.ready) return;
    if (account.isAuthenticated) return;
    const next = encodeURIComponent("/agent/onboard");
    window.location.replace(`/account/login?next=${next}`);
  }, [account.ready, account.isAuthenticated]);

  // Fetch the daemon's configured Fhenix chain id once. The bind/mint
  // signatures must be issued against this exact chain or the daemon
  // will reject them. Without it the button never enables, so a failure here
  // is said out loud instead of leaving a dead control.
  const loadDaemonChainId = useCallback(() => {
    setMetaFailed(false);
    verdictApi
      .meta()
      .then((meta) => {
        if (meta.fhenix?.chain_id) setDaemonChainId(meta.fhenix.chain_id);
        else setMetaFailed(true);
      })
      .catch(() => setMetaFailed(true));
  }, []);

  useEffect(() => {
    loadDaemonChainId();
  }, [loadDaemonChainId]);

  // Strictly resolve the Privy embedded wallet. We do NOT fall back to
  // wallets[0] — that would silently use any MetaMask account the
  // browser happens to surface, even if the user never linked it to
  // their Privy account. `useWallets()` returns ALL connected wallets
  // regardless of `linked` status (see Privy SDK docs), so the only
  // safe filter is `walletClientType === "privy"`.
  const embeddedWallet = useMemo<ConnectedWallet | null>(
    () => wallets.find((w) => w.walletClientType === "privy") ?? null,
    [wallets],
  );

  // Eager provision an embedded wallet for any authenticated user who
  // doesn't have one yet. Covers (a) returning users who previously
  // linked MetaMask (PrivyProvider's `users-without-wallets` skips
  // them) and (b) any timing race where Privy's auto-create hasn't
  // landed by mount. Re-entry is guarded by `provisioning` to avoid
  // double-mint.
  const [provisioning, setProvisioning] = useState(false);
  useEffect(() => {
    if (!ready || !authenticated) return;
    // `walletFailed` is the stop: without it the cleared `provisioning` flag
    // re-entered this effect and retried the same failing call forever.
    if (embeddedWallet || provisioning || walletFailed) return;
    setProvisioning(true);
    createWallet()
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error("[onboard] embedded wallet provision failed", err);
        setWalletFailed(true);
      })
      .finally(() => setProvisioning(false));
  }, [ready, authenticated, embeddedWallet, provisioning, walletFailed, createWallet]);

  const slugValid = useMemo(() => isValidSlug(slug), [slug]);

  /**
   * Ask whether the handle is taken, on every change to it.
   *
   * The route is the public agent profile: it answers 404 for exactly the
   * handles the create call would accept, because both resolve the same
   * `display_slug` column and the profile hides nothing that exists. Anything
   * cleverer here would be a second definition of "taken" to keep in step with
   * the first.
   *
   * Two things keep it honest under a fast typist. Each keystroke aborts the
   * request before it, so at most one is ever in flight; and the answer is
   * stored against the handle it was asked about, so a reply that arrives
   * after the field has moved on is discarded rather than rendered. The short
   * wait before asking is not a delay the typist can feel — it is what stops a
   * ten-character handle costing ten round trips to learn one fact.
   */
  useEffect(() => {
    if (!slugValid) {
      setHandleCheck({ state: "idle" });
      return;
    }
    const asked = slug;
    setHandleCheck({ state: "checking", slug: asked });
    const controller = new AbortController();

    // A request that never answers would leave the field saying "checking"
    // and the button disabled for as long as the operator cared to wait.
    // `fetch` has no timeout of its own, so the stall gets one here.
    const stall = window.setTimeout(() => {
      controller.abort();
      setHandleCheck({ state: "unknown", slug: asked });
    }, HANDLE_CHECK_TIMEOUT_MS);

    const timer = window.setTimeout(() => {
      verdictApi
        .agent(asked, controller.signal)
        .then(() => {
          window.clearTimeout(stall);
          setHandleCheck({ state: "taken", slug: asked });
        })
        .catch((err: unknown) => {
          window.clearTimeout(stall);
          // Aborted either by the next keystroke or by the stall above, and
          // both have already said what they mean.
          if (controller.signal.aborted) return;
          if (err instanceof ApiError && err.status === 404) {
            setHandleCheck({ state: "free", slug: asked });
            return;
          }
          // A check that could not run is not a handle that is taken. Say so
          // and leave the button alone: the create call rejects a duplicate on
          // its own, and blocking here would strand an operator behind a
          // network blip.
          setHandleCheck({ state: "unknown", slug: asked });
        });
    }, HANDLE_CHECK_DELAY_MS);

    return () => {
      window.clearTimeout(timer);
      window.clearTimeout(stall);
      controller.abort();
    };
  }, [slug, slugValid]);

  // Only an answer about the handle currently in the field counts.
  const handleState =
    handleCheck.state !== "idle" && handleCheck.slug === slug
      ? handleCheck.state
      : "idle";
  const inFlight = phase !== "idle" && phase !== "done";
  const canSubmit =
    slugValid &&
    handleState !== "taken" &&
    handleState !== "checking" &&
    Boolean(embeddedWallet) &&
    !inFlight &&
    ready &&
    authenticated &&
    Boolean(daemonChainId);

  const submit = useCallback(async () => {
    if (!canSubmit) return;
    setError(null);

    const displayName = toTitleCase(slug);
    const token = await getAccessToken();
    if (!token) {
      setError("Sign-in expired. Refresh and sign in again.");
      return;
    }

    // Strictly embedded. The `canSubmit` guard above already blocks the
    // button until `embeddedWallet` exists (the eager `useEffect`
    // provisions one if missing), so by the time we land here we have
    // a Privy embedded wallet. Cast to `!` rather than re-checking;
    // double-guarding muddles the contract.
    const walletAddress = embeddedWallet!.address;

    let agentCreatedSlug: string | null = null;
    // Track which step threw so the catch block can pick the right
    // recovery message — React state updates inside this callback don't
    // synchronously rewrite `phase` in this closure.
    let attemptedPhase: Phase = "idle";
    try {
      // 1. Create the agent row.
      attemptedPhase = "creating-agent";
      setPhase("creating-agent");
      await verdictApi.postCreateAgent(token, {
        display_slug: slug,
        display_name: displayName,
      });
      agentCreatedSlug = slug;

      // 2. Get the wallet-bind challenge.
      attemptedPhase = "challenging-wallet";
      setPhase("challenging-wallet");
      const walletChallenge = await verdictApi.postControllerWalletChallenge(
        token,
        slug,
        {
          wallet_address: walletAddress,
          chain_id: daemonChainId!,
          wallet_kind: "embedded",
          provider: "privy",
        },
      );

      // 3. Sign the wallet-bind message.
      attemptedPhase = "signing-wallet";
      setPhase("signing-wallet");
      const walletSig = await signMessage(
        { message: walletChallenge.message },
        { address: walletAddress },
      );

      // 4. Bind the wallet.
      attemptedPhase = "binding-wallet";
      setPhase("binding-wallet");
      await verdictApi.patchAgentWallet(token, slug, {
        wallet_address: walletAddress,
        chain_id: daemonChainId!,
        wallet_kind: "embedded",
        provider: "privy",
        authorization_issued_at: walletChallenge.authorization_issued_at,
        signature: walletSig.signature,
      });

      // 5. Get the runtime-key authorization challenge. The PoP keypair is
      // generated first so its public half sits inside the policy the
      // controller wallet signs (unsupported browsers fail loud here rather
      // than silently minting a weaker bearer-only key).
      attemptedPhase = "challenging-runtime";
      setPhase("challenging-runtime");
      const rkSigning = await generateRuntimeKeySigningKeypair();
      const rkPolicy = { signing_pubkey: rkSigning.publicKeyHex };
      const rkChallenge = await verdictApi.postRuntimeKeyChallenge(
        token,
        slug,
        { policy: rkPolicy },
      );

      // 6. Sign the runtime-key authorization.
      attemptedPhase = "signing-runtime";
      setPhase("signing-runtime");
      const rkSig = await signMessage(
        { message: rkChallenge.message },
        { address: walletAddress },
      );

      // 7. Mint the runtime key.
      attemptedPhase = "minting-runtime";
      setPhase("minting-runtime");
      const result = await verdictApi.postRuntimeKey(token, slug, {
        policy: rkPolicy,
        authorization_nonce: rkChallenge.authorization_nonce,
        authorization_issued_at: rkChallenge.authorization_issued_at,
        signature: rkSig.signature,
      });

      setMintedSigning(rkSigning.privateKeyPkcs8Base64);
      setMinted(result);
      setMintedSlug(slug);
      setPhase("done");
      void account.refreshAgents();
    } catch (err) {
      const message = (err as Error)?.message ?? "unknown error";
      setError(formatError(attemptedPhase, message));
      setPhase("idle");
      // If create-agent succeeded but a later step failed, the slug is
      // burned. Surface a deep-link so the operator can finish setup at
      // /wallet + /runtime tabs of the per-agent settings page rather
      // than retyping a new slug and orphaning the first row.
      if (agentCreatedSlug && attemptedPhase !== "creating-agent") {
        setStrandedSlug(agentCreatedSlug);
        void account.refreshAgents();
      }
    }
  }, [
    canSubmit,
    slug,
    daemonChainId,
    signMessage,
    embeddedWallet,
    account,
  ]);

  const onModalDone = useCallback(() => {
    setMinted(null);
    setMintedSlug(null);
    // Refresh the cached agent list so /account shows the new agent
    // immediately after the modal closes. Clean path — assigning a hash
    // here would stack `#/account` onto the `/agent/onboard` path.
    void account.refreshAgents();
    window.location.assign("/account");
  }, [account]);

  if (!account.configured) {
    return (
      <Shell>
        <p className="ck-neg">
          Sign-in is not available right now. Try again later.
        </p>
      </Shell>
    );
  }

  if (!account.ready) {
    return <Shell><p className="ck-dim">Loading…</p></Shell>;
  }

  if (!account.isAuthenticated) {
    return <Shell><p className="ck-dim">Redirecting to sign in…</p></Shell>;
  }

  return (
    <Shell>
      <section className="flex flex-col gap-3">
        <h2 className="ck-label" id="handle-label">Agent handle</h2>
        <p className="ck-dim text-xs">
          The public name people see on the leaderboard. Lowercase letters,
          numbers, and dashes.
        </p>
        <input
          type="text"
          value={slug}
          onChange={(e) => setSlug(e.target.value.trim())}
          maxLength={SLUG_MAX}
          placeholder="my-bot"
          disabled={inFlight}
          autoFocus
          aria-labelledby="handle-label"
          className={
            "self-start w-[28ch] max-w-full min-w-0 border bg-[var(--color-bg)] ck-mono px-3 py-2 " +
            (slug.length === 0 || (slugValid && handleState !== "taken")
              ? "border-[var(--color-border-vis)]"
              : "border-[var(--color-accent-ink)]")
          }
          aria-invalid={slug.length > 0 && (!slugValid || handleState === "taken")}
          aria-describedby="handle-status"
        />
        {slug.length > 0 && !slugValid && (
          <span className="ck-neg text-xs">
            Use only lowercase letters, numbers, and dashes ({SLUG_MIN}-{SLUG_MAX}{" "}
            characters).
          </span>
        )}
        {/* One line, spoken once. `aria-live` is polite rather than assertive
            because this arrives while somebody is still typing, and an
            assertive region would interrupt them mid-word to say "checking". */}
        <span aria-live="polite" className="text-xs" id="handle-status">
          {!slugValid ? null : handleState === "taken" ? (
            <span className="ck-neg">
              <span className="ck-mono">{slug}</span> is taken. Try another
              handle.
            </span>
          ) : handleState === "checking" ? (
            <span className="ck-dim">Checking whether it is free…</span>
          ) : handleState === "unknown" ? (
            <span className="ck-dim">
              Could not check that handle just now. You can still continue —
              a handle already in use is refused when the agent is created.
            </span>
          ) : (
            <span className="ck-dim">
              {handleState === "free" ? (
                <>
                  <span className="ck-pos">Free.</span>{" "}
                </>
              ) : null}
              Shown as <span className="ck-pos">"{toTitleCase(slug)}"</span>.
              You can change this later.
            </span>
          )}
        </span>
      </section>

      <section className="flex flex-col gap-2 mt-6">
        <button
          type="button"
          onClick={() => void submit()}
          disabled={!canSubmit}
          className={
            "self-start t-button inline-flex items-center gap-1.5 " +
            "border border-[var(--color-display)] " +
            "text-[var(--color-display)] px-4 py-2 hover:bg-[var(--color-display)] " +
            "hover:text-[var(--color-bg)] disabled:opacity-50 " +
            "disabled:cursor-not-allowed press-feedback ck-mono"
          }
          title={
            (!daemonChainId || !embeddedWallet) && !metaFailed && !walletFailed
              ? "Getting ready…"
              : ""
          }
        >
          {inFlight ? (
            phaseLabel(phase)
          ) : (
            <>
              <Ik name="agent" />
              Create agent
            </>
          )}
        </button>
        <span className="ck-dim text-xs">
          Your wallet will ask you to approve two signatures. The first binds
          the wallet to this agent. The second authorizes the agent's runtime
          key.
        </span>
        {!embeddedWallet && !inFlight && !walletFailed && (
          <span className="ck-dim text-xs">Setting up your signing key…</span>
        )}
        {walletFailed && (
          <span className="flex flex-wrap items-center gap-2">
            <InlineError
              error="murmur could not create your signing wallet."
              className="text-xs"
            />
            <button
              type="button"
              onClick={() => setWalletFailed(false)}
              className="ck-btn ck-btn-bracket"
            >
              try again
            </button>
          </span>
        )}
        {metaFailed && (
          <span className="flex flex-wrap items-center gap-2">
            <InlineError
              error="murmur could not read this deployment's chain settings, so it cannot create an agent yet."
              className="text-xs"
            />
            <button
              type="button"
              onClick={loadDaemonChainId}
              className="ck-btn ck-btn-bracket"
            >
              try again
            </button>
          </span>
        )}
        {error && <InlineError error={error} className="text-xs" />}
        {strandedSlug && (
          <div className="border border-[var(--color-accent-ink)] p-3 ck-mono flex flex-col gap-2 mt-1">
            <span className="ck-neg">
              murmur created{" "}
              <span className="ck-pos">{strandedSlug}</span> but could not
              finish the setup. Continue below so you do not create a second
              agent.
            </span>
            <a
              href={`/account/agent/${encodeURIComponent(strandedSlug)}/wallet`}
              className="ck-pos no-underline hover:underline self-start"
            >
              Continue setup →
            </a>
          </div>
        )}
      </section>


      {minted && mintedSlug && (
        <RuntimeKeyMintModal
          result={minted}
          slug={mintedSlug}
          signingPrivateKey={mintedSigning}
          onDone={onModalDone}
        />
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex-1 flex flex-col min-h-0">
      <TopbarCrumb><span>
            murmur <span className="ck-dim mx-1">·</span>
            <span className="ck-pos">add agent</span>
          </span></TopbarCrumb>
      <main className="flex-1 max-w-2xl w-full self-center p-4 flex flex-col gap-4">
        {/* ck-title-ik: the `agent` glyph REPLACES the generic ::before
            square — one marker per title, never two. */}
        <h1 className="ck-title ck-title-ik">
          <IkNav name="agent" /> Create an agent
        </h1>
        {children}
      </main>
    </div>
  );
}

function isValidSlug(slug: string): boolean {
  if (slug.length < SLUG_MIN || slug.length > SLUG_MAX) return false;
  return SLUG_PATTERN.test(slug);
}

function toTitleCase(slug: string): string {
  return slug
    .split(/-+/)
    .filter(Boolean)
    .map((seg) => seg.charAt(0).toUpperCase() + seg.slice(1).toLowerCase())
    .join(" ");
}

function phaseLabel(p: Phase): string {
  // Collapse the seven protocol steps to three consumer states. Users
  // care about: "is the system working", "do I need to do something",
  // "is it almost done" — not which API call is in flight.
  switch (p) {
    case "creating-agent":
      return "Creating agent…";
    case "signing-wallet":
    case "signing-runtime":
      return "Approve in your wallet…";
    case "challenging-wallet":
    case "binding-wallet":
    case "challenging-runtime":
    case "minting-runtime":
      return "Almost done…";
    default:
      return "Working…";
  }
}

function formatError(failedAt: Phase, raw: string): string {
  // Slug-collision is the highest-frequency 409 here.
  if (failedAt === "creating-agent" && /409|duplicate|already/i.test(raw)) {
    return "That handle is already taken. Pick another.";
  }
  if (/signature|sign(_|-)?message|user.+(reject|denied)/i.test(raw)) {
    return "Signature declined. Approve in your wallet to continue.";
  }
  return raw;
}
