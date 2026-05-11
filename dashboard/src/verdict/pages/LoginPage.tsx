// ─── LoginPage — public sign-in shell at #/account/login (Phase 7a) ────────
//
// Renders the Nothing compact-shell sign-in surface. Privy's hosted login
// modal is invoked via `useAccount().signIn()`. After successful auth we
// navigate to the `?next=…` deep-link if present, else default to /account.
//
// Phase 7b will swap the placeholder methods row for a richer presentation
// (Google / email / passkey icons + wallet escape-hatch). For now we ship a
// single "[ SIGN IN ]" CTA — the modal itself shows the method picker.

import { useEffect } from "react";
import { CompactTopbar } from "../components/compact/Topbar.js";
import { useAccount } from "../hooks/useAccount.js";

interface LoginPageProps {
  /** Hash path to redirect to after successful auth (e.g. "/account"). */
  next: string | null;
}

export function LoginPage({ next }: LoginPageProps) {
  const account = useAccount();

  // Auto-redirect once Privy reports an authenticated session — handles
  // both "user clicks sign-in" and "user lands here already logged in".
  useEffect(() => {
    if (!account.isAuthenticated) return;
    const target = sanitizeNext(next) ?? "/account";
    if (window.location.hash !== `#${target}`) {
      window.location.hash = `#${target}`;
    }
  }, [account.isAuthenticated, next]);

  return (
    <div className="compact-shell min-h-dvh flex flex-col">
      <CompactTopbar
        crumb={
          <span>
            COMPETE <span className="ck-dim mx-1">/</span>
            <span className="ck-pos">SIGN IN</span>
          </span>
        }
      />

      <main className="flex-1 flex items-center justify-center px-4">
        <section className="ck-frame w-full max-w-[480px]">
          <div className="ck-header">
            <span className="ck-label ck-pos">SIGN IN · NO WALLET REQUIRED</span>
            <span className="ck-mono ck-dim">PRIVY</span>
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

            <button
              type="button"
              onClick={account.signIn}
              disabled={!account.configured || !account.ready || account.loading}
              className="ck-btn ck-btn-accent justify-center py-2"
            >
              [ SIGN IN ]
            </button>

            <p className="ck-mono ck-dim text-[10px]">
              privy handles auth. nothing on-chain happens here.
              <br />
              by continuing you accept the tos.
            </p>
          </div>
        </section>
      </main>
    </div>
  );
}

/**
 * Defence-in-depth: only allow same-origin hash paths (start with "/" and
 * exclude protocol-relative `//host` and absolute schemes). Prevents an
 * `?next=https://evil.example/...` from redirecting the user off-site.
 */
function sanitizeNext(next: string | null): string | null {
  if (!next) return null;
  if (!next.startsWith("/")) return null;
  if (next.startsWith("//")) return null;
  if (/^\s*(javascript|data|vbscript):/i.test(next)) return null;
  return next;
}
