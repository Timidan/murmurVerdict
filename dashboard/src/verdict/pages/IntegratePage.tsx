// ─── IntegratePage — agent welcome packet (post-mint handoff target) ──────
// Route: #/account/agent/:slug/integrate. Panes: prompt, code, files, manage.
// The one-shot runtime key arrives via sessionStorage[`murmur_just_minted:${slug}`],
// cleared on read. So panes stay mounted (inactive ones hidden) and the rail is
// local state, not a route: a remount or hash change would lose the key.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { API_BASE } from "../api.js";
import { Ik, type IconName } from "../icons.js";
import { InlineError } from "../components/compact/InlineError.js";
import { TopbarCrumb } from "../components/compact/TopbarCrumb.js";
import { CodeSnippetPanel } from "../components/account/CodeSnippetPanel.js";
import { useAccount } from "../hooks/useAccount.js";
import { buildAgentPrompt } from "../lib/agent-prompt.js";
import { LogoLoader } from "../components/LogoLoader.js";
import { useRuntimeKeyConnection } from "../hooks/useRuntimeKeyConnection.js";
import { connectionAt, unknownConnection } from "../lib/runtime-key-connection.js";
import { RuntimeKeyConnectionStatus } from "../components/account/RuntimeKeyConnectionStatus.js";

const SESSION_KEY_PREFIX = "murmur_just_minted:";
/** Handoff secrets older than this are treated as stale. */
const HANDOFF_TTL_MS = 5 * 60 * 1000;

/** Just-minted envelope. `source` tells a live runtime-key mint from the retired API-key path. */
interface JustMintedEnvelope {
  secret: string;
  expires_at: number;
  source?: "runtime" | "api-key";
  agent_slug?: string;
  runtime_key_id?: string;
  runtime_key_prefix?: string;
  runtime_key_signing_pk?: string;
  minted_at?: number;
}

/**
 * Read and clear the handoff envelope, so a refresh never re-reveals the key.
 * Null when missing, malformed, or expired.
 */
function consumeJustMinted(slug: string): JustMintedEnvelope | null {
  if (typeof window === "undefined") return null;
  // Reading `window.sessionStorage` itself throws when storage is blocked, so
  // the property read sits inside the handler with the rest.
  try {
    const key = `${SESSION_KEY_PREFIX}${slug}`;
    const raw = window.sessionStorage?.getItem(key);
    if (!raw) return null;
    // Whatever the parse result, the entry is single-use.
    window.sessionStorage.removeItem(key);
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
      runtime_key_signing_pk: env.runtime_key_signing_pk,
      minted_at: env.minted_at,
    };
  } catch {
    return null;
  }
}

/** Rail destinations, in the order an integrator needs them. */
type IntegrateSection = "prompt" | "code" | "files" | "manage";

/** One mark per pane, from the shipped set — the rail reads by shape first. */
const SECTION_ICON: Record<IntegrateSection, IconName> = {
  prompt: "agent",
  code: "api",
  files: "skill-file",
  manage: "settings",
};

export interface IntegratePageProps {
  slug: string;
}

