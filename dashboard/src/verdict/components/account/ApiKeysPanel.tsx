// ─── ApiKeysPanel — list + rotate + mint api keys ──────────────────────────
//
// Lives at #/account/agent/:slug/keys. Pulls metadata via
// GET /v1/account/agents/:slug/api-keys (api_key_id + created_at + label
// + rotated_at only — never the secret). The user can:
//
//   · See active keys (with the option to also see rotated history).
//   · Rotate a key: inline confirm flow — [ROTATE] swaps to [CONFIRM]/[×]
//     for 5 seconds, then auto-reverts. Lighter than a modal, but still
//     prevents an accidental misclick from silently invalidating a key
//     a downstream service depends on. The brief said pick the lighter
//     approach — we picked inline confirm.
//   · Mint a new key: re-uses ApiKeyMintModal from 7b for the one-time
//     plaintext reveal.

import { useCallback, useEffect, useRef, useState } from "react";
import { getAccessToken } from "@privy-io/react-auth";
import { ApiError, verdictApi, type ApiKeyRow, type MintApiKeyResponse } from "../../api.js";
import { Ik } from "../../icons.js";
import { shortId } from "../../lib/display-format.js";
import { InlineError } from "../compact/InlineError.js";
import { SkeletonBar } from "../compact/PanelSkeleton.js";
import { TimeAgo } from "../compact/TimeAgo.js";
import { ApiKeyMintModal } from "./ApiKeyMintModal.js";

const CONFIRM_TIMEOUT_MS = 5000;

export interface ApiKeysPanelProps {
  slug: string;
}

interface MintedState {
  result: MintApiKeyResponse;
  slug: string;
}

