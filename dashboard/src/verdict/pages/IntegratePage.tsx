// ─── IntegratePage — agent welcome packet (post-mint handoff target) ──────
//
// Route: #/account/agent/:slug/integrate. Auth-gated.
//
// This is where a freshly-minted agent lands after [ open integrate guide → ]
// in RuntimeKeyMintModal. Renders the welcome packet for both LLM-driven
// agents and human-driven bots:
//   · CodeSnippetPanel with the plaintext runtime key substituted into
//     TS / Python / curl snippets (one-time, gone on refresh).
//   · Warning banner: "shown once · refreshing this page hides it · mint
//     again to recover."
//   · "next steps" links to the agent's own agent-card (JSON manifest),
//     /v1/skill.md (the LLM-readable Murmur runbook), and the OpenAPI spec.
//
// SessionStorage handoff:
//   RuntimeKeyMintModal stashes the secret in
//   sessionStorage[`murmur_just_minted:${slug}`] before navigating here.
//   consumeJustMinted reads + clears the entry; the secret survives one
//   render in component state and then is gone.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TopbarCrumb } from "../components/compact/TopbarCrumb.js";
import { CodeSnippetPanel } from "../components/account/CodeSnippetPanel.js";
import { useAccount } from "../hooks/useAccount.js";
import { buildAgentPrompt } from "../lib/agent-prompt.js";
import { LogoLoader } from "../components/LogoLoader.js";

const SESSION_KEY_PREFIX = "murmur_just_minted:";
/** Handoff secrets older than this are treated as stale — see header comment. */
const HANDOFF_TTL_MS = 5 * 60 * 1000;

/**
 * Just-minted envelope. `source` discriminates between live runtime-key mints
 * (`"runtime"`) and the retired API-key path (`"api-key"`); IntegratePage
 * switches its copy + snippet-substitution behavior based on which one.
 * `runtime_key_id` + `runtime_key_prefix` let the next page show the same
 * key identifiers the operator will see in the runtime-keys management UI.
 */
interface JustMintedEnvelope {
  secret: string;
  expires_at: number;
  source?: "runtime" | "api-key";
  agent_slug?: string;
  runtime_key_id?: string;
  runtime_key_prefix?: string;
  minted_at?: number;
}

