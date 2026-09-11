// ─── AccountPage — authed dashboard shell at #/account ─────────────────────
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
import { Ik, IkNav } from "../icons.js";
import { TopbarCrumb } from "../components/compact/TopbarCrumb.js";
import { InlineError } from "../components/compact/InlineError.js";
import { TierBadge } from "../components/TierBadge.js";
import { FheStatusPanel } from "../components/FheStatusPanel.js";
import { LinkedLoginsPanel } from "../components/account/LinkedLoginsPanel.js";
import { ActivityPanel } from "../components/account/ActivityPanel.js";
import { KillSwitchPanel } from "../components/account/KillSwitchPanel.js";
import { WebhooksPanel } from "../components/account/WebhooksPanel.js";
import { PurchasesPanel } from "../components/account/PurchasesPanel.js";
import {
  AccountClosedScreen,
  DeactivateAccountPanel,
} from "../components/account/DeactivateAccountPanel.js";
import { useAccount } from "../hooks/useAccount.js";
import { useFunnelEmit } from "../hooks/useFunnelEmit.js";
import type { AccountAgent, AgentKind } from "../api.js";

/**
 * read `?ref=<source>` from the hash query so we can attribute
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

  // Re-pull the owned-agent list on every authenticated mount. useAccount's
  // bootstrap fetches once per login; landing here after onboarding — or after
  // any reload — must reflect current state, so refetch defensively instead of
  // trusting the cached array. refreshAgents is a stable useCallback.
  useEffect(() => {
    if (account.isAuthenticated) void account.refreshAgents();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account.isAuthenticated]);

  // fire compete.clicked only when the user actually arrived
  // from the landing-page CTA. Two paths converge here:
  //
  //   1. Already-signed-in users hit `/account?ref=landing-cta` directly
  //      (CTA URL is preserved through the route). Read the hash ref.
  //   2. Unauth users bounce through `/account/login?next=/account` which
  //      strips the `?ref=` before they land here. The CTA persists a
  //      `murmur_funnel_compete_pending` latch in localStorage at click
  //      time; we consume it post-auth.
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

  // A closed account gets the terminal screen and nothing else. Every panel
  // below would 403 anyway; rendering them would only produce a wall of
  // identical errors with no explanation among them.
  if (account.deactivated) {
    return (
      <div className="flex-1 flex flex-col min-h-0">
        <TopbarCrumb>
          <span className="ck-neg">account · closed</span>
        </TopbarCrumb>
        <main className="flex-1 px-3 py-3 ck-page">
          <AccountClosedScreen
            deactivatedAt={account.deactivatedAt}
            onSignOut={() => void account.signOut()}
          />
        </main>
      </div>
    );
  }

  // "0 owned" and "no agents yet" are claims about the account, and only a
  // landed session backs them. Before that, and after a failure, the count is
  // unknown — never zero.
  const listed = account.settled && !account.error;

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <TopbarCrumb><span>
            murmur <span className="ck-dim mx-1">·</span>
            <span className="ck-pos">account</span>
            {account.email && (
              <>
                <span className="ck-dim mx-1">·</span>
                <span className="ck-mono ck-dim">{account.email}</span>
              </>
            )}
          </span></TopbarCrumb>

      {/* Bento, not a stack. Eight equal-width panels gave "no webhooks yet"
          the same weight as the agent list; span sizes encode what matters.
          Single column under md — a phone has one column of attention. */}
      <main className="flex-1 px-3 py-3 grid grid-cols-1 md:grid-cols-6 gap-3 content-start ck-page">
        <section className="ck-frame md:col-span-6">
          <div className="ck-header">
            <span className="ck-title ck-title-ik">
              <IkNav name="agent" /> your agents
            </span>
            <span className="flex items-center gap-3">
              <span className="ck-mono ck-dim">
                {listed ? `${account.agents.length} owned` : "— owned"}
              </span>
              <a href="#/agent/onboard" className="ck-btn ck-btn-bracket ck-pos">
                <Ik name="agent" />
                + add an agent
              </a>
              <button
                type="button"
                onClick={() => void account.signOut()}
                className="ck-btn ck-btn-bracket"
              >
                sign out
              </button>
            </span>
          </div>

          {account.error && (
            <InlineError
              error={account.error}
              className="px-3 py-2 ck-mono border-b border-[var(--color-border)]"
            />
          )}

          {account.agents.length > 0 ? (
            <AgentList agents={account.agents} />
          ) : listed ? (
            <EmptyState />
          ) : account.error ? null : (
            <SkeletonRows />
          )}
        </section>
        {/* Row 2: the three that are usually empty or a single value. They
            cost a third of a row each instead of a full one. */}
        <div className="md:col-span-2 flex [&>*]:w-full">
          <LinkedLoginsPanel />
        </div>
        <div className="md:col-span-2 flex [&>*]:w-full">
          <WebhooksPanel agents={account.agents} />
        </div>
        <div className="md:col-span-2 flex [&>*]:w-full">
          <ActivityPanel />
        </div>

        {/* Row 3: purchases carries a wallet and two controls, so it earns
            half a row. */}
        <div className="md:col-span-3 flex [&>*]:w-full">
          <PurchasesPanel agents={account.agents} />
        </div>

        {/* ONE tile, two rows — not two stacked panels, which would reintroduce
            the vertical stack this layout exists to remove. Both children keep
            their own <details> and forms; mmr-safety only drops their frames so
            they read as rows. Still ordered pause-then-close: one is a pause
            with a release button, the other has no undo, so the reversible
            control sits first in the path. */}
        <section className="ck-frame md:col-span-3 mmr-safety">
          <div className="ck-header">
            <span className="ck-title ck-title-ik">
              <Ik name="kill-switch" /> safety
            </span>
          </div>
          <KillSwitchPanel />
          <DeactivateAccountPanel
            onClosed={() => {
              // Re-enter the bootstrap so the terminal screen renders from the
              // server's own answer rather than from local optimism.
              window.location.reload();
            }}
          />
        </section>

        <div className="md:col-span-6">
          <FheStatusPanel />
        </div>
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
        // hydrated yet.
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
              <div className="ck-dim truncate text-[12px]">
                {a.display_name ?? "—"}
              </div>
            </div>
            <ReattestChip controllerWallet={a.controller_wallet} walletHref={walletHref} />
            <TierBadge kind={(a.kind as AgentKind | null) ?? "agent"} />
            <a href={settingsHref} className="ck-btn ck-btn-bracket">
              view
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
        className="text-[12px] ck-neg no-underline hover:underline"
        title="no controller wallet is bound, so you cannot mint a runtime key"
      >
        × no wallet
      </a>
    );
  }
  if (controllerWallet.reattestation_overdue) {
    return (
      <a
        href={walletHref}
        className="text-[12px] ck-neg no-underline hover:underline"
        title="this wallet needs a fresh signature, or its runtime keys stop working"
      >
        × sign again →
      </a>
    );
  }
  const days = daysUntil(controllerWallet.reattestation_due_at);
  return (
    <span
      className="text-[12px] ck-dim"
      title={`sign again by ${controllerWallet.reattestation_due_at.slice(0, 10)}`}
    >
      sign again{" "}
      {days <= 0 ? "today" : days === 1 ? "in 1 day" : `in ${days} days`}
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
      <p className="ck-mono ck-dim">No agents yet.</p>
      <p className="ck-dim text-[12px] max-w-[40ch]">
        On the next page you pick a handle, approve two wallet signatures, and
        copy the runtime key into your bot. It takes about a minute.
      </p>
      <a href="#/agent/onboard" className="ck-btn ck-btn-bracket ck-pos">
        <Ik name="agent" />
        + add an agent
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
    <div className="flex-1 flex flex-col min-h-0">
      <TopbarCrumb><span className="ck-pos">account</span></TopbarCrumb>
      <main className="flex-1 px-3 py-3 ck-page">
        <SkeletonRows />
      </main>
    </div>
  );
}

function ConfigErrorShell() {
  return (
    <div className="flex-1 flex flex-col min-h-0">
      <TopbarCrumb><span className="ck-neg">account · not configured</span></TopbarCrumb>
      <main className="flex-1 px-3 py-3 ck-page">
        <section className="ck-frame-strong px-4 py-4">
          <p className="ck-mono ck-neg">Sign-in is not configured.</p>
          <p className="ck-dim mt-2 text-[12px]">
            Set <code>VITE_PRIVY_APP_ID</code> in dashboard/.env.local, then build again.
          </p>
        </section>
      </main>
    </div>
  );
}