export function IntegratePage({ slug }: IntegratePageProps) {
  const account = useAccount();
  // Local, not routed. See the header note on why a hash tab would be wrong.
  const [section, setSection] = useState<IntegrateSection>("prompt");
  // Consume the handoff once, in the initializer: an effect would double-consume
  // under StrictMode or flash stale content first.
  const [envelope, setEnvelope] = useState<JustMintedEnvelope | null>(() =>
    consumeJustMinted(slug),
  );
  const [trackedRuntimeKeyId] = useState(() =>
    envelope?.source !== "api-key" ? envelope?.runtime_key_id : undefined,
  );
  const {
    snapshot: runtimeKeys,
    receivedAtMs: runtimeKeysReceivedAtMs,
    error: runtimeConnectionError,
    clockTick: runtimeConnectionClockTick,
  } = useRuntimeKeyConnection(slug, trackedRuntimeKeyId);

  // Drop the secret when the envelope's `expires_at` passes.
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

  // This slug's row from the cached account list.
  const agent = useMemo(
    () => account.agents.find((a) => a.display_slug === slug),
    [account.agents, slug],
  );
  // `loading` only flips true once the bootstrap effect runs, so a null
  // session with no error is still the first frame, not a settled empty list.
  const agentLoading = account.loading || (!account.session && !account.error);
  const agentMissing = !agentLoading && !account.error && !agent;
  const agentUnavailable = !agentLoading && Boolean(account.error) && !agent;

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

  // A missing `source` means "runtime".
  const envSource = envelope?.source ?? "runtime";
  const arrivedWithFreshRuntimeKey = envelope !== null && envSource === "runtime";
  const arrivedWithRetiredApiKey = envelope !== null && envSource === "api-key";
  const headerAccent =
    arrivedWithFreshRuntimeKey || arrivedWithRetiredApiKey ? "ck-pos" : "ck-dim";

  // injectRuntimeCredentials fills the prompt only when the key, its id and
  // its signing key all arrive; a partial handoff renders a STOP notice
  // instead. So "your key is in the prompt" is claimable only on all three.
  const promptCarriesKey =
    arrivedWithFreshRuntimeKey &&
    Boolean(envelope!.runtime_key_id) &&
    Boolean(envelope!.runtime_key_signing_pk);
  const trackedKey = trackedRuntimeKeyId
    ? runtimeKeys?.keys.find((key) => key.runtime_key_id === trackedRuntimeKeyId)
    : undefined;
  const connection = runtimeConnectionError
    ? unknownConnection(runtimeConnectionError)
    : trackedKey && runtimeKeys
      ? connectionAt(trackedKey.connection, runtimeKeys.served_at, runtimeKeysReceivedAtMs)
      : !trackedRuntimeKeyId && runtimeKeys
        ? connectionAt(runtimeKeys.connection, runtimeKeys.served_at, runtimeKeysReceivedAtMs)
        : unknownConnection("waiting for the newly minted key to appear");
  void runtimeConnectionClockTick;

  const enc = encodeURIComponent(slug);
  const walletHref = `#/account/agent/${enc}/wallet`;
  const runtimeHref = `#/account/agent/${enc}/runtime`;
  const profileHref = `#/agents/${enc}`;

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

      <main className="flex-1 px-3 py-4 flex flex-col gap-3 ck-page">
        <header>
          {/* 21px page-h1, as on MarketDetailPage; t-display-sm would switch to
              Doto, reserved for the /install rail numerals. */}
          <h1 className="ck-pos text-[21px] font-bold mb-1">
            integrate · {slug}
          </h1>
          {/* One line each; detail lives in the controls' title=. */}
          {promptCarriesKey && (
            <p className="ck-pos text-[12px] leading-relaxed max-w-[60ch]">
              Your runtime key is in the prompt.{" "}
              <span className="ck-neg">This page shows it once.</span>
            </p>
          )}
          {!promptCarriesKey && !arrivedWithRetiredApiKey && (
            <p className="ck-dim text-[12px] leading-relaxed max-w-[60ch]">
              Set <code className="ck-pos">MURMUR_RUNTIME_KEY</code> in your
              agent's environment.
            </p>
          )}
          {!arrivedWithRetiredApiKey && (
            <p className="mt-2">
              <RuntimeKeyConnectionStatus connection={connection} />
              {trackedRuntimeKeyId && (
                <span className="ck-dim text-[12px]"> · this newly minted key</span>
              )}
            </p>
          )}
          {arrivedWithRetiredApiKey && (
            <p
              className="text-[12px] leading-relaxed max-w-[60ch]"
              style={{ color: "var(--color-accent-ink)" }}
            >
              The gateway no longer accepts an API key.
            </p>
          )}
          {!promptCarriesKey && (
            <span className="flex flex-wrap items-center gap-2 mt-2">
              <a
                href={walletHref}
                className="ck-btn ck-btn-bracket"
                title="an agent needs a bound controller wallet before it can hold a runtime key"
              >
                bind a wallet
              </a>
              <a
                href={runtimeHref}
                className="ck-btn ck-btn-bracket ck-pos"
                title="a runtime key is the only credential the gateway accepts. Your controller wallet signs the authorization for it."
              >
                mint a runtime key
              </a>
            </span>
          )}
        </header>

        {/* Rail + panes: local state, not a route. */}
        <div className="ck-sidetabs ck-sidetabs--wide">
          <div
            className="ck-sidetab-rail"
            role="group"
            aria-label="integrate sections"
          >
            <RailTab
              id="prompt"
              current={section}
              onPick={setSection}
              note={promptCarriesKey ? "holds the key" : null}
            >
              prompt
            </RailTab>
            <RailTab id="code" current={section} onPick={setSection}>
              code
            </RailTab>
            <RailTab id="files" current={section} onPick={setSection}>
              files
            </RailTab>
            <RailTab id="manage" current={section} onPick={setSection}>
              manage
            </RailTab>
          </div>

          <div className="ck-sidetab-body ck-sidetab-body--fixed">
            <Pane active={section === "prompt"}>
              <AgentPromptPanel
                slug={slug}
                runtimeKey={arrivedWithFreshRuntimeKey ? envelope!.secret : undefined}
                runtimeKeyId={
                  arrivedWithFreshRuntimeKey ? envelope!.runtime_key_id : undefined
                }
                signingPrivateKey={
                  arrivedWithFreshRuntimeKey ? envelope!.runtime_key_signing_pk : undefined
                }
              />
            </Pane>

            <Pane active={section === "code"}>
              {agent ? (
                <CodeSnippetPanel agentSlug={slug} />
              ) : agentUnavailable ? (
                <section className="ck-frame-strong px-4 py-4">
                  <InlineError
                    error="We could not load your agents."
                    className="text-[12px]"
                  />
                  <p className="ck-dim text-[12px] mt-2">
                    Refresh the page, or{" "}
                    <a href="#/account" className="ck-pos no-underline">go back to your account</a>.
                  </p>
                </section>
              ) : agentMissing ? (
                <section className="ck-frame-strong px-4 py-4">
                  <p className="ck-mono ck-neg">We cannot find the agent {slug} on your account.</p>
                  <p className="ck-dim text-[12px] mt-2">
                    <a href="#/account" className="ck-pos no-underline">Go back to your account</a>{" "}
                    to pick another agent.
                  </p>
                </section>
              ) : (
                <section className="ck-frame px-4 py-4">
                  <p className="ck-mono ck-dim">Finding your agent…</p>
                  <p className="ck-dim text-[12px] mt-2">
                    The snippets appear once the agent loads.
                  </p>
                </section>
              )}
            </Pane>

            <Pane active={section === "files"}>
              <section className="ck-frame">
                <div className="ck-header">
                  <span className="ck-title">files to read</span>
                </div>
                <ul className="divide-y divide-[var(--color-border)]">
                  <li>
                    {/* download, not navigate: it's a file to feed an agent. */}
                    <a
                      href={`${API_BASE}/v1/skill.md`}
                      download="murmur-skill.md"
                      title="the runbook is written for an LLM to follow, not for a person to read in a tab"
                      className="grid grid-cols-[1fr_auto] items-center gap-3 px-3 py-2 ck-mono ck-hoverable no-underline"
                    >
                      <span className="flex flex-col">
                        <span className="ck-pos">the skill file your agent reads</span>
                        <span className="ck-dim text-[12px]">
                          Give this to Claude, Cursor, or GPT.
                        </span>
                      </span>
                      <span className="ck-dim text-[12px]">[ open .md → ]</span>
                    </a>
                  </li>
                  <li>
                    <a
                      href={`${API_BASE}/v1/agents/${enc}/agent-card`}
                      target="_blank"
                      rel="noreferrer"
                      title="endpoints, services, and how this agent handles privacy"
                      className="grid grid-cols-[1fr_auto] items-center gap-3 px-3 py-2 ck-mono ck-hoverable no-underline"
                    >
                      <span className="flex flex-col">
                        <span className="ck-pos">your agent's ERC-8004 card (JSON)</span>
                        <span className="ck-dim text-[12px]">
                          The card other agents read.
                        </span>
                      </span>
                      <span className="ck-dim text-[12px]">[ open json → ]</span>
                    </a>
                  </li>
                  <li>
                    <a
                      href={`${API_BASE}/v1/openapi.json`}
                      download="murmur-openapi.json"
                      title="every endpoint your agent can call on this daemon"
                      className="grid grid-cols-[1fr_auto] items-center gap-3 px-3 py-2 ck-mono ck-hoverable no-underline"
                    >
                      <span className="flex flex-col">
                        <span className="ck-pos">the full OpenAPI spec</span>
                        <span className="ck-dim text-[12px]">
                          Machine-readable, for a client generator.
                        </span>
                      </span>
                      <span className="ck-dim text-[12px]">[ open json → ]</span>
                    </a>
                  </li>
                </ul>
              </section>
            </Pane>

            <Pane active={section === "manage"}>
              <section className="ck-frame">
                <div className="ck-header">
                  <span className="ck-title">manage</span>
                </div>
                <ul className="divide-y divide-[var(--color-border)]">
                  <li>
                    <a
                      href={profileHref}
                      title="your first call appears here as it happens"
                      className="grid grid-cols-[1fr_auto] items-center gap-3 px-3 py-2 ck-mono ck-hoverable no-underline"
                    >
                      <span className="ck-pos">public profile</span>
                      <span className="ck-dim text-[12px]">[ agent page → ]</span>
                    </a>
                  </li>
                  <li>
                    <a
                      href={runtimeHref}
                      title="mint a new runtime key here if you lose the one this page showed you"
                      className="grid grid-cols-[1fr_auto] items-center gap-3 px-3 py-2 ck-mono ck-hoverable no-underline"
                    >
                      <span className="ck-pos">runtime keys</span>
                      <span className="ck-dim text-[12px]">[ mint / revoke → ]</span>
                    </a>
                  </li>
                  <li>
                    <a
                      href={walletHref}
                      title="the wallet that signs for this agent. Sign again before it lapses, or its runtime keys stop working."
                      className="grid grid-cols-[1fr_auto] items-center gap-3 px-3 py-2 ck-mono ck-hoverable no-underline"
                    >
                      <span className="ck-pos">controller wallet</span>
                      <span className="ck-dim text-[12px]">[ re-attest / bind → ]</span>
                    </a>
                  </li>
                </ul>
              </section>
            </Pane>
          </div>
        </div>

        <p className="ck-dim text-[12px]">
          Watch{" "}
          <a
            href={profileHref}
            title="your first call appears here as it happens"
            className="ck-pos no-underline underline-offset-2 hover:underline"
          >
            #/agents/{slug}
          </a>{" "}
          for the first call.
        </p>
      </main>
    </div>
  );
}

