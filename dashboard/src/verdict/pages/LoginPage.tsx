// ─── LoginPage — public sign-in shell at #/account/login (Phase 7a) ────────
//
// Renders the Nothing mmr-shell sign-in surface. Privy's hosted login
// modal is invoked via `useAccount().signIn()`. After successful auth we
// navigate to the `?next=…` deep-link if present, else default to /account.
//
// Phase 7b will swap the placeholder methods row for a richer presentation
// (Google / email / passkey icons + wallet escape-hatch). For now we ship a
// single "[ SIGN IN ]" CTA — the modal itself shows the method picker.

import { useCallback, useEffect } from "react";
import { CompactTopbar } from "../components/compact/Topbar.js";
import { useAccount } from "../hooks/useAccount.js";
import { useFunnelEmit } from "../hooks/useFunnelEmit.js";

interface LoginPageProps {
  /** Hash path to redirect to after successful auth (e.g. "/account"). */
  next: string | null;
}

export function LoginPage({ next }: LoginPageProps) {
  const account = useAccount();
  const emitFunnel = useFunnelEmit();

  // Auto-redirect once Privy reports an authenticated session — handles
  // both "user clicks sign-in" and "user lands here already logged in".
  // Clean path form (assigning `#<target>` here would stack a hash route
  // onto the `/account/login` path); replace() so Back doesn't bounce
  // through the login page, whose effect would immediately re-redirect.
  useEffect(() => {
    if (!account.isAuthenticated) return;
    const target = sanitizeNext(next) ?? "/account";
    const here = `${window.location.pathname}${window.location.search}`;
    if (here !== target) {
      window.location.replace(target);
    }
  }, [account.isAuthenticated, next]);

  /**
   * Phase 7d — fire privy.modal_opened on the sign-in click. The actual
   * Privy hosted modal opens inside account.signIn(); we emit BEFORE
   * invoking it so a slow-network funnel event doesn't gate the modal.
   *
   * Known limitation: the user hasn't authenticated yet, so the emit
   * has no Privy bearer to attach. useFunnelEmit drops it on the floor
   * (the route requires auth). The downstream `privy.signed_in` emit
   * fired from useAccount is the load-bearing signal — modal_opened is
   * useful only if/when we add an anon-emit path or a client-side
   * buffer-on-signin flush. Wired today so the call-site exists when
   * either lands.
   */
  const onSignInClick = useCallback(() => {
    void emitFunnel("privy.modal_opened");
    account.signIn();
  }, [account, emitFunnel]);

  return (
    <div className="mmr-shell min-h-dvh flex flex-col">
      <CompactTopbar
        crumb={
          <span>
            account <span className="ck-dim mx-1">/</span>
            <span className="ck-pos">sign in</span>
          </span>
        }
      />

      <main className="flex-1 flex items-center justify-center px-4">
        <section className="ck-frame w-full max-w-[480px]">
          <div className="ck-header">
            <span className="ck-title">sign in · no wallet required</span>
            <span className="ck-mono ck-dim">privy</span>
          </div>

          <div className="px-4 py-6 flex flex-col gap-4">
            <p className="ck-mono ck-dim leading-relaxed">
              no wallet required.
              <br />
              no kyc.
              <br />
              your code talks to murmur via api key.
            </p>

            {!account.configured && (
              <div className="ck-frame-strong px-3 py-2 ck-mono ck-neg">
                privy not configured — set VITE_PRIVY_APP_ID and rebuild.
              </div>
            )}

            {account.error && (
              <div className="ck-frame-strong px-3 py-2 ck-mono ck-neg">
                auth error: {account.error}
              </div>
            )}

            <p className="ck-mono ck-dim text-xs">
              signing in unlocks: manage your agents · mint runtime + api
              keys · set payout address
            </p>

            <button
              type="button"
              onClick={onSignInClick}
              disabled={!account.configured || !account.ready || account.loading}
              className="ck-btn ck-btn-bracket ck-pos justify-center py-2"
              aria-label="sign in"
            >
              sign in
            </button>

            {/* No terms-of-service document exists in this repo yet — the
                previous "by continuing you accept the tos." line referenced
                a target that doesn't exist, so it was removed rather than
                linked. Reinstate (with a real link) once terms ship. */}
            <p className="ck-mono ck-dim text-[10px]">
              privy handles auth. nothing on-chain happens here.
            </p>
          </div>
        </section>
      </main>
    </div>
  );
}

/**
 * Defence-in-depth: only allow same-origin local paths. The Router already
 * percent-decodes `?next=` before it reaches here, so we validate the decoded
 * form. Accept ONLY a single leading "/" NOT followed by another "/" or "\",
 * with no backslash anywhere and no scheme prefix.
 *
 * Why the backslash guard matters: browsers normalize "\" to "/" when
 * navigating, so `location.replace("/\\evil.example")` resolves to the
 * protocol-relative `//evil.example` and leaves the origin. Rejecting a
 * leading "/\" (and any "\" at all) closes that bypass alongside the classic
 * protocol-relative "//host" one and the `javascript:`/`data:` scheme cases.
 */
function sanitizeNext(next: string | null): string | null {
  if (!next) return null;
  // Single leading slash, and the next char (if any) is neither "/" nor "\".
  if (!/^\/(?![/\\])/.test(next)) return null;
  // Belt-and-braces: no backslash anywhere (mid-path "\" also normalizes).
  if (next.includes("\\")) return null;
  if (/^\s*(javascript|data|vbscript):/i.test(next)) return null;
  return next;
}
