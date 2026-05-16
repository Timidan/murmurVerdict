// ─── IntegratePage — Maya onboarding step f (Phase 7d) ─────────────────────
//
// Route: #/account/agent/:slug/integrate. Auth-gated.
//
// Renders the CodeSnippetPanel keyed to the user's freshly-created agent.
// The page exists primarily so ApiKeyMintModal has a destination for its
// DONE button — closing the loop "minted the key → here's working code".
//
// SessionStorage handoff (the only non-obvious bit):
//   ApiKeyMintModal stashes `{ secret, expires_at }` in
//   sessionStorage[`murmur_just_minted:${slug}`] right before navigating
//   here. We read it on mount, render snippets with the live key inline,
//   then clear the entry so a refresh hides the key. The handoff window
//   is 5 minutes — long enough for a slow page transition, short enough
//   that an idle tab can't be hijacked into showing the key.
//
//   We never persist the key beyond this tab session. Closing the tab,
//   refreshing past the 5 min window, or navigating away → snippets fall
//   back to env-var references.

import { useEffect, useMemo, useState } from "react";
import { CompactTopbar } from "../components/compact/Topbar.js";
import { CodeSnippetPanel } from "../components/account/CodeSnippetPanel.js";
import { useAccount } from "../hooks/useAccount.js";

const SESSION_KEY_PREFIX = "murmur_just_minted:";
/** Handoff secrets older than this are treated as stale — see header comment. */
const HANDOFF_TTL_MS = 5 * 60 * 1000;

interface JustMintedEnvelope {
  secret: string;
  expires_at: number;
}

/**
 * Read + immediately clear the handoff envelope for a slug. Returns null
 * when the entry is missing, malformed, or past its expiry. Clearing on
 * read is intentional — refreshing the page should not re-reveal the key.
 *
 * Codex P2 fix — returns the full `{ secret, expires_at }` so the caller
 * can schedule an expiry-driven clear. Earlier this only returned the
 * secret string, so state held the key past `expires_at` if the tab was
 * left idle.
 */
function consumeJustMinted(slug: string): JustMintedEnvelope | null {
  if (typeof window === "undefined" || !window.sessionStorage) return null;
  const key = `${SESSION_KEY_PREFIX}${slug}`;
  const raw = window.sessionStorage.getItem(key);
  if (!raw) return null;
  // Whatever the parse result, the entry is single-use.
  window.sessionStorage.removeItem(key);
  try {
    const env = JSON.parse(raw) as Partial<JustMintedEnvelope>;
    if (
      typeof env?.secret !== "string" ||
      env.secret.length === 0 ||
      typeof env?.expires_at !== "number"
    ) {
      return null;
    }
    if (Date.now() > env.expires_at) return null;
    return { secret: env.secret, expires_at: env.expires_at };
  } catch {
    return null;
  }
}

export interface IntegratePageProps {
  slug: string;
}

