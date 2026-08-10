// Account-wide agent kill switch. Engage is one click (emergencies need
// speed); release is a typed-confirm ceremony and does NOT resurrect the
// revoked/rotated credentials — re-mint to resume, which for runtime keys
// means a fresh controller-wallet signature.

import { useCallback, useEffect, useState } from "react";
import { getAccessToken } from "@privy-io/react-auth";

import { verdictApi } from "../../api.js";
import { Ik } from "../../icons.js";
import { InlineError } from "../compact/InlineError.js";
import { TimeAgo } from "../compact/TimeAgo.js";

/**
 * The word the operator must type to re-arm the account. Case-sensitive —
 * surrounding whitespace is forgiven (a pasted or auto-spaced word still
 * counts as typing it), but a different word never is. UI gate only: the
 * request payload does not carry this.
 */
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

  const refresh = useCallback(async () => {
    try {
      const token = await getAccessToken();
      // A silent return here left `engaged` at null forever: the status chip
      // stuck on "…" and the engage button permanently disabled, with nothing
      // saying why. Say it — same wording as DestinationAddressForm, and
      // nothing clears this state before the operator acts on it (refresh
      // runs once on mount; engage/release clear it only as they retry).
      if (!token) {
        setError("session expired — sign in again");
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

  // One click. An emergency stop that asks a second question is a stop that
  // arrives late; the damage this undoes is worse than a stray click.
  const engage = useCallback(async () => {
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
  }, []);

  // Re-arming the account is the deliberate direction: it only runs once the
  // operator has typed the word out. The gate re-arms on the way out either
  // way — a failed release has to be re-typed, not re-clicked.
  const release = useCallback(async () => {
    if (releaseInput.trim() !== RELEASE_PHRASE) return;
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
      setReleaseInput("");
    }
  }, [releaseInput]);

  return (
    <section className="ck-frame">
      <div className="ck-header">
        <span className="ck-title ck-title-ik">
          <Ik name="kill-switch" /> agent kill switch
        </span>
        <span className="ck-mono ck-dim">
          {engaged === null ? "…" : engaged ? "ENGAGED" : "off"}
        </span>
      </div>
      <div className="px-3 py-2 flex flex-col gap-2">
        {engaged ? (
          <>
            <p className="text-[12px]" style={{ color: "var(--color-accent-ink)" }}>
              engaged {disabledAt ? <TimeAgo iso={disabledAt} /> : ""} — every
              agent credential is blocked: dispatch 403s, minting is frozen, queued
              gateway attempts terminate before broadcast.
              {lastCounts ? ` ${lastCounts}.` : ""}
            </p>
            <form
              className="flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void release();
              }}
            >
              <input
                type="text"
                value={releaseInput}
                onChange={(e) => setReleaseInput(e.currentTarget.value)}
                placeholder='type "release" to confirm'
                // The accessible name has to carry the word itself: an
                // aria-label suppresses the placeholder from the a11y tree,
                // so "release confirmation" alone would leave a screen-reader
                // user with a dead button and no way to discover the password.
                aria-label='type the word "release" to confirm'
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
                release — resume minting (dead keys stay dead)
              </button>
            </form>
          </>
        ) : (
          <>
            <p className="text-[12px] ck-dim">
              one click disables every agent credential on this account: revokes all
              runtime keys, rotates all api keys, freezes minting, and stops queued
              gateway attempts. release later requires this dashboard; re-minting a
              runtime key still needs a controller-wallet signature.
            </p>
            <button
              type="button"
              className="ck-btn ck-btn-bracket ck-btn-accent self-start"
              onClick={() => void engage()}
              disabled={busy || engaged === null}
            >
              <Ik name="kill-switch" />
              engage kill switch
            </button>
          </>
        )}
        {error && <InlineError error={error} className="text-[12px]" />}
      </div>
    </section>
  );
}
