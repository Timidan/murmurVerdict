// ─── RuntimeKeysPanel — list + mint + revoke runtime keys ─────────────────
//
// Lives at #/account/agent/:slug/keys (alongside the legacy API-key table).
// Pulls metadata via GET /v1/account/agents/:slug/runtime-keys (prefix,
// policy_hash, controller_wallet, created/expires/revoked timestamps only —
// never the secret). The user can:
//
//   · See active + revoked keys (revoked greyed out).
//   · Mint a new key: challenge → Privy personal_sign → POST → modal reveal.
//   · Revoke a key: inline confirm flow.
//
// Minting requires a bound Controller Wallet on this agent. If unbound, the
// panel renders a deep-link to the wallet tab instead of the mint CTA.

import { useEffect, useMemo, useRef, useState } from "react";
import { getAccessToken, useSignMessage, useWallets } from "@privy-io/react-auth";
import { verdictApi, type AccountAgent, type RuntimeKeyMintResponse } from "../../api.js";
import { Ik } from "../../icons.js";
import { InlineError } from "../compact/InlineError.js";
import { TimeAgo } from "../compact/TimeAgo.js";
import { RuntimeKeyMintModal } from "./RuntimeKeyMintModal.js";
import { generateRuntimeKeySigningKeypair } from "../../lib/runtime-key-signing.js";
import { connectionAt, unknownConnection } from "../../lib/runtime-key-connection.js";
import { useRuntimeKeyConnection } from "../../hooks/useRuntimeKeyConnection.js";
import { RuntimeKeyConnectionStatus } from "./RuntimeKeyConnectionStatus.js";

const CONFIRM_TIMEOUT_MS = 5000;

export interface RuntimeKeysPanelProps {
  slug: string;
  agent: AccountAgent | null;
}

type BusyState = "idle" | "challenging" | "signing" | "submitting" | "revoking" | "deleting";

