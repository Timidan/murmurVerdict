// ─── AccountPage — authed dashboard shell at #/account ─────────────────────
// Owned agents plus account-level panels. Agent creation lives at
// #/agent/onboard; per-agent management at #/account/agent/:slug.

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
import type { AccountAgent, AgentKind } from "../api.js";

export function AccountPage() {
  const account = useAccount();

  // Redirect to login when Privy reports a stable "not signed in" state.
  // Wait for `ready` so we don't bounce the user mid-bootstrap.
  useEffect(() => {
    if (!account.ready) return;
    if (account.isAuthenticated) return;
    const next = encodeURIComponent("/account");
    window.location.hash = `#/account/login?next=${next}`;
  }, [account.ready, account.isAuthenticated]);

  // Refetch on every authenticated mount; the bootstrap fetches only once per login.
  useEffect(() => {
    if (account.isAuthenticated) void account.refreshAgents();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account.isAuthenticated]);

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

  // A closed account gets only the terminal screen; every panel would 403.
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

  // Before the list lands, or after a failure, the count is unknown, never zero.
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

      {/* Bento: span sizes encode weight. Single column under md. */}
      <main className="flex-1 px-3 py-3 grid grid-cols-1 md:grid-cols-6 gap-3 content-start ck-page">
        <section className="ck-frame md:col-span-6">
          <div className="ck-header">
            <span className="ck-title ck-title-ik">
              <IkNav name="agent" /> Your agents
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
        {/* Row 2: usually empty or single-value panels, a third of a row each. */}
        <div className="md:col-span-2 flex [&>*]:w-full">
          <LinkedLoginsPanel />
        </div>
        <div className="md:col-span-2 flex [&>*]:w-full">
          <WebhooksPanel agents={account.agents} />
        </div>
        <div className="md:col-span-2 flex [&>*]:w-full">
          <ActivityPanel />
        </div>

        {/* Row 3: purchases gets half a row. */}
        <div className="md:col-span-3 flex [&>*]:w-full">
          <PurchasesPanel agents={account.agents} />
        </div>

        {/* One tile, two rows (mmr-safety drops the child frames). Pause before
            close: the reversible control comes first. */}
        <section className="ck-frame md:col-span-3 mmr-safety">
          <div className="ck-header">
            <span className="ck-title ck-title-ik">
              <Ik name="kill-switch" /> Safety
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
        // Fall back to agent_id when the slug hasn't hydrated yet.
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
 * Re-attestation chip on each agent row: no wallet or overdue (both link to the
 * wallet tab), else a dim countdown.
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
  // Hairline skeleton, no spinner.
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
