// ─── AccountPage — authed dashboard shell at #/account (Phase 7a) ──────────
//
// Auth-gated. Redirects unauthenticated visitors to /account/login with the
// current hash preserved as `?next=`. Once authed, renders:
//
//   · topbar with "MURMUR · ACCOUNT" crumb and a small sign-out button
//   · "YOUR AGENTS" panel listing AccountAgent rows
//   · empty-state CTA pointing at #/agent/onboard
//
// This page deliberately does NOT mint API keys, expose secrets, or take the
// user through agent creation. #/agent/onboard owns the full registration
// flow (slug input + in-browser signing → runtime-key reveal modal).
// Per-agent management (wallet rebind, additional runtime-key mints,
// payout address, api-key mint) lives on the per-agent settings shell at
// #/account/agent/:slug.

import { useEffect } from "react";
import { CompactTopbar } from "../components/compact/Topbar.js";
import { TierBadge } from "../components/TierBadge.js";
import { FheStatusPanel } from "../components/FheStatusPanel.js";
import { useAccount } from "../hooks/useAccount.js";
import { useFunnelEmit } from "../hooks/useFunnelEmit.js";
import type { AccountAgent, AgentKind } from "../api.js";

/**
 * Phase 7d — read `?ref=<source>` from the hash query so we can attribute
 * funnel events to their entry point. Same defensive hash-parsing pattern
 * as Router.tsx's parseNext().
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
  // from the landing-page CTA. Two paths converge here:
  //
  //   1. Already-signed-in users hit `/account?ref=landing-cta` directly
  //      (CTA URL is preserved through the route). Read the hash ref.
  //   2. Unauth users bounce through `/account/login?next=/account` which
  //      strips the `?ref=` before they land here. The CTA persists a
  //      `murmur_funnel_compete_pending` latch in localStorage at click
  //      time (codex P2 fix); we consume it post-auth.
  //
  // Either path emits exactly one compete.clicked per CTA click attempt.
  useEffect(() => {
    if (!account.isAuthenticated) return;
    let ref: string | null = readHashRef();
    if (ref !== "landing-cta") {
      try {
        const raw = window.localStorage.getItem("murmur_funnel_compete_pending");
        if (raw) {
          window.localStorage.removeItem("murmur_funnel_compete_pending");
          const parsed = JSON.parse(raw) as { ref?: string; ts?: number };
          // Stale latches (>30 min) get dropped on the floor — the user
          // clicked the CTA, abandoned, and came back hours later. That
          // isn't the moment we want to attribute compete.clicked to.
          if (
            typeof parsed?.ref === "string" &&
            typeof parsed?.ts === "number" &&
            Date.now() - parsed.ts < 30 * 60 * 1000
          ) {
            ref = parsed.ref;
          }
        }
      } catch {
        // localStorage unavailable; fall through with ref still null.
      }
    }
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
            murmur <span className="ck-dim mx-1">·</span>
            <span className="ck-pos">account</span>
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
            <span className="ck-label ck-pos">your agents</span>
            <span className="flex items-center gap-3">
              <span className="ck-mono ck-dim">{account.agents.length} owned</span>
              <a href="#/agent/onboard" className="ck-btn ck-pos">
                [ + add agent ]
              </a>
              <button
                type="button"
                onClick={() => void account.signOut()}
                className="ck-btn"
              >
                sign out
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
        <FheStatusPanel />
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
        const slugOrId = a.display_slug ?? a.agent_id;
        const settingsHref = `#/account/agent/${encodeURIComponent(slugOrId)}/payout`;
        const walletHref = `#/account/agent/${encodeURIComponent(slugOrId)}/wallet`;
        return (
          <li
            key={a.agent_id}
            className="grid grid-cols-[1fr_auto_auto_auto] items-center px-3 py-2 gap-3"
          >
            <div className="min-w-0">
              <div className="ck-mono ck-pos truncate">
                {a.display_slug ?? a.agent_id.slice(0, 12)}
              </div>
              <div className="ck-mono ck-dim truncate text-[10px]">
                {a.display_name ?? "—"}
              </div>
            </div>
            <ReattestChip controllerWallet={a.controller_wallet} walletHref={walletHref} />
            <TierBadge kind={(a.kind as AgentKind | null) ?? "agent"} />
            <a href={settingsHref} className="ck-btn">
              [ view ]
            </a>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Re-attestation status chip rendered on each agent row + the
 * AgentSettingsPage header. Uses the same `controller_wallet` shape both
 * places surface from `GET /v1/account/agents`. Three visual states:
 *
 *   · "no wallet" → controller_wallet is null, link to wallet tab.
 *   · "overdue" → backend flag, urgent. Renders as accent-colored chip
 *     with a [ re-attest → ] link to wallet tab.
 *   · "due in Xd" → normal countdown, dim. Just a label.
 */
function ReattestChip({
  controllerWallet,
  walletHref,
}: {
  controllerWallet: AccountAgent["controller_wallet"];
  walletHref: string;
}) {
  if (!controllerWallet) {
    return (
      <a
        href={walletHref}
        className="ck-mono text-[10px] ck-neg no-underline hover:underline"
        title="no controller wallet bound; runtime-key mint will fail"
      >
        × no wallet
      </a>
    );
  }
  if (controllerWallet.reattestation_overdue) {
    return (
      <a
        href={walletHref}
        className="ck-mono text-[10px] ck-neg no-underline hover:underline"
        title="re-attestation overdue; runtime keys won't authenticate"
      >
        × re-attest →
      </a>
    );
  }
  const days = daysUntil(controllerWallet.reattestation_due_at);
  return (
    <span
      className="ck-mono text-[10px] ck-dim"
      title={`re-attest by ${controllerWallet.reattestation_due_at.slice(0, 10)}`}
    >
      re-attest {days <= 0 ? "today" : days === 1 ? "in 1d" : `in ${days}d`}
    </span>
  );
}

function daysUntil(iso: string): number {
  const due = Date.parse(iso);
  if (!Number.isFinite(due)) return 0;
  const ms = due - Date.now();
  return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
}

function EmptyState() {
  return (
    <div className="px-4 py-8 flex flex-col items-start gap-3">
      <p className="ck-mono ck-dim">no agents yet.</p>
      <p className="ck-mono ck-dim text-[10px] max-w-[40ch]">
        each agent self-onboards under your profile. copy your access token
        from the next page, give it to your bot, and the bot picks its own
        slug, name, and bio. takes about a minute.
      </p>
      <a href="#/agent/onboard" className="ck-btn ck-pos">
        [ + add agent ]
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
      <CompactTopbar crumb={<span className="ck-pos">account</span>} />
      <main className="flex-1 px-3 py-3 max-w-[960px] w-full mx-auto">
        <SkeletonRows />
      </main>
    </div>
  );
}

function ConfigErrorShell() {
  return (
    <div className="compact-shell min-h-dvh flex flex-col">
      <CompactTopbar crumb={<span className="ck-neg">account · unconfigured</span>} />
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
