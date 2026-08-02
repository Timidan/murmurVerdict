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

import { useCallback, useEffect, useRef, useState } from "react";
import { getAccessToken, useSignMessage, useWallets } from "@privy-io/react-auth";
import {
  verdictApi,
  type AccountAgent,
  type RuntimeKeyRow,
  type RuntimeKeyMintResponse,
} from "../../api.js";
import { RuntimeKeyMintModal } from "./RuntimeKeyMintModal.js";
import { generateRuntimeKeySigningKeypair } from "../../lib/runtime-key-signing.js";

const CONFIRM_TIMEOUT_MS = 5000;

export interface RuntimeKeysPanelProps {
  slug: string;
  agent: AccountAgent | null;
}

type BusyState = "idle" | "challenging" | "signing" | "submitting" | "revoking";

export function RuntimeKeysPanel({ slug, agent }: RuntimeKeysPanelProps) {
  const { signMessage } = useSignMessage();
  const { wallets } = useWallets();

  const [keys, setKeys] = useState<RuntimeKeyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<BusyState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [minted, setMinted] = useState<RuntimeKeyMintResponse | null>(null);
  const [mintedSigning, setMintedSigning] = useState<string | null>(null);
  const [popEnabled, setPopEnabled] = useState(true);

  const [confirmId, setConfirmId] = useState<string | null>(null);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cw = agent?.controller_wallet ?? null;
  const canMint = Boolean(cw) && !cw?.reattestation_overdue;
  const controllerWalletConnected = cw
    ? wallets.some((wallet) => sameAddress(wallet.address, cw.wallet_address))
    : false;

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = await getAccessToken();
      if (!token) {
        setError("× session expired — sign in again");
        return;
      }
      const { keys } = await verdictApi.getRuntimeKeys(token, slug);
      setKeys(keys);
    } catch (e) {
      setError((e as Error)?.message ?? "failed to load runtime keys");
    } finally {
      setLoading(false);
    }
  }, [slug]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    return () => {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    };
  }, []);

  async function mint() {
    setError(null);
    // TS-narrowing guard only — unreachable via UI. The mint button renders
    // whenever a controller wallet is bound but stays disabled while
    // `!canMint` (re-attestation overdue), with the overdue warning + link
    // above explaining why; unbound agents get the wallet deep-link instead.
    if (!canMint || !cw) return;
    if (!controllerWalletConnected) {
      setError(
        "× connect the bound controller wallet in Privy before signing the runtime-key authorization",
      );
      return;
    }
    try {
      const token = await getAccessToken();
      if (!token) {
        setError("× session expired — sign in again");
        return;
      }
      // PoP: the keypair must exist BEFORE the challenge so its public half
      // is inside the policy the controller wallet signs.
      const signing = popEnabled ? await generateRuntimeKeySigningKeypair() : null;
      const policy = signing ? { signing_pubkey: signing.publicKeyHex } : {};
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
      setMintedSigning(signing?.privateKeyPkcs8Base64 ?? null);
      setMinted(result);
    } catch (e) {
      // Frame the raw daemon detail in plain words — operators are devs,
      // the detail is useful, but the failure should read as a sentence.
      setError(`mint failed — ${(e as Error)?.message ?? "unknown error"}`);
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

  async function confirmRevoke(id: string) {
    setError(null);
    try {
      const token = await getAccessToken();
      if (!token) {
        setError("× session expired — sign in again");
        return;
      }
      setBusy("revoking");
      await verdictApi.deleteRuntimeKey(token, id);
      setConfirmId(null);
      await refresh();
    } catch (e) {
      setError(`revoke failed — ${(e as Error)?.message ?? "unknown error"}`);
    } finally {
      setBusy("idle");
    }
  }

  return (
    <section className="ck-frame w-full max-w-[720px] px-4 py-4 flex flex-col gap-3">
      <header className="flex items-center justify-between">
        <h3 className="ck-title">runtime keys · {slug}</h3>
        <span className="ck-mono text-[10px] ck-dim">
          {keys.filter((k) => !k.revoked_at).length} active · {keys.filter((k) => k.revoked_at).length} revoked
        </span>
      </header>

      {!cw && (
        <p className="ck-mono text-[11px] ck-dim">
          bind a controller wallet first — runtime keys are authorized by the
          wallet's signature.{" "}
          <a
            href={`#/account/agent/${encodeURIComponent(slug)}/wallet`}
            className="ck-pos no-underline underline-offset-2 hover:underline"
          >
            go to wallet →
          </a>
        </p>
      )}

      {cw?.reattestation_overdue && (
        <p
          className="ck-mono text-[11px]"
          style={{ color: "var(--color-accent-ink)" }}
        >
          × controller wallet re-attestation overdue — the daemon will
          reject mint with 409 until you sign a fresh attestation.{" "}
          <a
            href={`#/account/agent/${encodeURIComponent(slug)}/wallet`}
            className="underline underline-offset-2"
            style={{ color: "var(--color-accent-ink)" }}
          >
            re-attest now →
          </a>
        </p>
      )}

      {loading && <p className="ck-mono ck-dim">loading…</p>}

      {!loading && keys.length === 0 && cw && (
        <p className="ck-mono ck-dim text-[11px]">
          no runtime keys minted yet. mint one to start submitting calls
          through the Gateway.
        </p>
      )}

      {!loading && keys.length > 0 && (
        <ul className="m-0 p-0 list-none flex flex-col gap-1">
          <li className="grid grid-cols-[140px_1fr_120px_60px] gap-2 ck-colhead">
            <span>prefix</span>
            <span>policy</span>
            <span>created</span>
            <span className="text-right"></span>
          </li>
          {keys.map((k) => {
            const revoked = Boolean(k.revoked_at);
            const tone = revoked ? "ck-dim" : "ck-pos";
            return (
              <li
                key={k.runtime_key_id}
                className="grid grid-cols-[140px_1fr_120px_60px] gap-2 ck-mono text-[11px] items-center px-1 py-1 border-b border-[var(--color-border)]"
              >
                <span className={`${tone} truncate`} title={k.runtime_key_id}>
                  {k.runtime_key_prefix}
                </span>
                <span
                  className="ck-dim truncate"
                  title={k.policy_hash}
                >
                  {k.label ?? "—"} · h:{k.policy_hash.slice(0, 8)}
                </span>
                <span className="ck-dim text-[10px]">
                  {k.created_at.slice(0, 10)}
                </span>
                <span className="text-right">
                  {revoked ? (
                    <span className="ck-dim text-[10px]">revoked</span>
                  ) : confirmId === k.runtime_key_id ? (
                    <span className="confirm-enter inline-flex items-center gap-2">
                      <button
                        className="ck-btn ck-btn-bracket"
                        style={{ color: "var(--color-accent-ink)" }}
                        onClick={() => void confirmRevoke(k.runtime_key_id)}
                        disabled={busy === "revoking"}
                      >
                        {busy === "revoking" ? "…" : "confirm"}
                      </button>
                      <button
                        className="ck-btn ck-btn-bracket"
                        onClick={cancelRevoke}
                        disabled={busy === "revoking"}
                        aria-label="cancel revoke"
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
                      revoke
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
          className="ck-mono text-[10px]"
          style={{ color: "var(--color-accent-ink)" }}
        >
          revoke{" "}
          {keys.find((k) => k.runtime_key_id === confirmId)?.runtime_key_prefix ??
            "this key"}
          ? the agent stops authenticating immediately — its next call 401s.
          mint a new key to resume.
        </p>
      )}

      {cw && (
        <label className="ck-mono text-[10px] flex items-center gap-1.5 self-start cursor-pointer select-none">
          <input
            type="checkbox"
            checked={popEnabled}
            onChange={(e) => setPopEnabled(e.target.checked)}
            disabled={busy !== "idle"}
          />
          require request signatures (PoP) — a leaked bearer key alone can't
          authenticate
        </label>
      )}
      {cw && (
        <button
          className="ck-btn ck-btn-bracket ck-pos self-start disabled:opacity-40 disabled:cursor-not-allowed"
          onClick={mint}
          disabled={busy !== "idle" || !canMint}
          title={
            cw.reattestation_overdue
              ? "re-attestation overdue — re-attest in the wallet tab to mint"
              : undefined
          }
        >
          {busy === "idle" ? "+ mint runtime key" : busyLabel(busy)}
        </button>
      )}

      {error && (
        <p
          className="ck-mono text-[11px]"
          style={{ color: "var(--color-accent-ink)" }}
        >
          × {error}
        </p>
      )}

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
  if (b === "challenging") return "fetching challenge…";
  if (b === "signing") return "waiting for signature…";
  if (b === "submitting") return "minting…";
  if (b === "revoking") return "revoking…";
  return "…";
}

function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  return Boolean(a && b && a.toLowerCase() === b.toLowerCase());
}