export function ApiKeysPanel({ slug }: ApiKeysPanelProps) {
  const [keys, setKeys] = useState<ApiKeyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Inline rotate-confirm state. Holds the api_key_id currently in
  // confirm-pending mode; auto-reverts after CONFIRM_TIMEOUT_MS so a
  // forgotten click doesn't sit live forever.
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [rotatingId, setRotatingId] = useState<string | null>(null);

  // Mint state — re-uses the 7b modal verbatim for the reveal.
  const [minting, setMinting] = useState(false);
  const [mintError, setMintError] = useState<string | null>(null);
  const [minted, setMinted] = useState<MintedState | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const token = await getAccessToken();
      if (!token) {
        setError("Your session expired. Sign in again.");
        return;
      }
      const { keys: rows } = await verdictApi.getApiKeys(token, slug);
      setKeys(rows);
    } catch (e) {
      setError((e as Error).message ?? "unable to load your api keys. retry, or reload the page.");
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

  const armConfirm = (id: string) => {
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    setConfirmId(id);
    confirmTimerRef.current = setTimeout(() => {
      setConfirmId((curr) => (curr === id ? null : curr));
    }, CONFIRM_TIMEOUT_MS);
  };

  const cancelConfirm = () => {
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    setConfirmId(null);
  };

  const doRotate = async (id: string, permanently = false): Promise<void> => {
    if (rotatingId) return;
    cancelConfirm();
    setRotatingId(id);
    setError(null);
    try {
      const token = await getAccessToken();
      if (!token) {
        setError("Your session expired. Sign in again.");
        return;
      }
      if (permanently) await verdictApi.permanentlyDeleteApiKey(token, id);
      else await verdictApi.deleteApiKey(token, id);
      await refresh();
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        setError("Your session expired. Sign in again.");
      } else if (e instanceof ApiError && e.status === 429) {
        setError("Too many requests. Wait a minute and try again.");
      } else {
        setError(`We could not ${permanently ? "delete" : "rotate"} the key: ${(e as Error).message ?? "unknown"}`);
      }
    } finally {
      setRotatingId(null);
    }
  };

  const doMint = async (): Promise<void> => {
    setMinting(true);
    setMintError(null);
    try {
      const token = await getAccessToken();
      if (!token) {
        setMintError("Your session expired. Sign in again.");
        return;
      }
      const result = await verdictApi.postMintApiKey(token, slug);
      setMinted({ result, slug });
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.status === 401 || e.status === 403)
          setMintError("Your session expired. Sign in again.");
        else if (e.status === 429)
          setMintError("Too many requests. Wait a minute and try again.");
        else setMintError(`We could not mint the key: ${e.message}`);
      } else {
        setMintError(`We could not mint the key: ${(e as Error).message ?? "unknown"}`);
      }
    } finally {
      setMinting(false);
    }
  };

  const onModalDone = () => {
    setMinted(null);
    void refresh();
  };

  const active = keys.filter((k) => !k.rotated_at);
  const rotated = keys.filter((k) => k.rotated_at);

  return (
    <section className="ck-frame w-full flex flex-col">
      <div className="ck-header">
        <span className="ck-title ck-title-ik">
          <Ik name="api" /> API keys · {slug}
        </span>
        <span className="ck-mono ck-dim">{active.length} active</span>
      </div>

      {error && (
        <InlineError
          error={error}
          className="px-3 py-2 ck-mono border-b border-[var(--color-border)]"
        />
      )}

      {loading && active.length === 0 && rotated.length === 0 ? (
        <SkeletonRows />
      ) : active.length === 0 ? (
        <EmptyState slug={slug} />
      ) : (
        <ul className="divide-y divide-[var(--color-border)]">
          {active.map((k) => (
            <li
              key={k.api_key_id}
              className="grid grid-cols-1 md:grid-cols-[1fr_auto_auto_auto] items-center px-3 py-2 gap-3"
            >
              <code className="ck-mono ck-pos truncate" title={k.api_key_id}>
                {shortId(k.api_key_id, 12, 4)}
              </code>
              <TimeAgo iso={k.created_at} className="ck-dim text-[12px]" />
              <span className="ck-dim text-[12px]">
                {k.label ?? "—"}
              </span>
              <div className="flex items-center gap-2 justify-self-end">
                {rotatingId === k.api_key_id ? (
                  <span className="ck-dim text-[12px]">Rotating…</span>
                ) : confirmId === k.api_key_id ? (
                  <span className="confirm-enter inline-flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void doRotate(k.api_key_id)}
                      className="ck-btn ck-btn-bracket ck-btn-accent"
                      aria-label={`confirm rotate ${k.api_key_id}`}
                    >
                      confirm
                    </button>
                    <button
                      type="button"
                      onClick={cancelConfirm}
                      className="ck-btn ck-btn-bracket"
                      aria-label="cancel rotate"
                    >
                      ×
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => armConfirm(k.api_key_id)}
                    className="ck-btn ck-btn-bracket"
                    aria-label={`rotate ${k.api_key_id}`}
                  >
                    rotate
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {confirmId && (
        <p
          className="px-3 py-2 text-[12px] border-t border-[var(--color-border)]"
          style={{ color: "var(--color-accent-ink)" }}
        >
          {keys.find((k) => k.api_key_id === confirmId)?.rotated_at
            ? `Permanently delete key ${confirmId.slice(0, 12)}? This cannot be undone. Call and transaction history remain.`
            : `Rotate key ${confirmId.slice(0, 12)}? The old key stops working within a second.`}
        </p>
      )}

      {rotated.length > 0 && (
        <details className="border-t border-[var(--color-border)]">
          <summary className="px-3 py-2 ck-label ck-dim cursor-pointer select-none">
            Revoked keys · {rotated.length}
          </summary>
          <ul className="details-fade divide-y divide-[var(--color-border)]">
            {rotated.map((k) => (
              <li
                key={k.api_key_id}
                className="grid grid-cols-1 md:grid-cols-[1fr_auto_auto_auto] items-center px-3 py-2 gap-3"
              >
                <code className="ck-mono ck-dim truncate line-through" title={k.api_key_id}>
                  {shortId(k.api_key_id, 12, 4)}
                </code>
                <span className="ck-dim text-[12px]">
                  minted <TimeAgo iso={k.created_at} />
                </span>
                <span className="ck-dim text-[12px]">
                  revoked <TimeAgo iso={k.rotated_at} />
                </span>
                <span className="flex items-center gap-2 justify-self-end">
                  {confirmId === k.api_key_id ? <>
                    <button type="button" className="ck-btn ck-btn-bracket ck-btn-accent"
                      disabled={Boolean(rotatingId)} onClick={() => void doRotate(k.api_key_id, true)}
                      aria-label={`confirm permanent deletion ${k.api_key_id}`}>confirm delete</button>
                    <button type="button" className="ck-btn ck-btn-bracket" onClick={cancelConfirm}
                      aria-label="cancel delete">×</button>
                  </> : <button type="button" className="ck-btn ck-btn-bracket"
                    disabled={Boolean(rotatingId)} onClick={() => armConfirm(k.api_key_id)}
                    aria-label={`delete revoked API key ${k.api_key_id}`}>{rotatingId === k.api_key_id ? "deleting…" : "delete"}</button>}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}

      <div className="px-3 py-3 border-t border-[var(--color-border)] flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={minting}
          onClick={() => void doMint()}
          className="ck-btn ck-btn-bracket ck-pos disabled:opacity-40 disabled:cursor-not-allowed"
          aria-label="mint new key"
        >
          + mint a new key
        </button>
        {minting && <span className="ck-dim text-[12px]">Minting…</span>}
        {mintError && <InlineError error={mintError} className="text-[12px]" />}
      </div>

      {minted && (
        <ApiKeyMintModal
          result={minted.result}
          slug={minted.slug}
          onDone={onModalDone}
        />
      )}
    </section>
  );
}

/** An API key is an account credential. The gateway takes runtime keys only. */
function EmptyState({ slug }: { slug: string }) {
  return (
    <div className="px-4 py-6 flex flex-col items-start gap-2">
      <p className="ck-mono ck-dim">No active keys.</p>
      <p className="ck-dim text-[12px] max-w-[40ch]">
        An API key reads and writes your account from a script. It cannot send
        calls. Murmur shows the key once.
      </p>
      <p className="ck-dim text-[12px] max-w-[40ch]">
        Your agent sends calls with a{" "}
        <a
          href={`#/account/agent/${encodeURIComponent(slug)}/runtime`}
          className="ck-pos no-underline underline-offset-2 hover:underline"
        >
          runtime key →
        </a>
      </p>
    </div>
  );
}

function SkeletonRows() {
  return (
    <ul>
      {[0, 1].map((i) => (
        <li
          key={i}
          className="grid grid-cols-[1fr_auto_auto_auto] items-center px-3 py-2 gap-3 border-b border-[var(--color-border)]"
        >
          <SkeletonBar className="h-[10px] w-[60%]" />
          <SkeletonBar className="h-[8px] w-[40px]" />
          <SkeletonBar className="h-[8px] w-[40px]" />
          <SkeletonBar className="h-[10px] w-[48px]" />
        </li>
      ))}
    </ul>
  );
}
