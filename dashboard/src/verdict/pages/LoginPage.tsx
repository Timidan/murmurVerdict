// ─── LoginPage — public sign-in shell at #/account/login ───────────────────
// Opens Privy's modal via `useAccount().signIn()`; after auth, goes to `?next=` or /account.

import { useCallback, useEffect } from "react";
import { TopbarCrumb } from "../components/compact/TopbarCrumb.js";
import { InlineError } from "../components/compact/InlineError.js";
import { useAccount } from "../hooks/useAccount.js";
import { useFunnelEmit } from "../hooks/useFunnelEmit.js";

interface LoginPageProps {
  /** Hash path to redirect to after successful auth (e.g. "/account"). */
  next: string | null;
}

export function LoginPage({ next }: LoginPageProps) {
  const account = useAccount();
  const emitFunnel = useFunnelEmit();

  // Redirect once authenticated. Clean path, not `#<target>`, and replace() so
  // Back doesn't bounce through this page.
  useEffect(() => {
    if (!account.isAuthenticated) return;
    const target = sanitizeNext(next) ?? "/account";
    const here = `${window.location.pathname}${window.location.search}`;
    if (here !== target) {
      window.location.replace(target);
    }
  }, [account.isAuthenticated, next]);

  /**
   * Emit privy.modal_opened, then open the modal. With no bearer yet,
   * useFunnelEmit drops it; `privy.signed_in` is the signal that lands.
   */
  const onSignInClick = useCallback(() => {
    void emitFunnel("privy.modal_opened");
    account.signIn();
  }, [account, emitFunnel]);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <TopbarCrumb><span>
            account <span className="ck-dim mx-1">/</span>
            <span className="ck-pos">sign in</span>
          </span></TopbarCrumb>

      <main className="flex-1 flex items-center justify-center px-4">
        <section className="ck-frame w-full max-w-[480px]">
          <div className="ck-header">
            <span className="ck-title">Sign in</span>
            <span className="ck-mono ck-dim">privy</span>
          </div>

          <div className="px-4 py-6 flex flex-col gap-4">
            <p className="ck-mono ck-dim leading-relaxed">
              You do not need a wallet.
              <br />
              You do not need to prove your identity.
              <br />
              Your code talks to murmur with a runtime key.
            </p>

            {!account.configured && (
              <div className="ck-frame-strong px-3 py-2 ck-mono ck-neg">
                Sign-in is not configured. Set VITE_PRIVY_APP_ID, then build again.
              </div>
            )}

            {account.error && (
              <InlineError
                error={`sign-in: ${account.error}`}
                className="ck-frame-strong px-3 py-2 ck-mono"
              />
            )}

            <p className="ck-mono ck-dim">
              Sign in to manage your agents, mint runtime and api keys, and set
              your payout address.
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

            <p className="ck-dim text-[12px]">
              Privy handles sign-in. Nothing goes on chain here. Signing in
              means you accept the{" "}
              <a href="#/terms" className="ck-pos no-underline hover:underline">terms</a> and the{" "}
              <a href="#/privacy" className="ck-pos no-underline hover:underline">privacy notice</a>.
            </p>
          </div>
        </section>
      </main>
    </div>
  );
}

/**
 * Allow only same-origin local paths (validated after the Router decodes them):
 * one leading "/" not followed by "/" or "\", no backslash anywhere, no scheme.
 * Browsers normalize "\" to "/", so "/\evil.example" would leave the origin.
 */
function sanitizeNext(next: string | null): string | null {
  if (!next) return null;
  // Single leading slash, and the next char (if any) is neither "/" nor "\".
  if (!/^\/(?![/\\])/.test(next)) return null;
  // No backslash anywhere (mid-path "\" also normalizes).
  if (next.includes("\\")) return null;
  if (/^\s*(javascript|data|vbscript):/i.test(next)) return null;
  return next;
}