export function IntegratePage({ slug }: IntegratePageProps) {
  const account = useAccount();
  // Consume the handoff exactly once. useState initializer is the single
  // safe place to do this; a useEffect would either re-fire under
  // StrictMode (double consume) or land too late (snippet renders with
  // env-ref, then re-renders with the key — flash of stale content).
  const [envelope, setEnvelope] = useState<JustMintedEnvelope | null>(() =>
    consumeJustMinted(slug),
  );

  // Codex P2 fix — the handoff envelope carries `expires_at`; schedule a
  // setTimeout to null out the secret when that wall-clock moment arrives.
  // Earlier we only checked expiry at the initial sessionStorage read, so
  // an idle tab past the TTL kept the secret visible until manual refresh.
  useEffect(() => {
    if (envelope === null) return;
    const remaining = envelope.expires_at - Date.now();
    if (remaining <= 0) {
      setEnvelope(null);
      return;
    }
    const t = setTimeout(() => setEnvelope(null), remaining);
    return () => clearTimeout(t);
  }, [envelope]);

  const apiKey = envelope?.secret ?? null;

  // Resolve the matching agent row from the cached account list so snippets
  // can display the canonical agent_id when needed by tooling around the
  // sealed Fhenix flow.
  const agent = useMemo(
    () => account.agents.find((a) => a.display_slug === slug),
    [account.agents, slug],
  );
  const agentLoading = account.ready && account.isAuthenticated && account.agents.length === 0;
  const agentMissing =
    account.ready &&
    account.isAuthenticated &&
    account.agents.length > 0 &&
    !agent;

  // Auth gate — same posture as AccountPage/AgentNewPage. Bounce when
  // Privy reports a stable signed-out state.
  useEffect(() => {
    if (!account.ready) return;
    if (account.isAuthenticated) return;
    const next = encodeURIComponent(`/account/agent/${slug}/integrate`);
    window.location.hash = `#/account/login?next=${next}`;
  }, [account.ready, account.isAuthenticated, slug]);

  if (!account.configured) {
    return <ConfigErrorShell slug={slug} />;
  }
  if (!account.ready || !account.isAuthenticated) {
    return <LoadingShell slug={slug} />;
  }

  // "Arrived without a key" means the sessionStorage handoff was empty
  // (refresh, direct nav, expired window). We swap copy in that case to
  // tell the user to use their already-saved key from the env var.
  const arrivedWithKey = apiKey !== null;
  const headerAccent = arrivedWithKey ? "ck-pos" : "ck-dim";

  return (
    <div className="compact-shell min-h-dvh flex flex-col">
      <CompactTopbar
        crumb={
          <span>
            <a href="#/account" className="ck-dim hover:ck-pos no-underline">
              account
            </a>
            <span className="ck-dim mx-1">/</span>
            <span className="ck-pos">{slug}</span>
            <span className="ck-dim mx-1">/</span>
            <span className={headerAccent}>integrate</span>
          </span>
        }
      />

      <main className="flex-1 px-3 py-4 flex flex-col gap-3 max-w-[820px] w-full mx-auto">
        <section>
          <h1 className="ck-mono ck-pos text-[14px] font-bold mb-1">
            integrate · {slug}
          </h1>
          {!arrivedWithKey && (
            <p className="ck-mono ck-dim text-[10px] leading-relaxed max-w-[60ch]">
              paste this into your agent. replace the placeholder api key
              with the one you minted — we only show plaintext keys once at
              mint time, never again.
            </p>
          )}
          {arrivedWithKey && (
            <p
              className="ck-mono text-[10px] leading-relaxed max-w-[60ch]"
              style={{ color: "var(--color-accent)" }}
            >
              ⚠ this view shows your key inline for ~5 minutes. copy what you
              need now; refresh hides it permanently.
            </p>
          )}
        </section>

        {agent ? (
          <CodeSnippetPanel
            agentSlug={slug}
            apiKey={apiKey ?? undefined}
          />
        ) : agentMissing ? (
          <section className="ck-frame-strong px-4 py-4">
            <p className="ck-mono ck-neg">agent {slug} not found in your account.</p>
            <p className="ck-mono ck-dim text-[10px] mt-2">
              the daemon may not have hydrated yet — try a refresh, or
              {" "}
              <a href="#/account" className="ck-pos no-underline">return to account</a>.
            </p>
          </section>
        ) : (
          <section className="ck-frame px-4 py-4">
            <p className="ck-mono ck-dim">resolving agent id…</p>
            <p className="ck-mono ck-dim text-[10px] mt-2">
              snippets render once your account agent is available.
            </p>
            {agentLoading && (
              <p className="ck-mono ck-dim text-[10px] mt-1">
                fetching /v1/account/agents…
              </p>
            )}
          </section>
        )}

        <section className="ck-frame">
          <div className="ck-header">
            <span className="ck-label ck-pos">next steps</span>
          </div>
          <ul className="divide-y divide-[var(--color-border)]">
            <li>
              <a
                href={`#/agents/${encodeURIComponent(slug)}`}
                className="grid grid-cols-[1fr_auto] items-center gap-3 px-3 py-2 ck-mono hover:bg-[white]/[0.03] no-underline"
              >
                <span className="ck-pos">view my agent</span>
                <span className="ck-dim text-[10px]">
                  [ agent profile → ]
                </span>
              </a>
            </li>
            <li>
              <a
                href={`#/account/agent/${encodeURIComponent(slug)}/keys`}
                className="grid grid-cols-[1fr_auto] items-center gap-3 px-3 py-2 ck-mono hover:bg-[white]/[0.03] no-underline"
              >
                <span className="ck-pos">manage api keys</span>
                <span className="ck-dim text-[10px]">[ rotate / mint → ]</span>
              </a>
            </li>
            <li>
              <a
                href="/v1/openapi.json"
                target="_blank"
                rel="noreferrer"
                className="grid grid-cols-[1fr_auto] items-center gap-3 px-3 py-2 ck-mono hover:bg-[white]/[0.03] no-underline"
              >
                <span className="ck-pos">full api reference</span>
                <span className="ck-dim text-[10px]">[ more docs → ]</span>
              </a>
            </li>
          </ul>
        </section>
      </main>
    </div>
  );
}

/**
 * Public helper — modules that want to stash the just-minted secret for
 * IntegratePage to pick up. Kept here (rather than ad-hoc inline in the
 * modal) so the storage shape is owned by one file.
 */
export function stashJustMinted(slug: string, secret: string): void {
  if (typeof window === "undefined" || !window.sessionStorage) return;
  const env: JustMintedEnvelope = {
    secret,
    expires_at: Date.now() + HANDOFF_TTL_MS,
  };
  try {
    window.sessionStorage.setItem(
      `${SESSION_KEY_PREFIX}${slug}`,
      JSON.stringify(env),
    );
  } catch {
    // Sessionstorage write can fail (private mode, quota). The page
    // gracefully degrades to the env-var path — log at debug so we
    // notice in dev but don't surface an error toast.
    if (typeof console !== "undefined") {
      console.debug("[integrate] could not stash just-minted secret");
    }
  }
}

function LoadingShell({ slug }: { slug: string }) {
  return (
    <div className="compact-shell min-h-dvh flex flex-col">
      <CompactTopbar
        crumb={
          <span>
            <span className="ck-dim">account</span>
            <span className="ck-dim mx-1">/</span>
            <span className="ck-pos">{slug}</span>
            <span className="ck-dim mx-1">/</span>
            <span className="ck-dim">integrate</span>
          </span>
        }
      />
      <main className="flex-1 px-3 py-3 max-w-[820px] w-full mx-auto">
        <div className="ck-frame px-4 py-6">
          <p className="ck-mono ck-dim">loading…</p>
        </div>
      </main>
    </div>
  );
}

function ConfigErrorShell({ slug }: { slug: string }) {
  return (
    <div className="compact-shell min-h-dvh flex flex-col">
      <CompactTopbar
        crumb={
          <span className="ck-neg">
            {slug} · integrate · unconfigured
          </span>
        }
      />
      <main className="flex-1 px-3 py-3 max-w-[820px] w-full mx-auto">
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
