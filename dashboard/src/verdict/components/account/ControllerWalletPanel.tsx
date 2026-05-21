// ─── ControllerWalletPanel — Surface 2 Wave 1 ─────────────────────────────
//
// Renders the per-agent Controller Wallet binding panel inside the agent
// settings tab strip. Three states:
//   · UNBOUND       → user has no `controller_wallet` yet; offer Bind
//   · BOUND         → show address + provider + last-attested + due-at
//   · OVERDUE       → bound but `reattestation_overdue=true`; offer Re-attest
//
// The signing pathway uses Privy's `useSignMessage` against whichever wallet
// is active for the authenticated user (embedded by default). The daemon's
// challenge route returns the exact `message` text the user must personal_sign;
// the dashboard never composes the message itself. That keeps the binding
// invariants entirely server-controlled.

import { useEffect, useState } from "react";
import { usePrivy, useSignMessage, useWallets, useCreateWallet } from "@privy-io/react-auth";
import { verdictApi, type AccountAgent } from "../../api.js";
import { useAccount } from "../../hooks/useAccount.js";
import { getAccessToken } from "@privy-io/react-auth";

interface ControllerWalletPanelProps {
  slug: string;
  agent: AccountAgent | null;
}

type BusyState = "idle" | "challenging" | "signing" | "submitting";

export function ControllerWalletPanel({ slug, agent }: ControllerWalletPanelProps) {
  const account = useAccount();
  const { ready, authenticated } = usePrivy();
  const { wallets } = useWallets();
  const { createWallet } = useCreateWallet();
  const { signMessage } = useSignMessage();

  const [busy, setBusy] = useState<BusyState>("idle");
  const [error, setError] = useState<string | null>(null);

  // Pick an embedded wallet if one exists; otherwise we'll provision below.
  const embeddedWallet = wallets.find((w) => w.walletClientType === "privy") ?? null;

  // Clear errors when the agent record updates (e.g. after a successful bind).
  useEffect(() => {
    setError(null);
  }, [agent?.controller_wallet?.last_attested_at]);

  const cw = agent?.controller_wallet ?? null;
  const state: "unbound" | "bound" | "overdue" = !cw
    ? "unbound"
    : cw.reattestation_overdue
      ? "overdue"
      : "bound";

  // Privy embedded wallets are chain-agnostic by design; the binding
  // `chain_id` is identity metadata only. Pin to Base mainnet — Murmur's
  // canonical deploy target — so the binding message is deterministic.
  const DEFAULT_CONTROLLER_CHAIN_ID = "eip155:8453";

  async function ensureEmbeddedWallet(): Promise<{ address: string; chainId: string } | null> {
    if (embeddedWallet) {
      return { address: embeddedWallet.address, chainId: DEFAULT_CONTROLLER_CHAIN_ID };
    }
    try {
      const created = await createWallet();
      return { address: created.address, chainId: DEFAULT_CONTROLLER_CHAIN_ID };
    } catch (e) {
      setError((e as Error)?.message ?? "could not provision embedded wallet");
      return null;
    }
  }

  async function bind() {
    setError(null);
    if (!ready || !authenticated) {
      setError("sign in with Privy first");
      return;
    }
    const wallet = await ensureEmbeddedWallet();
    if (!wallet) return;
    const token = await getAccessToken();
    if (!token) {
      setError("could not get Privy access token");
      return;
    }
    try {
      setBusy("challenging");
      const challenge = await verdictApi.postControllerWalletChallenge(token, slug, {
        wallet_address: wallet.address,
        chain_id: wallet.chainId,
        wallet_kind: "embedded",
        provider: "privy",
      });
      setBusy("signing");
      const { signature } = await signMessage({ message: challenge.message });
      setBusy("submitting");
      await verdictApi.patchAgentWallet(token, slug, {
        wallet_address: wallet.address,
        chain_id: wallet.chainId,
        wallet_kind: "embedded",
        provider: "privy",
        authorization_issued_at: challenge.authorization_issued_at,
        signature,
      });
      await account.refreshAgents();
    } catch (e) {
      setError((e as Error)?.message ?? "bind failed");
    } finally {
      setBusy("idle");
    }
  }

  async function reattest() {
    setError(null);
    if (!ready || !authenticated || !cw) return;
    const token = await getAccessToken();
    if (!token) {
      setError("could not get Privy access token");
      return;
    }
    try {
      setBusy("challenging");
      const challenge = await verdictApi.postControllerWalletReattestationChallenge(token, slug);
      setBusy("signing");
      const { signature } = await signMessage({ message: challenge.message });
      setBusy("submitting");
      await verdictApi.postControllerWalletReattestation(token, slug, {
        attestation_nonce: challenge.attestation_nonce,
        authorization_issued_at: challenge.authorization_issued_at,
        signature,
      });
      await account.refreshAgents();
    } catch (e) {
      setError((e as Error)?.message ?? "re-attest failed");
    } finally {
      setBusy("idle");
    }
  }

  return (
    <section className="ck-frame w-full max-w-[720px] px-4 py-4 flex flex-col gap-3">
      <header className="flex items-baseline justify-between">
        <h3 className="ck-label">controller wallet</h3>
        <StateBadge state={state} />
      </header>

      {state === "unbound" && (
        <>
          <p className="ck-mono ck-dim text-[11px]">
            no wallet bound yet. binding signs a one-time message that authorizes
            this account to mint runtime keys for {slug}. uses your Privy
            embedded wallet — no MetaMask, no gas.
          </p>
          <button
            className="ck-btn self-start"
            onClick={bind}
            disabled={busy !== "idle" || !ready}
          >
            {busy === "idle" ? "[ bind controller wallet ]" : busyLabel(busy)}
          </button>
        </>
      )}

      {(state === "bound" || state === "overdue") && cw && (
        <>
          <KV k="address" v={shortAddr(cw.wallet_address)} title={cw.wallet_address} />
          <KV k="kind" v={cw.wallet_kind} />
          <KV k="provider" v={cw.provider ?? "—"} />
          <KV k="chain" v={cw.chain_id} />
          <KV k="bound" v={cw.created_at.slice(0, 19).replace("T", " ")} />
          <KV
            k="last attested"
            v={cw.last_attested_at.slice(0, 19).replace("T", " ")}
          />
          <KV
            k="re-attest due"
            v={cw.reattestation_due_at.slice(0, 19).replace("T", " ")}
            tone={state === "overdue" ? "neg" : "dim"}
          />
          {state === "overdue" && (
            <>
              <p className="ck-mono text-[11px]" style={{ color: "var(--color-accent)" }}>
                × re-attestation overdue. sign a fresh attestation message to
                keep runtime-key minting available.
              </p>
              <button
                className="ck-btn self-start"
                onClick={reattest}
                disabled={busy !== "idle" || !ready}
              >
                {busy === "idle" ? "[ re-attest now ]" : busyLabel(busy)}
              </button>
            </>
          )}
        </>
      )}

      {error && (
        <p className="ck-mono text-[11px]" style={{ color: "var(--color-accent)" }}>
          × {error}
        </p>
      )}
    </section>
  );
}

