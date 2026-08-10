// ─── LinkedLoginsPanel — link more login methods to ONE account ────────────
//
// Lives on #/account, between "your agents" and the FHE status chip. Lets a
// signed-in user attach additional login methods (email / Google / external
// wallet) to their CURRENT Privy account, so a future login with any of them
// resolves to the SAME account. This PREVENTS fragmentation going forward.
//
// It does NOT recover already-orphaned accounts and deliberately never invokes
// Privy's "login method transfer" — reparenting an identity off another user
// needs a backend flow that is out of scope here. When Privy reports the target
// identity already belongs to someone else, we surface a plain, non-misleading
// note and stop; we never promise a "merge".
//
// Usable login identities = email + google_oauth + EXTERNAL wallets. Embedded
// wallets (`walletClientType` "privy"/"privy-v2") and `smart_wallet` entries
// also live in `linkedAccounts`, but they are provisioned by Privy, not chosen
// as sign-in methods, so we never list them as logins.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  useLinkAccount,
  type PrivyErrorCode,
  type LinkedAccountWithMetadata,
} from "@privy-io/react-auth";
import { useAccount } from "../../hooks/useAccount.js";
import { Ik } from "../../icons.js";
import { shortId } from "../../lib/display-format.js";

/**
 * The PrivyErrorCode values this panel branches on.
 *
 * Spelled out rather than imported as a value: `PrivyErrorCode` is a
 * TypeScript enum that exists in Privy's .d.ts but NOT in its ESM runtime
 * bundle, so importing it as a value typechecks and then fails the production
 * build with "PrivyErrorCode is not exported". The `satisfies` clause keeps
 * these pinned to the real union — a renamed or removed code fails the
 * typecheck instead of silently never matching.
 */
const PRIVY_ERROR = {
  userExitedLinkFlow: "exited_link_flow",
  cannotLinkMoreOfType: "cannot_link_more_of_type",
  linkedToAnotherUser: "linked_to_another_user",
  accountTransferRequired: "account_transfer_required",
} as const satisfies Record<string, PrivyErrorCode>;

/** The three login methods this panel can attach. Drives pending + buttons. */
type LinkKind = "email" | "google" | "wallet";

/** A single usable (independent) login identity, normalized for display. */
interface UsableLogin {
  kind: LinkKind;
  /** Stable React key: chain+address / oauth subject / type+address. */
  key: string;
  /** Short type label shown in the row's left column. */
  label: string;
  /** Human-readable identity (email, or truncated wallet address). */
  display: string;
  /** Full value for the row's title tooltip. */
  title: string;
  /** Fingerprint token (type + address/identity) — order-stable. */
  fp: string;
}

/** A transient note shown under the action buttons. */
interface Note {
  text: string;
  tone: "dim" | "accent";
}

/** `0xabcdef…1234` — enough to recognize, short enough to sit in a row. */
function truncateAddress(addr: string): string {
  return shortId(addr, 6, 4);
}

/**
 * Reduce Privy's `linkedAccounts` to the identities that actually act as
 * independent logins. Embedded (`privy` / `privy-v2`) wallets and
 * `smart_wallet` entries are excluded — they are provisioned, not sign-in
 * methods. Phone / passkey / other socials are simply not surfaced here.
 */
function computeUsableLogins(
  accounts: readonly LinkedAccountWithMetadata[],
): UsableLogin[] {
  const out: UsableLogin[] = [];
  for (const acct of accounts) {
    if (acct.type === "email") {
      out.push({
        kind: "email",
        key: `email:${acct.address}`,
        label: "email",
        display: acct.address,
        title: acct.address,
        fp: `email:${acct.address}`,
      });
    } else if (acct.type === "google_oauth") {
      const identity = acct.email ?? acct.subject;
      out.push({
        kind: "google",
        key: `google_oauth:${acct.subject}`,
        label: "google",
        display: identity,
        title: identity,
        fp: `google_oauth:${identity}`,
      });
    } else if (acct.type === "wallet") {
      // Embedded wallets ride in the same array — skip them: they are not
      // a login the user can sign in with elsewhere.
      if (acct.walletClientType === "privy" || acct.walletClientType === "privy-v2") {
        continue;
      }
      out.push({
        kind: "wallet",
        key: `wallet:${acct.chainType}:${acct.address}`,
        label: "wallet",
        display: truncateAddress(acct.address),
        title: acct.address,
        fp: `wallet:${acct.address}`,
      });
    }
    // smart_wallet, passkey, phone, and other entry types are intentionally
    // not treated as independent logins and are left out.
  }
  return out;
}