export function RuntimeKeysPanel({ slug, agent }: RuntimeKeysPanelProps) {
  const { signMessage } = useSignMessage();
  const { wallets } = useWallets();

  const [busy, setBusy] = useState<BusyState>("idle");
  const [actionError, setActionError] = useState<string | null>(null);
  const [minted, setMinted] = useState<RuntimeKeyMintResponse | null>(null);
  const [mintedSigning, setMintedSigning] = useState<string | null>(null);

  const [confirmId, setConfirmId] = useState<string | null>(null);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { snapshot, receivedAtMs, error: refreshError, loading, refresh, clockTick } = useRuntimeKeyConnection(slug);
  const keys = snapshot?.keys ?? [];
  const displayConnections = useMemo(() => new Map(keys.map((key) => [
    key.runtime_key_id,
    refreshError ? unknownConnection(refreshError) : connectionAt(key.connection, snapshot!.served_at, receivedAtMs),
  ])), [clockTick, keys, receivedAtMs, refreshError, snapshot]);

  // A key stops working when it is revoked OR when it expires, so both leave
  // the active count. `clockTick` ticks this every second while visible.
  const expired = (iso: string | null) => {
    if (!iso) return false;
    const at = Date.parse(iso);
    return Number.isFinite(at) && at <= Date.now();
  };
  const activeCount = keys.filter((k) => !k.revoked_at && !expired(k.expires_at)).length;
  const revokedCount = keys.filter((k) => k.revoked_at).length;

  const cw = agent?.controller_wallet ?? null;
  const canMint = Boolean(cw) && !cw?.reattestation_overdue;
  const controllerWalletConnected = cw
    ? wallets.some((wallet) => sameAddress(wallet.address, cw.wallet_address))
    : false;

  useEffect(() => {
    return () => {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    };
  }, []);

  async function mint() {
    setActionError(null);
    // TS-narrowing guard only — unreachable via UI. The mint button renders
    // whenever a controller wallet is bound but stays disabled while
    // `!canMint` (re-attestation overdue), with the overdue warning + link
    // above explaining why; unbound agents get the wallet deep-link instead.
    if (!canMint || !cw) return;
    if (!controllerWalletConnected) {
      setActionError(
        "Connect the bound controller wallet first. It has to sign the runtime-key authorization.",
      );
      return;
    }
    try {
      const token = await getAccessToken();
      if (!token) {
        setActionError("Your session expired. Sign in again.");
        return;
      }
      // PoP: the keypair must exist BEFORE the challenge so its public half
      // is inside the policy the controller wallet signs.
      const signing = await generateRuntimeKeySigningKeypair();
      const policy = { signing_pubkey: signing.publicKeyHex };
      setBusy("challenging");
      const challenge = await verdictApi.postRuntimeKeyChallenge(token, slug, {
        policy,
      });
      setBusy("signing");
      // Pin signer to the bound controller wallet — daemon validates
      // the signature recovers to controller_wallet_address.
      const { signature } = await signMessage(
        { message: challenge.message },
        { address: cw.wallet_address },
      );
      setBusy("submitting");
      const result = await verdictApi.postRuntimeKey(token, slug, {
        policy,
        authorization_nonce: challenge.authorization_nonce,
        authorization_issued_at: challenge.authorization_issued_at,
        signature,
      });
      setMintedSigning(signing.privateKeyPkcs8Base64);
      setMinted(result);
    } catch (e) {
      // Frame the raw daemon detail in plain words — operators are devs,
      // the detail is useful, but the failure should read as a sentence.
      setActionError(`unable to mint the key. ${(e as Error)?.message ?? "unknown error"}`);
    } finally {
      setBusy("idle");
    }
  }

  function requestRevoke(id: string) {
    setConfirmId(id);
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    confirmTimerRef.current = setTimeout(() => setConfirmId(null), CONFIRM_TIMEOUT_MS);
  }

  function cancelRevoke() {
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    setConfirmId(null);
  }

  async function confirmRevoke(id: string, permanently = false) {
    if (busy !== "idle") return;
    setBusy(permanently ? "deleting" : "revoking");
    setActionError(null);
    try {
      const token = await getAccessToken();
      if (!token) {
        setActionError("Your session expired. Sign in again.");
        return;
      }
      if (permanently) await verdictApi.permanentlyDeleteRuntimeKey(token, id);
      else await verdictApi.deleteRuntimeKey(token, id);
      setConfirmId(null);
      await refresh();
    } catch (e) {
      setActionError(`We could not ${permanently ? "delete" : "revoke"} the key — ${(e as Error)?.message ?? "unknown error"}`);
    } finally {
      setBusy("idle");
    }
  }

  return (
    <section className="ck-frame w-full px-4 py-4 flex flex-col gap-3">
      <header className="flex items-center justify-between">
        <h3 className="ck-title ck-title-ik">
          <Ik name="runtime-key" /> Runtime keys
        </h3>
        <span className="text-[12px] ck-dim">
          {/* Before the keys are known the count is unknown, not zero. */}
          {snapshot ? `${activeCount} active · ${revokedCount} revoked` : "…"}
        </span>
      </header>

      {!cw && (
        <p className="text-[12px] ck-dim">
          Bind a controller wallet first. That wallet signs every runtime key
          you mint.{" "}
          <a
            href={`#/account/agent/${encodeURIComponent(slug)}/wallet`}
            className="ck-pos no-underline underline-offset-2 hover:underline"
          >
            bind a wallet →
          </a>
        </p>
      )}

      {cw?.reattestation_overdue && (
        <p
          className="text-[12px]"
          style={{ color: "var(--color-accent-ink)" }}
        >
          × Your controller wallet needs a fresh signature. Until you sign
          one, murmur cannot mint a key for this agent.{" "}
          <a
            href={`#/account/agent/${encodeURIComponent(slug)}/wallet`}
            className="underline underline-offset-2"
            style={{ color: "var(--color-accent-ink)" }}
          >
            sign now →
          </a>
        </p>
      )}

      {loading && <p className="ck-mono ck-dim">Loading your keys…</p>}

      {!loading && keys.length === 0 && cw && (
        <p className="ck-dim text-[12px]">
          No runtime keys yet. Mint one so your agent can send calls through
          the gateway.
        </p>
      )}

      {!loading && keys.length > 0 && (
        <ul className="m-0 p-0 list-none flex flex-col gap-1">
          <li className="hidden md:grid md:grid-cols-[140px_1fr_120px_130px_142px] gap-2 ck-colhead">
            <span>Key</span>
            <span>Label</span>
            <span>Created</span>
            <span>Connection</span>
            <span className="text-right"></span>
          </li>
          {keys.map((k) => {
            const revoked = Boolean(k.revoked_at);
            // Expired keys read as dim too, so the row agrees with the count.
            const tone = revoked || expired(k.expires_at) ? "ck-dim" : "ck-pos";
            return (
              <li
                key={k.runtime_key_id}
                className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-2 gap-y-1 text-[12px] items-center px-1 py-2 border-b border-[var(--color-border)] md:grid-cols-[140px_1fr_120px_130px_142px] md:gap-2 md:py-1"
              >
                <span className={`${tone} truncate`} title={k.runtime_key_id}>
                  {k.runtime_key_prefix}
                </span>
                <span
                  className="ck-dim truncate text-right md:text-left"
                  title={k.policy_hash}
                >
                  {k.label ?? "—"}
                </span>
                <TimeAgo iso={k.created_at} className="ck-dim text-[12px]" />
                <span className="col-span-2 md:col-span-1">
                  <RuntimeKeyConnectionStatus
                    compact
                    connection={displayConnections.get(k.runtime_key_id) ?? unknownConnection()}
                  />
                </span>
                <span className="col-span-2 self-start md:col-span-1 md:self-auto md:text-right">
                  {confirmId === k.runtime_key_id ? (
                    <span className="confirm-enter inline-flex items-center gap-2">
                      <button
                        className="ck-btn ck-btn-bracket"
                        style={{ color: "var(--color-accent-ink)" }}
                        onClick={() => void confirmRevoke(k.runtime_key_id, revoked)}
                        disabled={busy !== "idle"}
                      >
                        {busy !== "idle" ? "…" : revoked ? "confirm delete" : "confirm"}
                      </button>
                      <button
                        className="ck-btn ck-btn-bracket"
                        onClick={cancelRevoke}
                        disabled={busy !== "idle"}
                        aria-label={revoked ? "cancel delete" : "cancel revoke"}
                      >
                        ×
                      </button>
                    </span>
                  ) : (
                    <button
                      className="ck-btn ck-btn-bracket"
                      onClick={() => requestRevoke(k.runtime_key_id)}
                      disabled={busy !== "idle"}
                    >
                      {revoked ? "delete" : "revoke"}
                    </button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {confirmId && (
        <p
          className="text-[12px]"
          style={{ color: "var(--color-accent-ink)" }}
        >
          {keys.find((k) => k.runtime_key_id === confirmId)?.revoked_at
            ? "Permanently delete this revoked key? This cannot be undone. Call and transaction history remain."
            : "Revoke this key? Its next request is rejected. Mint a new key to start it again."}
        </p>
      )}

      {cw && (
        <button
          className="ck-btn ck-btn-bracket ck-pos self-start disabled:opacity-40 disabled:cursor-not-allowed"
          onClick={mint}
          disabled={busy !== "idle" || !canMint}
          title={
            cw.reattestation_overdue
              ? "Your controller wallet needs a fresh signature. Sign one on the wallet tab to mint a key."
              : undefined
          }
        >
          {busy === "idle" ? "+ mint a runtime key" : busyLabel(busy)}
        </button>
      )}

      {actionError && <InlineError error={actionError} className="text-[12px]" />}
      {refreshError && <InlineError error={`connection status unavailable — ${refreshError}`} className="text-[12px]" />}

      {minted && (
        <RuntimeKeyMintModal
          result={minted}
          slug={slug}
          signingPrivateKey={mintedSigning}
          onDone={() => {
            setMinted(null);
            setMintedSigning(null);
            void refresh();
          }}
        />
      )}
    </section>
  );
}

function busyLabel(b: BusyState): string {
  if (b === "challenging") return "Preparing…";
  if (b === "signing") return "Approve in your wallet…";
  if (b === "submitting") return "Minting…";
  if (b === "revoking") return "Revoking…";
  if (b === "deleting") return "Deleting…";
  return "…";
}

function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  return Boolean(a && b && a.toLowerCase() === b.toLowerCase());
}
