// ─── AgentSettingsPage — per-agent settings shell (Phase 7c) ───────────────
//
// Route: #/account/agent/:slug   (default tab = payout)
//        #/account/agent/:slug/payout
//        #/account/agent/:slug/keys
//
// Auth-gated via AccountShell (Phase 7a). Sub-tabs are HASH-driven, not
// React state, so deep-linking + back/forward navigation work exactly the
// way they do for the rest of the dashboard. The Router owns the `tab`
// param; we just dispatch on it.
//
// Header carries the TierBadge + slug crumb so the user always knows
// which agent they are editing. Body swaps between:
//   · DestinationAddressForm (payout target + cooldown countdown)
//   · ApiKeysPanel (list + rotate + mint)

import { useEffect, useMemo } from "react";
import { CompactTopbar } from "../components/compact/Topbar.js";
import { DestinationAddressForm } from "../components/account/DestinationAddressForm.js";
import { ProviderTermsPanel } from "../components/account/ProviderTermsPanel.js";
import { ApiKeysPanel } from "../components/account/ApiKeysPanel.js";
import { ControllerWalletPanel } from "../components/account/ControllerWalletPanel.js";
import { RuntimeKeysPanel } from "../components/account/RuntimeKeysPanel.js";
import { TierBadge } from "../components/TierBadge.js";
import { useAccount } from "../hooks/useAccount.js";
import type { AgentKind, AccountAgent } from "../api.js";

export type AgentSettingsTab =
  | "payout"
  | "pricing"
  | "wallet"
  | "runtime"
  | "keys";

export interface AgentSettingsPageProps {
  slug: string;
  tab: AgentSettingsTab;
}

export function AgentSettingsPage({ slug, tab }: AgentSettingsPageProps) {
  const account = useAccount();

  // Auth gate — bounce to login with `?next=` preserved so the user
  // lands back here on success.
  useEffect(() => {
    if (!account.ready) return;
    if (account.isAuthenticated) return;
    const next = encodeURIComponent(`/account/agent/${slug}/${tab}`);
    window.location.hash = `#/account/login?next=${next}`;
  }, [account.ready, account.isAuthenticated, slug, tab]);

  // Pick the AccountAgent for this slug from the already-fetched list.
  // The list comes back via /v1/account/agents on /account bootstrap, so
  // landing directly on /payout (e.g. via a bookmark) doesn't trigger
  // a separate round-trip — useAccount.refreshAgents is called on the
  // window load + on every successful PATCH below.
  const agent = useMemo<AccountAgent | null>(
    () => account.agents.find((a) => a.display_slug === slug) ?? null,
    [account.agents, slug],
  );

  if (!account.configured) {
    return <ConfigErrorShell />;
  }
  if (!account.ready || !account.isAuthenticated) {
    return <LoadingShell slug={slug} />;
  }
  // Agents may still be loading on first paint after a hard refresh.
  // Render the chrome immediately and a skeleton body — better than a
  // blank page while the hook flushes its first /v1/account/agents call.
  const agentMissing = !account.loading && !agent;

  return (
    <div className="mmr-shell min-h-dvh flex flex-col">
      <CompactTopbar
        crumb={
          <span>
            <a href="#/account" className="ck-dim hover:ck-pos no-underline">
              account
            </a>
            <span className="ck-dim mx-1">/</span>
            <a
              href={`#/account/agent/${encodeURIComponent(slug)}/payout`}
              className="ck-pos no-underline"
            >
              {slug}
            </a>
          </span>
        }
      />

      <main className="flex-1 px-3 py-4 flex flex-col items-center gap-4">
        {/* ── Agent header ─────────────────────────────────────────── */}
        <header className="w-full max-w-[720px] flex flex-wrap items-center justify-between gap-3 px-1">
          <div className="flex items-center gap-2 min-w-0">
            <span className="ck-mono ck-pos truncate">{slug}</span>
            <TierBadge kind={(agent?.kind as AgentKind) ?? "agent"} />
            <ReattestHeaderChip
              controllerWallet={agent?.controller_wallet ?? null}
              walletTabHref={`#/account/agent/${encodeURIComponent(slug)}/wallet`}
            />
          </div>
          <span className="flex items-center gap-2 flex-wrap">
            <a
              href={`#/account/agent/${encodeURIComponent(slug)}/integrate`}
              className="ck-btn ck-btn-bracket"
              title="integration snippets"
            >
              integrate
            </a>
            <a
              href={`#/agents/${encodeURIComponent(slug)}`}
              className="ck-btn ck-btn-bracket"
              title="public profile"
            >
              view public →
            </a>
          </span>
        </header>

        {/* ── Tab strip — hash-routed, not state-driven ──────────── */}
        <nav
          className="w-full max-w-[720px] flex items-stretch border border-[var(--color-border-vis)]"
          aria-label="agent settings tabs"
        >
          {/* payout is the deep-link default (route.ts) — keep it first so
              the default tab lands leftmost, not at the end of the strip. */}
          <TabLink slug={slug} tab="payout" active={tab === "payout"}>
            payout
          </TabLink>
          <TabLink slug={slug} tab="pricing" active={tab === "pricing"}>
            pricing
          </TabLink>
          <TabLink slug={slug} tab="wallet" active={tab === "wallet"}>
            wallet
          </TabLink>
          <TabLink slug={slug} tab="runtime" active={tab === "runtime"}>
            runtime keys
          </TabLink>
          <TabLink slug={slug} tab="keys" active={tab === "keys"}>
            api keys
          </TabLink>
        </nav>

        {/* ── Body ─────────────────────────────────────────────── */}
        {/* Codex P2 fix — `key={slug}` forces full remount when the user
            navigates from one agent's settings to another's. Without it
            React reuses the same component instance and the previous
            agent's loaded keys / form input / confirm-id can leak under
            the new header. On the keys tab the leak is destructive: a
            stale confirm-id could rotate the wrong agent's key. */}
        {agentMissing ? (
          <NotFoundShell slug={slug} />
        ) : tab === "payout" ? (
          <DestinationAddressForm
            key={slug}
            slug={slug}
            currentAddress={agent?.destination_address ?? null}
            updatedAt={agent?.destination_address_updated_at ?? null}
            onSaved={() => void account.refreshAgents()}
          />
        ) : tab === "pricing" ? (
          <ProviderTermsPanel key={slug} slug={slug} />
        ) : tab === "wallet" ? (
          <ControllerWalletPanel
            key={slug}
            slug={slug}
            agent={agent}
            onAgentChanged={account.refreshAgents}
          />
        ) : tab === "runtime" ? (
          <RuntimeKeysPanel key={slug} slug={slug} agent={agent} />
        ) : (
          <ApiKeysPanel key={slug} slug={slug} />
        )}
      </main>
    </div>
  );
}