export function LinkedLoginsPanel() {
  const account = useAccount();

  // Which link flow (if any) is currently open. Triggers return void — we
  // cannot await them — so this is our only handle on "in flight".
  const [pending, setPending] = useState<LinkKind | null>(null);
  const [note, setNote] = useState<Note | null>(null);

  const usable = useMemo(
    () => computeUsableLogins(account.linkedAccounts),
    [account.linkedAccounts],
  );

  // Order-stable fingerprint of the usable set. When a link succeeds, the
  // user object gains an entry and this string changes — our signal that the
  // flow resolved, independent of any callback firing.
  const fingerprint = useMemo(() => JSON.stringify(usable.map((u) => u.fp)), [usable]);

  // Clear the pending latch whenever the usable-login set actually changes.
  // This is the source of truth for "done" — NOT onSuccess — because the
  // linkedAccounts update is what unblocks the buttons. Runs once on mount
  // (null → null, harmless) and on every subsequent fingerprint change.
  useEffect(() => {
    setPending(null);
  }, [fingerprint]);

  // Stable success/error handlers so useLinkAccount doesn't re-register the
  // callbacks on every render.
  const onSuccess = useCallback(() => {
    // pending is cleared by the fingerprint effect once linkedAccounts
    // updates; here we just drop any stale note from a prior attempt.
    setNote(null);
  }, []);

  const onError = useCallback((code: PrivyErrorCode) => {
    // Always release the latch on error, regardless of the reason.
    setPending(null);
    if (code === PRIVY_ERROR.userExitedLinkFlow) {
      // User closed the modal — neutral, not a failure. Show nothing.
      setNote(null);
      return;
    }
    if (code === PRIVY_ERROR.cannotLinkMoreOfType) {
      setNote({ text: "already linked.", tone: "dim" });
      return;
    }
    if (
      code === PRIVY_ERROR.linkedToAnotherUser ||
      code === PRIVY_ERROR.accountTransferRequired
    ) {
      // Do NOT promise a merge/transfer — reparenting is out of scope.
      setNote({
        text: "that login is already tied to a different account.",
        tone: "dim",
      });
      return;
    }
    // must_be_authenticated, failed_to_link_account, and anything else.
    setNote({ text: "couldn't link — try again.", tone: "accent" });
  }, []);

  const callbacks = useMemo(() => ({ onSuccess, onError }), [onSuccess, onError]);
  const { linkEmail, linkGoogle, linkWallet } = useLinkAccount(callbacks);

  const startLink = useCallback((kind: LinkKind, trigger: () => void) => {
    setNote(null);
    setPending(kind);
    trigger();
  }, []);

  const hasEmail = usable.some((u) => u.kind === "email");
  const hasGoogle = usable.some((u) => u.kind === "google");
  const busy = pending !== null;

  // ─── One-time nudge (DID-scoped, localStorage-latched) ───────────────────
  const nudgeKey = account.userId ? `murmur_link_nudge_dismissed:${account.userId}` : null;
  const [nudgeDismissed, setNudgeDismissed] = useState<boolean>(() => {
    if (!nudgeKey) return false;
    try {
      return window.localStorage.getItem(nudgeKey) === "1";
    } catch {
      return false;
    }
  });

  // Re-read the latch once the DID hydrates (userId can be null on the very
  // first render before Privy's user settles).
  useEffect(() => {
    if (!nudgeKey) return;
    try {
      setNudgeDismissed(window.localStorage.getItem(nudgeKey) === "1");
    } catch {
      // localStorage unavailable (private mode etc.) — leave as-is.
    }
  }, [nudgeKey]);

  const dismissNudge = useCallback(() => {
    setNudgeDismissed(true);
    if (!nudgeKey) return;
    try {
      window.localStorage.setItem(nudgeKey, "1");
    } catch {
      // ignore — the nudge just re-appears next session in the no-storage path.
    }
  }, [nudgeKey]);

  // Nudge only when the user has EXACTLY one usable login — "you're reachable
  // by a single method, add a backup". At zero the empty state below already
  // teaches the same thing, so gating on `=== 1` avoids double messaging.
  const showNudge = usable.length === 1 && !nudgeDismissed;

  return (
    <section className="ck-frame w-full flex flex-col">
      <div className="ck-header">
        <span className="ck-title ck-title-ik">
          <Ik name="link" /> linked logins
        </span>
        <span className="ck-mono ck-dim">{usable.length} linked</span>
      </div>

      {showNudge && (
        <div className="px-3 py-2 flex items-start justify-between gap-3 border-b border-[var(--color-border)]">
          <p className="ck-dim text-[12px] max-w-[48ch]">
            link your other logins so your agents stay under one account.
          </p>
          <button
            type="button"
            onClick={dismissNudge}
            className="ck-btn ck-btn-bracket ck-dim shrink-0"
            aria-label="dismiss prompt"
          >
            dismiss
          </button>
        </div>
      )}

      {usable.length === 0 ? (
        <div className="px-4 py-6 flex flex-col items-start gap-2">
          <p className="ck-mono ck-dim">no independent logins yet.</p>
          <p className="ck-dim text-[12px] max-w-[48ch]">
            link an email, google, or wallet below so you can always get back
            into this same account.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-[var(--color-border)]">
          {usable.map((u) => (
            <li
              key={u.key}
              className="grid grid-cols-[64px_1fr] items-center px-3 py-2 gap-3"
            >
              <span className="ck-dim text-[12px] uppercase">{u.label}</span>
              <span className="ck-mono ck-pos truncate" title={u.title}>
                {u.display}
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="px-3 py-3 border-t border-[var(--color-border)] flex flex-wrap items-center gap-2">
        {!hasEmail && (
          <button
            type="button"
            disabled={busy}
            onClick={() => startLink("email", linkEmail)}
            className="ck-btn ck-btn-bracket ck-pos"
            aria-label="link email"
          >
            + email
          </button>
        )}
        {!hasGoogle && (
          <button
            type="button"
            disabled={busy}
            onClick={() => startLink("google", linkGoogle)}
            className="ck-btn ck-btn-bracket ck-pos"
            aria-label="link google"
          >
            + google
          </button>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={() => startLink("wallet", linkWallet)}
          className="ck-btn ck-btn-bracket ck-pos"
          aria-label="link wallet"
        >
          <Ik name="controller-wallet" />
          + wallet
        </button>

        {pending && (
          <span className="ck-dim text-[12px]">linking {pending}…</span>
        )}
        {note && (
          <span
            className={note.tone === "dim" ? "ck-dim text-[12px]" : "text-[12px]"}
            style={note.tone === "accent" ? { color: "var(--color-accent-ink)" } : undefined}
            role={note.tone === "accent" ? "alert" : undefined}
          >
            {note.text}
          </span>
        )}
      </div>
    </section>
  );
}
