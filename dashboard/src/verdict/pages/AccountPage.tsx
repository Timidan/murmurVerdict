// ─── AccountPage — authed dashboard shell at #/account (Phase 7a) ──────────
//
// Auth-gated. Redirects unauthenticated visitors to /account/login with the
// current hash preserved as `?next=`. Once authed, renders:
//
//   · topbar with "MURMUR · ACCOUNT" crumb and a small sign-out button
//   · "YOUR AGENTS" panel listing AccountAgent rows
//   · empty-state CTA pointing at #/account/agent/new (Phase 7b page)
//
// This page deliberately does NOT mint API keys, expose secrets, or take the
// user through agent creation — those live in Phase 7b/c/d.

import { useEffect } from "react";
import { CompactTopbar } from "../components/compact/Topbar.js";
import { TierBadge } from "../components/TierBadge.js";
import { useAccount } from "../hooks/useAccount.js";
import { useFunnelEmit } from "../hooks/useFunnelEmit.js";
import type { AccountAgent, AgentKind } from "../api.js";

/**
 * Phase 7d — read `?ref=<source>` from the hash query so we can attribute
 * funnel events to their entry point. Mirrors the parseVariant /
 * parseNext defensive parsing pattern in Router.tsx.
 */
function readHashRef(): string | null {
  if (typeof window === "undefined") return null;
  const raw = window.location.hash.replace(/^#/, "");
  const qIdx = raw.indexOf("?");
  if (qIdx < 0) return null;
  try {
    return new URLSearchParams(raw.slice(qIdx + 1)).get("ref");
  } catch {
    return null;
  }
}

export function AccountPage() {
  const account = useAccount();
  const emitFunnel = useFunnelEmit();

  // Redirect to login when Privy reports a stable "not signed in" state.
  // Wait for `ready` so we don't bounce the user mid-bootstrap.
  useEffect(() => {
    if (!account.ready) return;
    if (account.isAuthenticated) return;
    const next = encodeURIComponent("/account");
    window.location.hash = `#/account/login?next=${next}`;
  }, [account.ready, account.isAuthenticated]);

  // Phase 7d — fire compete.clicked only when the user actually arrived
  // from the landing-page CTA (carries ?ref=landing-cta). We don't fire
  // on every /account visit because that would double-count: returning
  // users hit this page directly. The emit is gated on isAuthenticated
  // so it doesn't get dropped by the anon-kinds path in useFunnelEmit.
  useEffect(() => {
    if (!account.isAuthenticated) return;
    const ref = readHashRef();
    if (ref !== "landing-cta") return;
    void emitFunnel("compete.clicked", { ref });
  }, [account.isAuthenticated, emitFunnel]);

  if (!account.configured) {
    return <ConfigErrorShell />;
  }

  if (!account.ready) {
    return <LoadingShell />;
  }

  if (!account.isAuthenticated) {
    // Redirect effect above will fire on next render; keep the shell quiet.
    return <LoadingShell />;
  }

  return (
    <div className="compact-shell min-h-dvh flex flex-col">
      <CompactTopbar
        crumb={
          <span>
            MURMUR <span className="ck-dim mx-1">·</span>
            <span className="ck-pos">ACCOUNT</span>
            {account.email && (
              <>
                <span className="ck-dim mx-1">·</span>
                <span className="ck-mono ck-dim">{account.email}</span>
              </>
            )}
          </span>
        }
      />

      <main className="flex-1 px-3 py-3 flex flex-col gap-3 max-w-[960px] w-full mx-auto">
        <section className="ck-frame">
          <div className="ck-header">
            <span className="ck-label ck-pos">YOUR AGENTS</span>
            <span className="flex items-center gap-3">
              <span className="ck-mono ck-dim">{account.agents.length} OWNED</span>
              <a href="#/account/agent/new" className="ck-btn ck-btn-accent">
                [ + NEW AGENT ]
              </a>
              <button
                type="button"
                onClick={() => void account.signOut()}
                className="ck-btn"
              >
                SIGN OUT
              </button>
            </span>
          </div>

          {account.error && (
            <div className="px-3 py-2 ck-mono ck-neg border-b border-[var(--color-border)]">
              error: {account.error}
            </div>
          )}

          {account.loading && account.agents.length === 0 ? (
            <SkeletonRows />
          ) : account.agents.length === 0 ? (
            <EmptyState />
          ) : (
            <AgentList agents={account.agents} />
          )}
        </section>
      </main>
    </div>
  );
}

function AgentList({ agents }: { agents: AccountAgent[] }) {
  return (
    <ul className="divide-y divide-[var(--color-border)]">
      {agents.map((a) => {
        // Settings page is the most common entry point (set payout, mint
        // additional keys). Fall back to agent_id when the slug hasn't
        // hydrated yet — same defensive posture as Phase 7a.
        const settingsHref = `#/account/agent/${encodeURIComponent(
          a.display_slug ?? a.agent_id,
        )}/payout`;
        return (
          <li
            key={a.agent_id}
            className="grid grid-cols-[1fr_auto_auto] items-center px-3 py-2 gap-3"
          >
            <div className="min-w-0">
              <div className="ck-mono ck-pos truncate">
                {a.display_slug ?? a.agent_id.slice(0, 12)}
              </div>
              <div className="ck-mono ck-dim truncate text-[10px]">
                {a.display_name ?? "—"}
              </div>
            </div>
            <TierBadge kind={(a.kind as AgentKind | null) ?? "casual"} />
            <a href={settingsHref} className="ck-btn">
              [ VIEW ]
            </a>
          </li>
        );
      })}
    </ul>
  );
}

function EmptyState() {
  return (
    <div className="px-4 py-8 flex flex-col items-start gap-3">
      <p className="ck-mono ck-dim">no agents yet.</p>
      <p className="ck-mono ck-dim text-[10px] max-w-[40ch]">
        declare an agent to mint an api key and start submitting calls. takes about a minute.
      </p>
      <a href="#/account/agent/new" className="ck-btn ck-btn-accent">
        [ + NEW AGENT ]
      </a>
    </div>
  );
}

function SkeletonRows() {
  // Hairline skeleton — no spinner. Per DESIGN.md §10 (no spinner > 800ms).
  return (
    <ul>
      {[0, 1, 2].map((i) => (
        <li
          key={i}
          className="grid grid-cols-[1fr_auto_auto] items-center px-3 py-2 gap-3 border-b border-[var(--color-border)]"
        >
          <div className="h-[10px] bg-[var(--color-border)] w-[60%]" />
          <div className="h-[8px] bg-[var(--color-border)] w-[40px]" />
          <div className="h-[10px] bg-[var(--color-border)] w-[48px]" />
        </li>
      ))}
    </ul>
  );
}

function LoadingShell() {
  return (
    <div className="compact-shell min-h-dvh flex flex-col">
      <CompactTopbar crumb={<span className="ck-pos">ACCOUNT</span>} />
      <main className="flex-1 px-3 py-3 max-w-[960px] w-full mx-auto">
        <SkeletonRows />
      </main>
    </div>
  );
}

function ConfigErrorShell() {
  return (
    <div className="compact-shell min-h-dvh flex flex-col">
      <CompactTopbar crumb={<span className="ck-neg">ACCOUNT · UNCONFIGURED</span>} />
      <main className="flex-1 px-3 py-3 max-w-[960px] w-full mx-auto">
        <section className="ck-frame-strong px-4 py-4">
          <p className="ck-mono ck-neg">privy not configured.</p>
          <p className="ck-mono ck-dim mt-2 text-[10px]">
            set <code>VITE_PRIVY_APP_ID</code> in dashboard/.env.local and rebuild.
          </p>
        </section>
      </main>
    </div>
  );
}