function busyLabel(b: BusyState): string {
  if (b === "challenging") return "fetching challenge…";
  if (b === "signing") return "waiting for signature…";
  if (b === "submitting") return "submitting…";
  return "…";
}

function shortAddr(addr: string): string {
  if (addr.length < 14) return addr;
  return `${addr.slice(0, 8)}…${addr.slice(-6)}`;
}

function StateBadge({ state }: { state: "unbound" | "bound" | "overdue" }) {
  const map: Record<typeof state, { label: string; tone: string }> = {
    unbound: { label: "not bound", tone: "ck-dim" },
    bound: { label: "bound", tone: "ck-pos" },
    overdue: { label: "overdue", tone: "ck-neg" },
  };
  const { label, tone } = map[state];
  return <span className={`ck-mono text-[10px] uppercase ${tone}`}>{label}</span>;
}

function KV({ k, v, tone, title }: { k: string; v: string; tone?: "dim" | "neg"; title?: string }) {
  const toneClass = tone === "neg" ? "ck-neg" : tone === "dim" ? "ck-dim" : "ck-pos";
  return (
    <div className="grid grid-cols-[120px_1fr] gap-2 ck-mono text-[11px]">
      <span className="ck-label">{k}</span>
      <span className={`${toneClass} truncate`} title={title}>{v}</span>
    </div>
  );
}
