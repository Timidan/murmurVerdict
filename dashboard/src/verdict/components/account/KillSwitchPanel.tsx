// Account-wide agent kill switch. Engage is one click; release needs the typed
// word and does not restore revoked or rotated credentials.

import { useCallback, useEffect, useState } from "react";
import { getAccessToken } from "@privy-io/react-auth";

import { verdictApi } from "../../api.js";
import { Ik } from "../../icons.js";
import { InlineError } from "../compact/InlineError.js";
import { TimeAgo } from "../compact/TimeAgo.js";

/** Typed to release. Case-sensitive, surrounding whitespace ignored; UI gate only. */
const RELEASE_PHRASE = "release";

/** Matches the shared input styling used by DestinationAddressForm. */
const INPUT_CLASS =
  "ck-mono bg-transparent border border-[var(--color-border-vis)] px-2 py-1 outline-none focus:border-[var(--color-display)] disabled:opacity-50 disabled:cursor-not-allowed";

export function KillSwitchPanel() {
  const [engaged, setEngaged] = useState<boolean | null>(null);
  const [disabledAt, setDisabledAt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [releaseInput, setReleaseInput] = useState("");
  const [lastCounts, setLastCounts] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  // Collapsed by default, but never hide an account that is actually frozen.
  useEffect(() => {
    if (engaged) setOpen(true);
  }, [engaged]);

  const refresh = useCallback(async () => {
    try {
      const token = await getAccessToken();
      // Without a token `engaged` stays null and engage stays disabled; say why.
      if (!token) {
        setError("Your session expired. Sign in again.");
        return;
      }
      const state = await verdictApi.getKillSwitch(token);
      setEngaged(state.engaged);
      setDisabledAt(state.disabled_at);
    } catch (e) {
      setError((e as Error)?.message ?? "unknown error");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // One click, no confirm: an emergency stop must not be slowed down.
  const engage = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error("Your session expired. Sign in again.");
      const result = await verdictApi.postKillSwitch(token);
      setEngaged(true);
      setDisabledAt(result.disabled_at);
      setLastCounts(
        `murmur revoked ${result.runtime_keys_revoked} runtime ${result.runtime_keys_revoked === 1 ? "key" : "keys"} and rotated ${result.api_keys_rotated} api ${result.api_keys_rotated === 1 ? "key" : "keys"}`,
      );
    } catch (e) {
      setError((e as Error)?.message ?? "unknown error");
    } finally {
      setBusy(false);
    }
  }, []);

  // Clears the typed word either way; a failed release must be re-typed.
  const release = useCallback(async () => {
    if (releaseInput.trim() !== RELEASE_PHRASE) return;
    setBusy(true);
    setError(null);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error("Your session expired. Sign in again.");
      await verdictApi.postKillSwitchRelease(token);
      setEngaged(false);
      setDisabledAt(null);
      setLastCounts(null);
    } catch (e) {
      setError((e as Error)?.message ?? "unknown error");
    } finally {
      setBusy(false);
      setReleaseInput("");
    }
  }, [releaseInput]);

  return (
    <details
      className="ck-frame mmr-danger"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary className="ck-header mmr-danger-summary">
        <span className="ck-title ck-title-ik">
          <Ik name="kill-switch" /> agent kill switch
        </span>
        <span className="flex items-center gap-2">
          <span className={"ck-mono " + (engaged ? "ck-neg" : "ck-dim")}>
            {engaged === null ? "…" : engaged ? "ENGAGED" : "off"}
          </span>
          <span className="mmr-disclosure-marker" aria-hidden="true" />
        </span>
      </summary>
      <div className="px-3 py-2 flex flex-col gap-2">
        {engaged ? (
          <>
            <p className="text-[12px]" style={{ color: "var(--color-accent-ink)" }}>
              Engaged {disabledAt ? <TimeAgo iso={disabledAt} /> : ""}. Every
              credential on this account is blocked. Agents cannot send calls,
              you cannot mint keys, and queued calls stop before they broadcast.
              {lastCounts ? ` ${lastCounts}.` : ""}
            </p>
            <form
              className="flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void release();
              }}
            >
              <label htmlFor="kill-switch-release" className="ck-label">
                type release to confirm
              </label>
              <input
                id="kill-switch-release"
                type="text"
                value={releaseInput}
                onChange={(e) => setReleaseInput(e.currentTarget.value)}
                placeholder="release"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                disabled={busy}
                className={`${INPUT_CLASS} max-w-[28ch]`}
              />
              <button
                type="submit"
                className="ck-btn ck-btn-bracket self-start"
                disabled={busy || releaseInput.trim() !== RELEASE_PHRASE}
              >
                release the kill switch. minting resumes; revoked keys stay dead.
              </button>
            </form>
          </>
        ) : (
          <>
            <p className="text-[12px] ck-dim">
              One click blocks every agent credential on this account. It revokes
              all runtime keys, rotates all api keys, stops minting, and cancels
              queued calls. You release it from this page. Minting a new runtime
              key still needs a controller-wallet signature.
            </p>
            <button
              type="button"
              className="ck-btn ck-btn-bracket ck-btn-accent self-start"
              onClick={() => void engage()}
              disabled={busy || engaged === null}
            >
              <Ik name="kill-switch" />
              engage the kill switch
            </button>
          </>
        )}
        {error && <InlineError error={error} className="text-[12px]" />}
      </div>
    </details>
  );
}