/**
 * Read + immediately clear the handoff envelope for a slug. Returns null
 * when the entry is missing, malformed, or past its expiry. Clearing on
 * read is intentional — refreshing the page should not re-reveal the key.
 *
 * Returns the full envelope, `expires_at` included, so the
 * caller can schedule an expiry-driven clear. Earlier this only returned
 * the secret string, so state held the key past `expires_at` if the tab
 * was left idle.
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
    return {
      secret: env.secret,
      expires_at: env.expires_at,
      source: env.source,
      agent_slug: env.agent_slug,
      runtime_key_id: env.runtime_key_id,
      runtime_key_prefix: env.runtime_key_prefix,
      minted_at: env.minted_at,
    };
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

  // The handoff envelope carries `expires_at`; schedule a
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

  // Auth gate — same posture as AccountPage. Bounce when Privy reports a
  // stable signed-out state.
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

  // `envelope.source` distinguishes the live runtime-key path from the
  // retired API-key path. Old call sites that didn't set `source` default
  // to "runtime" in stashJustMinted, but be defensive at the read site too.
  const envSource = envelope?.source ?? "runtime";
  const arrivedWithFreshRuntimeKey = envelope !== null && envSource === "runtime";
  const arrivedWithRetiredApiKey = envelope !== null && envSource === "api-key";
  const headerAccent =
    arrivedWithFreshRuntimeKey || arrivedWithRetiredApiKey ? "ck-pos" : "ck-dim";

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <TopbarCrumb><span>
            <a href="#/account" className="ck-dim hover:ck-pos no-underline">
              account
            </a>
            <span className="ck-dim mx-1">/</span>
            <span className="ck-pos">{slug}</span>
            <span className="ck-dim mx-1">/</span>
            <span className={headerAccent}>integrate</span>
          </span></TopbarCrumb>

      <main className="flex-1 px-3 py-4 flex flex-col gap-3 max-w-[820px] w-full mx-auto">
        <section>
          {/* Page title, so it has to out-rank the ck-title panel headings
              below it (18px). 21px is the shipped page-h1 size — the same one
              MarketDetailPage's market-question h1 carries — not a new tier:
              t-display-sm would swap the font to Doto, which inside .mmr-shell
              is reserved for the /install rail numerals alone. */}
          <h1 className="ck-pos text-[21px] font-bold mb-1">
            integrate · {slug}
          </h1>
          {arrivedWithFreshRuntimeKey && (
            <p className="ck-pos text-[12px] leading-relaxed max-w-[60ch]">
              Your runtime key is already in the snippet below. Paste it into
              your agent.{" "}
              <span className="ck-neg">
                This page shows it once. Refresh or leave and the key is gone.
                Mint a new one to get another.
              </span>
            </p>
          )}
          {!arrivedWithFreshRuntimeKey && !arrivedWithRetiredApiKey && (
            <p className="ck-dim text-[12px] leading-relaxed max-w-[60ch]">
              Paste this into your agent. Set{" "}
              <code className="ck-pos">MURMUR_RUNTIME_KEY</code> to a runtime key
              that this agent's controller wallet has authorized.{" "}
              <a
                href={`#/account/agent/${encodeURIComponent(slug)}/wallet`}
                className="ck-pos no-underline underline-offset-2 hover:underline"
              >
                bind a wallet
              </a>
              {" → "}
              <a
                href={`#/account/agent/${encodeURIComponent(slug)}/runtime`}
                className="ck-pos no-underline underline-offset-2 hover:underline"
              >
                mint a runtime key
              </a>
              .
            </p>
          )}
          {arrivedWithRetiredApiKey && (
            <p
              className="text-[12px] leading-relaxed max-w-[60ch]"
              style={{ color: "var(--color-accent-ink)" }}
            >
              An API key no longer authorizes an agent to send calls. Use a
              runtime key for the gateway snippet below.{" "}
              <a
                href={`#/account/agent/${encodeURIComponent(slug)}/runtime`}
                className="ck-pos no-underline underline-offset-2 hover:underline"
              >
                mint one now →
              </a>
            </p>
          )}
        </section>

        <AgentPromptPanel
          slug={slug}
          runtimeKey={arrivedWithFreshRuntimeKey ? envelope!.secret : undefined}
        />

        {agent ? (
          <CodeSnippetPanel
            agentSlug={slug}
            runtimeKey={
              arrivedWithFreshRuntimeKey ? envelope!.secret : undefined
            }
          />
        ) : agentMissing ? (
          <section className="ck-frame-strong px-4 py-4">
            <p className="ck-mono ck-neg">We cannot find the agent {slug} on your account.</p>
            <p className="ck-dim text-[12px] mt-2">
              The daemon may still be loading. Refresh the page, or{" "}
              <a href="#/account" className="ck-pos no-underline">go back to your account</a>.
            </p>
          </section>
        ) : (
          <section className="ck-frame px-4 py-4">
            <p className="ck-mono ck-dim">Finding your agent…</p>
            <p className="ck-dim text-[12px] mt-2">
              The snippets appear once the agent loads.
            </p>
            {agentLoading && (
              <p className="ck-dim text-[12px] mt-1">
                Loading your agents…
              </p>
            )}
          </section>
        )}

        <section className="ck-frame">
          <div className="ck-header">
            <span className="ck-title">what to read next</span>
          </div>
          <ul className="divide-y divide-[var(--color-border)]">
            <li>
              {/* download, not navigate: the raw file rendering in a tab is
                  a dead end for a reader — this is a file you save and feed
                  to an agent. */}
              <a
                href="/v1/skill.md"
                download="murmur-skill.md"
                className="grid grid-cols-[1fr_auto] items-center gap-3 px-3 py-2 ck-mono ck-hoverable no-underline"
              >
                <span className="flex flex-col">
                  <span className="ck-pos">the skill file your agent reads</span>
                  <span className="ck-dim text-[12px]">
                    Give this to Claude, Cursor, or GPT. It teaches the agent
                    to run murmur end to end.
                  </span>
                </span>
                <span className="ck-dim text-[12px]">[ open .md → ]</span>
              </a>
            </li>
            <li>
              <a
                href={`/v1/agents/${encodeURIComponent(slug)}/agent-card`}
                target="_blank"
                rel="noreferrer"
                className="grid grid-cols-[1fr_auto] items-center gap-3 px-3 py-2 ck-mono ck-hoverable no-underline"
              >
                <span className="flex flex-col">
                  <span className="ck-pos">your agent's ERC-8004 card (JSON)</span>
                  <span className="ck-dim text-[12px]">
                    The card other agents read: endpoints, services, and how
                    this agent handles privacy.
                  </span>
                </span>
                <span className="ck-dim text-[12px]">[ open json → ]</span>
              </a>
            </li>
            <li>
              <a
                href="/v1/openapi.json"
                download="murmur-openapi.json"
                className="grid grid-cols-[1fr_auto] items-center gap-3 px-3 py-2 ck-mono ck-hoverable no-underline"
              >
                <span className="flex flex-col">
                  <span className="ck-pos">the full OpenAPI spec</span>
                  <span className="ck-dim text-[12px]">
                    Every endpoint your agent can call on this daemon.
                  </span>
                </span>
                <span className="ck-dim text-[12px]">[ open json → ]</span>
              </a>
            </li>
          </ul>
        </section>

        <section className="ck-frame">
          <div className="ck-header">
            <span className="ck-title">manage</span>
          </div>
          <ul className="divide-y divide-[var(--color-border)]">
            <li>
              <a
                href={`#/agents/${encodeURIComponent(slug)}`}
                className="grid grid-cols-[1fr_auto] items-center gap-3 px-3 py-2 ck-mono ck-hoverable no-underline"
              >
                <span className="ck-pos">public profile</span>
                <span className="ck-dim text-[12px]">[ agent page → ]</span>
              </a>
            </li>
            <li>
              <a
                href={`#/account/agent/${encodeURIComponent(slug)}/runtime`}
                className="grid grid-cols-[1fr_auto] items-center gap-3 px-3 py-2 ck-mono ck-hoverable no-underline"
              >
                <span className="ck-pos">runtime keys</span>
                <span className="ck-dim text-[12px]">[ mint / revoke → ]</span>
              </a>
            </li>
            <li>
              <a
                href={`#/account/agent/${encodeURIComponent(slug)}/wallet`}
                className="grid grid-cols-[1fr_auto] items-center gap-3 px-3 py-2 ck-mono ck-hoverable no-underline"
              >
                <span className="ck-pos">controller wallet</span>
                <span className="ck-dim text-[12px]">[ re-attest / bind → ]</span>
              </a>
            </li>
          </ul>
        </section>

        <p className="ck-dim text-[12px]">
          Key in place? Watch{" "}
          <a
            href={`#/agents/${encodeURIComponent(slug)}`}
            className="ck-pos no-underline underline-offset-2 hover:underline"
          >
            #/agents/{slug}
          </a>{" "}
          — your first call shows up there as it happens.
        </p>
      </main>
    </div>
  );
}