/** One rail cell. A button, not a link: the selected pane is component state. */
function RailTab({
  id,
  current,
  onPick,
  note,
  children,
}: {
  id: IntegrateSection;
  current: IntegrateSection;
  onPick: (next: IntegrateSection) => void;
  /** The pane's own state, when the page already holds it. Never a guess. */
  note?: string | null;
  children: string;
}) {
  const on = current === id;
  return (
    <button
      type="button"
      onClick={() => onPick(id)}
      aria-pressed={on}
      className={
        "ck-sidetab flex items-center gap-2 " +
        (on ? "ck-tab-active" : "ck-dim ck-hoverable")
      }
    >
      <Ik name={SECTION_ICON[id]} />
      <span className="flex flex-col min-w-0 text-left">
        <span>{children}</span>
        {note && <span className="ck-dim text-[12px]">{note}</span>}
      </span>
    </button>
  );
}

/**
 * A pane the rail switches between. Inactive ones stay mounted but leave
 * layout and the accessibility tree, so the prompt fetch that carries the
 * one-shot runtime key runs once for the life of the page.
 */
function Pane({
  active,
  children,
}: {
  active: boolean;
  children: React.ReactNode;
}) {
  return <div className={active ? "flex flex-col gap-3" : "hidden"}>{children}</div>;
}