/**
 * Compact re-attestation chip rendered next to the agent slug in the
 * settings header. Mirrors the chip on AccountPage rows; the wallet-tab
 * link doubles as a "re-attest now" affordance when overdue.
 */
function ReattestHeaderChip({
  controllerWallet,
  walletTabHref,
}: {
  controllerWallet: AccountAgent["controller_wallet"];
  walletTabHref: string;
}) {
  if (!controllerWallet) {
    return (
      <a
        href={walletTabHref}
        className="text-[12px] ck-neg no-underline hover:underline"
        title="bind a controller wallet to mint runtime keys"
      >
        × bind wallet
      </a>
    );
  }
  if (controllerWallet.reattestation_overdue) {
    return (
      <a
        href={walletTabHref}
        className="text-[12px] ck-neg no-underline hover:underline"
        title="re-attestation overdue; runtime keys won't authenticate"
      >
        × re-attest now →
      </a>
    );
  }
  const due = Date.parse(controllerWallet.reattestation_due_at);
  const days = Number.isFinite(due)
    ? Math.max(0, Math.ceil((due - Date.now()) / (24 * 60 * 60 * 1000)))
    : 0;
  return (
    <span
      className="text-[12px] ck-dim"
      title={`re-attest by ${controllerWallet.reattestation_due_at.slice(0, 10)}`}
    >
      re-attest {days <= 0 ? "today" : days === 1 ? "in 1d" : `in ${days}d`}
    </span>
  );
}

function TabLink({
  slug,
  tab,
  active,
  children,
}: {
  slug: string;
  tab: AgentSettingsTab;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <a
      href={`#/account/agent/${encodeURIComponent(slug)}/${tab}`}
      className={
        "flex-1 text-center px-3 py-2 ck-label no-underline border-r border-[var(--color-border)] last:border-r-0 " +
        (active
          ? "ck-pos bg-[var(--color-surface)]"
          : "ck-dim hover:ck-pos")
      }
      aria-current={active ? "page" : undefined}
    >
      {children}
    </a>
  );
}

function NotFoundShell({ slug }: { slug: string }) {
  return (
    <section className="ck-frame-strong w-full max-w-[560px] px-4 py-4">
      <p
        className="ck-mono"
        style={{ color: "var(--color-accent-ink)" }}
      >
        × agent <span className="ck-pos">{slug}</span> not found on this account.
      </p>
      <p className="ck-dim mt-2 text-[12px]">
        either you don&apos;t own this slug or the agents list hasn&apos;t
        loaded yet. <a href="#/account" className="underline">return to account</a>.
      </p>
    </section>
  );
}

function LoadingShell({ slug }: { slug: string }) {
  return (
    <div className="mmr-shell min-h-dvh flex flex-col">
      <CompactTopbar crumb={<span className="ck-pos">{slug}</span>} />
      <main className="flex-1 px-3 py-3 max-w-[560px] w-full mx-auto">
        <div className="ck-frame px-4 py-6">
          <p className="ck-mono ck-dim">loading…</p>
        </div>
      </main>
    </div>
  );
}

function ConfigErrorShell() {
  return (
    <div className="mmr-shell min-h-dvh flex flex-col">
      <CompactTopbar crumb={<span className="ck-neg">settings · unconfigured</span>} />
      <main className="flex-1 px-3 py-3 max-w-[560px] w-full mx-auto">
        <section className="ck-frame-strong px-4 py-4">
          <p className="ck-mono ck-neg">privy not configured.</p>
          <p className="ck-dim mt-2 text-[12px]">
            set <code>VITE_PRIVY_APP_ID</code> in dashboard/.env.local and rebuild.
          </p>
        </section>
      </main>
    </div>
  );
}
