// ─── ApiKeysPanel — list + rotate + mint api keys (Phase 7c) ───────────────
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
import { ApiKeyMintModal } from "./ApiKeyMintModal.js";

const CONFIRM_TIMEOUT_MS = 5000;

export interface ApiKeysPanelProps {
  slug: string;
}

interface MintedState {
  result: MintApiKeyResponse;
  slug: string;
}

/** Human-friendly relative time. `2025-05-08T…` → "3d ago" / "2h ago". */
function relativeTime(iso: string, nowMs: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const diff = Math.max(0, nowMs - t);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
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

  // Now-ms tick @ 30s — cheap enough to drive relative timestamps
  // without churning every second.
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const token = await getAccessToken();
      if (!token) {
        setError("× session expired — sign in again");
        return;
      }
      const { keys: rows } = await verdictApi.getApiKeys(token, slug);
      setKeys(rows);
    } catch (e) {
      setError((e as Error).message ?? "× fetch failed");
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

  const doRotate = async (id: string): Promise<void> => {
    cancelConfirm();
    setRotatingId(id);
    setError(null);
    try {
      const token = await getAccessToken();
      if (!token) {
        setError("× session expired — sign in again");
        return;
      }
      await verdictApi.deleteApiKey(token, id);
      await refresh();
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        setError("× session expired — sign in again");
      } else if (e instanceof ApiError && e.status === 429) {
        setError("× rate limited — wait a minute and retry");
      } else {
        setError(`× rotate failed: ${(e as Error).message ?? "unknown"}`);
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
        setMintError("× session expired — sign in again");
        return;
      }
      const result = await verdictApi.postMintApiKey(token, slug);
      setMinted({ result, slug });
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.status === 401 || e.status === 403)
          setMintError("× session expired — sign in again");
        else if (e.status === 429)
          setMintError("× rate limited — wait a minute and retry");
        else setMintError(`× mint failed: ${e.message}`);
      } else {
        setMintError(`× mint failed: ${(e as Error).message ?? "unknown"}`);
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
    <section className="ck-frame w-full max-w-[720px] flex flex-col">
      <div className="ck-header">
        <span className="ck-label ck-pos">api keys · {slug}</span>
        <span className="ck-mono ck-dim">{active.length} active</span>
      </div>

      {error && (
        <div
          className="px-3 py-2 ck-mono border-b border-[var(--color-border)]"
          style={{ color: "var(--color-accent)" }}
          role="alert"
        >
          {error}
        </div>
      )}

      {loading && active.length === 0 && rotated.length === 0 ? (
        <SkeletonRows />
      ) : active.length === 0 ? (
        <EmptyState />
      ) : (
        <ul className="divide-y divide-[var(--color-border)]">
          {active.map((k) => (
            <li
              key={k.api_key_id}
              className="grid grid-cols-1 md:grid-cols-[1fr_auto_auto_auto] items-center px-3 py-2 gap-3"
            >
              <code className="ck-mono ck-pos truncate" title={k.api_key_id}>
                {k.api_key_id.slice(0, 12)}…
              </code>
              <span className="ck-mono ck-dim text-[10px]">
                {relativeTime(k.created_at, nowMs)}
              </span>
              <span className="ck-mono ck-dim text-[10px]">
                {k.label ?? "—"}
              </span>
              <div className="flex items-center gap-2 justify-self-end">
                {rotatingId === k.api_key_id ? (
                  <span className="ck-mono ck-dim text-[10px]">rotating…</span>
                ) : confirmId === k.api_key_id ? (
                  <>
                    <button
                      type="button"
                      onClick={() => void doRotate(k.api_key_id)}
                      className="ck-btn ck-btn-accent"
                      aria-label={`confirm rotate ${k.api_key_id}`}
                    >
                      [ confirm ]
                    </button>
                    <button
                      type="button"
                      onClick={cancelConfirm}
                      className="ck-btn"
                      aria-label="cancel rotate"
                    >
                      [ × ]
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => armConfirm(k.api_key_id)}
                    className="ck-btn"
                    aria-label={`rotate ${k.api_key_id}`}
                  >
                    [ rotate ]
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {confirmId && (
        <p
          className="px-3 py-2 ck-mono text-[10px] border-t border-[var(--color-border)]"
          style={{ color: "var(--color-accent)" }}
        >
          rotate api_key {confirmId.slice(0, 12)}? old keys 401 within 1s.
        </p>
      )}

      {rotated.length > 0 && (
        <details className="border-t border-[var(--color-border)]">
          <summary className="px-3 py-2 ck-label ck-dim cursor-pointer select-none">
            rotated · {rotated.length}
          </summary>
          <ul className="divide-y divide-[var(--color-border)]">
            {rotated.map((k) => (
              <li
                key={k.api_key_id}
                className="grid grid-cols-1 md:grid-cols-[1fr_auto_auto] items-center px-3 py-2 gap-3"
              >
                <code className="ck-mono ck-dim truncate line-through" title={k.api_key_id}>
                  {k.api_key_id.slice(0, 12)}…
                </code>
                <span className="ck-mono ck-dim text-[10px]">
                  minted {relativeTime(k.created_at, nowMs)}
                </span>
                <span className="ck-mono ck-dim text-[10px]">
                  rotated {k.rotated_at ? relativeTime(k.rotated_at, nowMs) : "—"}
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
          className="ck-btn ck-pos disabled:opacity-40 disabled:cursor-not-allowed"
          aria-label="mint new key"
        >
          [ + mint new key ]
        </button>
        {minting && <span className="ck-mono ck-dim text-[10px]">working…</span>}
        {mintError && (
          <span
            className="ck-mono text-[10px]"
            style={{ color: "var(--color-accent)" }}
          >
            {mintError}
          </span>
        )}
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

function EmptyState() {
  return (
    <div className="px-4 py-6 flex flex-col items-start gap-2">
      <p className="ck-mono ck-dim">no active keys.</p>
      <p className="ck-mono ck-dim text-[10px] max-w-[40ch]">
        mint a key below to start submitting calls. the plaintext shows once.
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
          <div className="h-[10px] bg-[var(--color-border)] w-[60%]" />
          <div className="h-[8px] bg-[var(--color-border)] w-[40px]" />
          <div className="h-[8px] bg-[var(--color-border)] w-[40px]" />
          <div className="h-[10px] bg-[var(--color-border)] w-[48px]" />
        </li>
      ))}
    </ul>
  );
}