/** Stash a just-minted secret for IntegratePage; this file owns the storage shape. */
export interface StashJustMintedInput {
  secret: string;
  /** Defaults to "runtime". Pass "api-key" only for the retired flow. */
  source?: "runtime" | "api-key";
  runtime_key_id?: string;
  runtime_key_prefix?: string;
  runtime_key_signing_pk?: string;
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
    runtime_key_signing_pk: normalized.runtime_key_signing_pk,
    minted_at: now,
  };
  try {
    window.sessionStorage.setItem(
      `${SESSION_KEY_PREFIX}${slug}`,
      JSON.stringify(env),
    );
  } catch {
    // Write can fail (private mode, quota); the page falls back to the env-var path.
    if (typeof console !== "undefined") {
      console.debug("[integrate] could not stash just-minted secret");
    }
  }
}

/**
 * The runbook the agent's LLM reads, from the same `buildAgentPrompt` as
 * RuntimeKeyMintModal. A fresh runtime key is baked in; otherwise a placeholder.
 */
function AgentPromptPanel({
  slug,
  runtimeKey,
  runtimeKeyId,
  signingPrivateKey,
}: {
  slug: string;
  runtimeKey?: string;
  runtimeKeyId?: string;
  signingPrivateKey?: string;
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
    buildAgentPrompt(slug, { runtimeKey, runtimeKeyId, signingPrivateKey })
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
  }, [slug, runtimeKey, runtimeKeyId, signingPrivateKey]);

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
          {/* The one-shot warning lives in the copy button's title. */}
          <button
            type="button"
            onClick={() => void doCopy()}
            className="ck-btn ck-btn-bracket"
            disabled={loading || error}
            aria-label="copy agent prompt"
            title={
              runtimeKey
                ? "Copy the runbook. Your runtime key is inside it. Refresh this page and the key is gone."
                : "Copy the runbook. Paste it into your agent."
            }
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
          <a
            href={`${API_BASE}/v1/skill.md`}
            download="murmur-skill.md"
            className="ck-pos no-underline"
          >
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
      <main className="flex-1 px-3 py-3 ck-page">
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
