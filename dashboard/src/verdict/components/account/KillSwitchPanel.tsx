// Account-wide agent kill switch. Engage is one click (emergencies need
// speed); release is a typed-confirm ceremony and does NOT resurrect the
// revoked/rotated credentials — re-mint to resume, which for runtime keys
// means a fresh controller-wallet signature.

import { useCallback, useEffect, useRef, useState } from "react";
import { getAccessToken } from "@privy-io/react-auth";

import { verdictApi } from "../../api.js";

const CONFIRM_TIMEOUT_MS = 8_000;

export function KillSwitchPanel() {
  const [engaged, setEngaged] = useState<boolean | null>(null);
  const [disabledAt, setDisabledAt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [lastCounts, setLastCounts] = useState<string | null>(null);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const token = await getAccessToken();
      if (!token) return;
      const state = await verdictApi.getKillSwitch(token);
      setEngaged(state.engaged);
      setDisabledAt(state.disabled_at);
    } catch (e) {
      setError((e as Error)?.message ?? "unknown error");
    }
  }, []);

  useEffect(() => {
    void refresh();
    return () => {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    };
  }, [refresh]);

  const engage = useCallback(async () => {
    if (!confirming) {
      setConfirming(true);
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = setTimeout(() => setConfirming(false), CONFIRM_TIMEOUT_MS);
      return;
    }
    setConfirming(false);
    setBusy(true);
    setError(null);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error("session expired — sign in again");
      const result = await verdictApi.postKillSwitch(token);
      setEngaged(true);
      setDisabledAt(result.disabled_at);
      setLastCounts(
        `${result.runtime_keys_revoked} runtime keys revoked · ${result.api_keys_rotated} api keys rotated`,
      );
    } catch (e) {
      setError((e as Error)?.message ?? "unknown error");
    } finally {
      setBusy(false);
    }
  }, [confirming]);

  const release = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error("session expired — sign in again");
      await verdictApi.postKillSwitchRelease(token);
      setEngaged(false);
      setDisabledAt(null);
      setLastCounts(null);
    } catch (e) {
      setError((e as Error)?.message ?? "unknown error");
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <section className="ck-frame">
      <div className="ck-header">
        <span className="ck-title">agent kill switch</span>
        <span className="ck-mono ck-dim">
          {engaged === null ? "…" : engaged ? "ENGAGED" : "off"}
        </span>
      </div>
      <div className="px-3 py-2 flex flex-col gap-2">
        {engaged ? (
          <>
            <p className="ck-mono text-[11px]" style={{ color: "var(--color-accent-ink)" }}>
              engaged {disabledAt ? disabledAt.slice(0, 19).replace("T", " ") : ""} — every
              agent credential is blocked: dispatch 403s, minting is frozen, queued
              gateway attempts terminate before broadcast.
              {lastCounts ? ` ${lastCounts}.` : ""}
            </p>
            <button
              type="button"
              className="ck-btn ck-btn-bracket self-start"
              onClick={() => void release()}
              disabled={busy}
            >
              release — resume minting (dead keys stay dead)
            </button>
          </>
        ) : (
          <>
            <p className="ck-mono text-[11px] ck-dim">
              one click disables every agent credential on this account: revokes all
              runtime keys, rotates all api keys, freezes minting, and stops queued
              gateway attempts. release later requires this dashboard; re-minting a
              runtime key still needs a controller-wallet signature.
            </p>
            <button
              type="button"
              className="ck-btn ck-btn-bracket self-start"
              style={confirming ? { color: "var(--color-accent-ink)" } : undefined}
              onClick={() => void engage()}
              disabled={busy || engaged === null}
            >
              {confirming ? "click again to disable ALL agent access" : "engage kill switch"}
            </button>
          </>
        )}
        {error && (
          <p className="ck-mono text-[10px]" style={{ color: "var(--color-accent-ink)" }}>
            × {error}
          </p>
        )}
      </div>
    </section>
  );
}