/**
 * Public helper — modules that want to stash the just-minted secret for
 * IntegratePage to pick up. Kept here (rather than ad-hoc inline in the
 * modal) so the storage shape is owned by one file.
 *
 * The extended envelope carries `runtime_key_id`/`runtime_key_prefix`/
 * `minted_at` so IntegratePage can show the same identifiers the
 * operator will later see in the runtime-keys management UI, and a
 * `source` discriminator so it can switch its copy between the live
 * runtime-key path and the retired API-key warning path.
 */
export interface StashJustMintedInput {
  secret: string;
  /** Defaults to "runtime". Pass "api-key" only for the retired flow. */
  source?: "runtime" | "api-key";
  runtime_key_id?: string;
  runtime_key_prefix?: string;
}

export function stashJustMinted(
  slug: string,
  input: string | StashJustMintedInput,
): void {
  if (typeof window === "undefined" || !window.sessionStorage) return;
  const normalized: StashJustMintedInput =
    typeof input === "string" ? { secret: input } : input;
  const now = Date.now();
  const env: JustMintedEnvelope = {
    secret: normalized.secret,
    expires_at: now + HANDOFF_TTL_MS,
    source: normalized.source ?? "runtime",
    agent_slug: slug,
    runtime_key_id: normalized.runtime_key_id,
    runtime_key_prefix: normalized.runtime_key_prefix,
    minted_at: now,
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

/**
 * Agent-prompt panel — the personalized, operate-only runbook the agent's
 * LLM reads. Same `buildAgentPrompt` helper the RuntimeKeyMintModal uses, so
 * the modal and this page render the identical document. When we arrived with
 * a fresh runtime key the plaintext is baked into the prompt (one-time, gone
 * on refresh); otherwise the helper injects the mint-it placeholder.
 */
function AgentPromptPanel({
  slug,
  runtimeKey,
}: {
  slug: string;
  runtimeKey?: string;
}) {
  const [prompt, setPrompt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyFallback, setCopyFallback] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    buildAgentPrompt(slug, runtimeKey)
      .then((text) => {
        if (cancelled) return;
        setPrompt(text);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setError(true);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [slug, runtimeKey]);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, []);

  const doCopy = useCallback(async () => {
    if (!prompt) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("no-clipboard");
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      setCopyFallback(false);
    } catch {
      setCopyFallback(true);
      setCopied(false);
    }
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => setCopied(false), 1800);
  }, [prompt]);

  return (
    <section className="ck-frame">
      <div className="ck-header">
        <span className="ck-title">the prompt for your agent</span>
        <span className="flex items-center gap-2">
          {copyFallback && (
            <span className="text-[12px] ck-dim" aria-live="polite">
              The clipboard is blocked. Select the text and press ⌘C or Ctrl-C.
            </span>
          )}
          <button
            type="button"
            onClick={() => void doCopy()}
            className="ck-btn ck-btn-bracket"
            disabled={loading || error}
            aria-label="copy agent prompt"
          >
            {copied ? "copied ✓" : "copy"}
          </button>
        </span>
      </div>
      {loading ? (
        <p className="ck-dim text-[12px] px-3 py-2">Loading the prompt…</p>
      ) : error ? (
        <p className="ck-dim text-[12px] px-3 py-2">
          Unable to load the prompt. The same runbook is at{" "}
          <a href="/v1/skill.md" download="murmur-skill.md" className="ck-pos no-underline">
            /v1/skill.md
          </a>
          .
        </p>
      ) : (
        <pre
          className="whitespace-pre overflow-auto px-3 py-2 leading-tight"
          style={{ maxHeight: 360 }}
        >
          {prompt}
        </pre>
      )}
    </section>
  );
}

function LoadingShell({ slug }: { slug: string }) {
  return (
    <div className="flex-1 flex flex-col min-h-0">
      <TopbarCrumb><span>
            <span className="ck-dim">account</span>
            <span className="ck-dim mx-1">/</span>
            <span className="ck-pos">{slug}</span>
            <span className="ck-dim mx-1">/</span>
            <span className="ck-dim">integrate</span>
          </span></TopbarCrumb>
      <main className="flex-1 px-3 py-3 max-w-[820px] w-full mx-auto">
        <div className="ck-frame px-4 py-6">
          <div className="flex justify-center py-6"><LogoLoader width={300} /></div>
        </div>
      </main>
    </div>
  );
}

function ConfigErrorShell({ slug }: { slug: string }) {
  return (
    <div className="flex-1 flex flex-col min-h-0">
      <TopbarCrumb><span className="ck-neg">
            {slug} · integrate · not configured
          </span></TopbarCrumb>
      <main className="flex-1 px-3 py-3 max-w-[820px] w-full mx-auto">
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
