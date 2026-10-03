// ─── ControllerWalletPanel ────────────────────────────────────────────────
// Per-agent controller wallet binding: unbound, bound, or overdue for
// re-attestation. The daemon's challenge supplies the exact message to sign;
// the dashboard never composes it.

import { useEffect, useState, type ReactNode } from "react";
import { usePrivy, useSignMessage, useWallets, useCreateWallet } from "@privy-io/react-auth";
import { verdictApi, type AccountAgent } from "../../api.js";
import { getAccessToken } from "@privy-io/react-auth";
import { Ik } from "../../icons.js";
import { shortId } from "../../lib/display-format.js";
import { InlineError } from "../compact/InlineError.js";
import { TimeAgo } from "../compact/TimeAgo.js";

interface ControllerWalletPanelProps {
  slug: string;
  agent: AccountAgent | null;
  /** Fired after a successful bind or re-attest. */
  onAgentChanged?: () => Promise<void> | void;
}

type BusyState = "idle" | "challenging" | "signing" | "submitting";

export function ControllerWalletPanel({ slug, agent, onAgentChanged }: ControllerWalletPanelProps) {
  const { ready, authenticated } = usePrivy();
  const { wallets } = useWallets();
  const { createWallet } = useCreateWallet();
  const { signMessage } = useSignMessage();

  const [busy, setBusy] = useState<BusyState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [daemonChainId, setDaemonChainId] = useState<string | null>(null);

  // Privy creates embedded wallets only for users who signed in without a
  // wallet. Wallet-first users need the linked external EVM wallet path.
  const embeddedWallet = wallets.find((w) => w.walletClientType === "privy") ?? null;
  const externalWallet =
    wallets.find((w) => w.walletClientType !== "privy" && Boolean(w.address)) ?? null;

  // Clear errors when the agent record updates (e.g. after a successful bind).
  useEffect(() => {
    setError(null);
  }, [agent?.controller_wallet?.last_attested_at]);

  // Fetch the daemon's Fhenix chain once; the bind/reattest signatures must
  // use this exact chain or the backend will reject the binding.
  useEffect(() => {
    let cancelled = false;
    verdictApi
      .meta()
      .then((meta) => {
        if (cancelled) return;
        if (meta.fhenix?.chain_id) setDaemonChainId(meta.fhenix.chain_id);
      })
      .catch(() => {
        // Surface the failure when the user actually tries to bind.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const cw = agent?.controller_wallet ?? null;
  const state: "unbound" | "bound" | "overdue" = !cw
    ? "unbound"
    : cw.reattestation_overdue
      ? "overdue"
      : "bound";

  async function ensureControllerWallet(): Promise<{
    address: string;
    chainId: string;
    walletKind: "embedded" | "external";
    provider: string;
  } | null> {
    if (!daemonChainId) {
      setError(
        "The daemon has not reported its chain yet. Reload once it is configured.",
      );
      return null;
    }
    if (embeddedWallet) {
      return {
        address: embeddedWallet.address,
        chainId: daemonChainId,
        walletKind: "embedded",
        provider: "privy",
      };
    }
    if (externalWallet) {
      return {
        address: externalWallet.address,
        chainId: daemonChainId,
        walletKind: "external",
        provider: externalWallet.walletClientType || "privy-external",
      };
    }
    try {
      const created = await createWallet();
      return {
        address: created.address,
        chainId: daemonChainId,
        walletKind: "embedded",
        provider: "privy",
      };
    } catch (e) {
      setError((e as Error)?.message ?? "unable to create a wallet. retry, or reload the page.");
      return null;
    }
  }

  async function bind() {
    setError(null);
    if (!ready || !authenticated) {
      setError("Sign in first.");
      return;
    }
    const wallet = await ensureControllerWallet();
    if (!wallet) return;
    const token = await getAccessToken();
    if (!token) {
      setError("Your session expired. Sign in again.");
      return;
    }
    try {
      setBusy("challenging");
      const challenge = await verdictApi.postControllerWalletChallenge(token, slug, {
        wallet_address: wallet.address,
        chain_id: wallet.chainId,
        wallet_kind: wallet.walletKind,
        provider: wallet.provider,
      });
      setBusy("signing");
      // Pin the signer; Privy otherwise defaults to embedded HD index 0.
      const { signature } = await signMessage(
        { message: challenge.message },
        { address: wallet.address },
      );
      setBusy("submitting");
      await verdictApi.patchAgentWallet(token, slug, {
        wallet_address: wallet.address,
        chain_id: wallet.chainId,
        wallet_kind: wallet.walletKind,
        provider: wallet.provider,
        authorization_issued_at: challenge.authorization_issued_at,
        signature,
      });
    } catch (e) {
      setError(`We could not bind the wallet — ${(e as Error)?.message ?? "unknown error"}`);
      setBusy("idle");
      return;
    }
    setBusy("idle");
    // Refresh the parent so sibling panels see the new binding.
    try {
      await onAgentChanged?.();
    } catch (e) {
      setError(
        "The wallet is bound, but this page could not refresh. Reload it to see the latest state: " +
          ((e as Error)?.message ?? "unknown"),
      );
    }
  }

  async function reattest() {
    setError(null);
    if (!ready || !authenticated || !cw) return;
    const connectedControllerWallet = wallets.find((wallet) =>
      sameAddress(wallet.address, cw.wallet_address),
    );
    if (!connectedControllerWallet) {
      setError(
        "Connect the bound controller wallet first. It has to sign this.",
      );
      return;
    }
    const token = await getAccessToken();
    if (!token) {
      setError("Your session expired. Sign in again.");
      return;
    }
    try {
      setBusy("challenging");
      const challenge = await verdictApi.postControllerWalletReattestationChallenge(token, slug);
      setBusy("signing");
      // Pin signer to the previously-bound controller wallet — daemon
      // validates the signature recovers to cw.wallet_address.
      const { signature } = await signMessage(
        { message: challenge.message },
        { address: cw.wallet_address },
      );
      setBusy("submitting");
      await verdictApi.postControllerWalletReattestation(token, slug, {
        attestation_nonce: challenge.attestation_nonce,
        authorization_issued_at: challenge.authorization_issued_at,
        signature,
      });
    } catch (e) {
      setError(`We could not renew the signature — ${(e as Error)?.message ?? "unknown error"}`);
      setBusy("idle");
      return;
    }
    setBusy("idle");
    try {
      await onAgentChanged?.();
    } catch (e) {
      setError(
        "The signature is renewed, but this page could not refresh. Reload it to see the latest state: " +
          ((e as Error)?.message ?? "unknown"),
      );
    }
  }

  return (
    <section className="ck-frame w-full px-4 py-4 flex flex-col gap-3">
      <header className="flex items-center justify-between">
        <h3 className="ck-title ck-title-ik">
          <Ik name="controller-wallet" /> Controller wallet
        </h3>
        <StateBadge state={state} />
      </header>

      {state === "unbound" && (
        <>
          <p className="ck-dim text-[12px]">
            No wallet is bound yet. You sign one message, and that lets this
            account mint runtime keys for {slug}. It signs with your murmur
            wallet, or your connected wallet if you have one. A signature only,
            never a transaction.
          </p>
          <button
            className="ck-btn ck-btn-bracket self-start"
            onClick={bind}
            disabled={busy !== "idle" || !ready}
          >
            <Ik name="controller-wallet" />
            {busy === "idle" ? "bind a controller wallet" : <BusyLabel busy={busy} />}
          </button>
        </>
      )}

      {(state === "bound" || state === "overdue") && cw && (
        <>
          <KV k="Address" v={shortAddr(cw.wallet_address)} title={cw.wallet_address} />
          <KV k="Kind" v={cw.wallet_kind} />
          <KV k="Provider" v={cw.provider ?? "—"} />
          <KV
            k="Chain"
            v={cw.chain_id}
            tone={daemonChainId && cw.chain_id !== daemonChainId ? "neg" : undefined}
          />
          <KV k="Bound" v={<TimeAgo iso={cw.created_at} />} />
          <KV
            k="Last signed"
            v={<TimeAgo iso={cw.last_attested_at} />}
          />
          <KV
            k="Sign again by"
            v={<TimeAgo iso={cw.reattestation_due_at} />}
            tone={state === "overdue" ? "neg" : "dim"}
          />
          {daemonChainId && cw.chain_id !== daemonChainId && (
            <>
              <p className="text-[12px]" style={{ color: "var(--color-accent-ink)" }}>
                × Wrong chain. This wallet is bound to {cw.chain_id}, but the
                daemon runs on {daemonChainId}. The gateway will reject calls
                from its keys. Bind the wallet again on the daemon's chain.
              </p>
              <button
                className="ck-btn ck-btn-bracket self-start"
                onClick={bind}
                disabled={busy !== "idle" || !ready}
              >
                <Ik name="controller-wallet" />
                {busy === "idle" ? "bind again on " + daemonChainId : <BusyLabel busy={busy} />}
              </button>
            </>
          )}
          {state === "bound" && (
            <>
              <button
                className="ck-btn ck-btn-bracket self-start"
                onClick={reattest}
                disabled={busy !== "idle" || !ready}
                title="sign a fresh attestation for this controller wallet. It resets the clock and keeps your runtime keys minting without a gap."
              >
                <Ik name="attest" />
                {busy === "idle" ? "sign again now" : <BusyLabel busy={busy} />}
              </button>
            </>
          )}
          {state === "overdue" && (
            <>
              <p className="text-[12px]" style={{ color: "var(--color-accent-ink)" }}>
                × This wallet needs a fresh signature. Sign one to keep minting
                runtime keys.
              </p>
              <button
                className="ck-btn ck-btn-bracket self-start"
                onClick={reattest}
                disabled={busy !== "idle" || !ready}
              >
                <Ik name="attest" />
                {busy === "idle" ? "sign now" : <BusyLabel busy={busy} />}
              </button>
            </>
          )}
        </>
      )}

      {error && <InlineError error={error} className="text-[12px]" />}
    </section>
  );
}

function busyLabel(b: BusyState): string {
  if (b === "challenging") return "Preparing…";
  if (b === "signing") return "Approve in your wallet…";
  if (b === "submitting") return "Saving…";
  return "…";
}

/** Busy label shared by the signing CTAs; each keeps its glyph outside it. */
function BusyLabel({ busy }: { busy: BusyState }) {
  return <>{busyLabel(busy)}</>;
}

function shortAddr(addr: string): string {
  return shortId(addr, 8, 6);
}

function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  return Boolean(a && b && a.toLowerCase() === b.toLowerCase());
}

function StateBadge({ state }: { state: "unbound" | "bound" | "overdue" }) {
  const map: Record<typeof state, { label: string; tone: string }> = {
    unbound: { label: "Not bound", tone: "ck-dim" },
    bound: { label: "Bound", tone: "ck-pos" },
    overdue: { label: "Needs a signature", tone: "ck-neg" },
  };
  const { label, tone } = map[state];
  return <span className={`text-[12px] ${tone}`}>{label}</span>;
}

function KV({ k, v, tone, title }: { k: string; v: ReactNode; tone?: "dim" | "neg"; title?: string }) {
  const toneClass = tone === "neg" ? "ck-neg" : tone === "dim" ? "ck-dim" : "ck-pos";
  return (
    <div className="grid grid-cols-[120px_1fr] gap-2 text-[12px]">
      <span className="ck-label">{k}</span>
      <span className={`${toneClass} truncate`} title={title}>{v}</span>
    </div>
  );
}
