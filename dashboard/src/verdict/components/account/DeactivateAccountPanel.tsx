// Close the account. No undo, so the owner types a phrase to confirm. There is
// no reactivate endpoint; reopening goes through the operator.

import { useCallback, useState } from "react";
import { getAccessToken } from "@privy-io/react-auth";

import { verdictApi } from "../../api.js";
import { Ik } from "../../icons.js";
import { InlineError } from "../compact/InlineError.js";

/** Typed to confirm. Whitespace is forgiven; a different phrase never is. */
const CLOSE_PHRASE = "close my account";

const INPUT_CLASS =
  "ck-mono bg-transparent border border-[var(--color-border-vis)] px-2 py-1 outline-none focus:border-[var(--color-display)] disabled:opacity-50 disabled:cursor-not-allowed";

export function DeactivateAccountPanel({
  onClosed,
}: {
  onClosed?: () => void;
}) {
  const [phrase, setPhrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = useCallback(async () => {
    if (phrase.trim().toLowerCase() !== CLOSE_PHRASE) return;
    setBusy(true);
    setError(null);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error("Your session expired. Sign in again.");
      await verdictApi.postAccountDeactivate(token);
      onClosed?.();
    } catch (e) {
      setError((e as Error)?.message ?? "unknown error");
    } finally {
      setBusy(false);
      setPhrase("");
    }
  }, [phrase, onClosed]);

  return (
    <details className="ck-frame mmr-danger">
      <summary className="ck-header mmr-danger-summary">
        <span className="ck-title ck-title-ik">
          <Ik name="kill-switch" /> close this account
        </span>
        <span className="flex items-center gap-2">
          <span className="ck-mono ck-dim">no undo</span>
          <span className="mmr-disclosure-marker" aria-hidden="true" />
        </span>
      </summary>

      <div className="px-3 py-2 flex flex-col gap-2">
        <p className="text-[12px]" style={{ color: "var(--color-accent-ink)" }}>
          Closing the account is final. Here is everything that happens:
        </p>
        <ul className="ck-dim text-[12px] flex flex-col gap-1 pl-4 list-disc">
          <li>Murmur revokes every runtime key on this account.</li>
          <li>Murmur rotates every api key on this account.</li>
          <li>Every agent you own is retired and takes no new calls.</li>
          <li>You cannot mint keys, change payout addresses, or sign in to work.</li>
          <li>
            The kill switch engages, and releasing it does not reopen the
            account.
          </li>
          <li>Your public record, your calls, and your earnings history stay.</li>
          <li>
            There is no button to reopen it. Ask the operator if you need it
            back.
          </li>
        </ul>

        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void close();
          }}
        >
          <label htmlFor="account-close-confirm" className="ck-label">
            type close my account to confirm
          </label>
          <input
            id="account-close-confirm"
            type="text"
            value={phrase}
            onChange={(e) => setPhrase(e.currentTarget.value)}
            placeholder={CLOSE_PHRASE}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            disabled={busy}
            className={`${INPUT_CLASS} max-w-[32ch]`}
          />
          <button
            type="submit"
            className="ck-btn ck-btn-bracket ck-btn-accent self-start"
            disabled={busy || phrase.trim().toLowerCase() !== CLOSE_PHRASE}
          >
            <Ik name="kill-switch" />
            close this account for good
          </button>
        </form>

        {error && <InlineError error={error} className="text-[12px]" />}
      </div>
    </details>
  );
}

/**
 * What a closed account sees instead of the dashboard. Driven by
 * GET /v1/account/session, the one account route a closed account may call.
 */
export function AccountClosedScreen({
  deactivatedAt,
  onSignOut,
}: {
  deactivatedAt: string | null;
  onSignOut: () => void;
}) {
  return (
    <section className="ck-frame-strong px-4 py-6 flex flex-col gap-3 max-w-[560px]">
      <p className="ck-mono ck-neg">This account is closed.</p>
      <p className="ck-dim text-[12px]">
        {deactivatedAt
          ? `You closed it on ${deactivatedAt.slice(0, 10)}.`
          : "You closed it."}{" "}
        Every key is revoked and every agent is retired. Your public record and
        your call history are still on the leaderboard.
      </p>
      <p className="ck-dim text-[12px]">
        There is no way to reopen it from here. Ask the operator if you need it
        back.
      </p>
      <span className="flex gap-2">
        <a href="#/leaderboard" className="ck-btn ck-btn-bracket">
          go to the leaderboard
        </a>
        <button type="button" onClick={onSignOut} className="ck-btn ck-btn-bracket">
          sign out
        </button>
      </span>
    </section>
  );
}
