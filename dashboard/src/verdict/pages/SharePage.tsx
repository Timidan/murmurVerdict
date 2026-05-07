import { useEffect, useState } from "react";
import { verdictApi, type AgentProfile } from "../api.js";
import { Topbar } from "../components/Topbar.js";
import { PillButton } from "../components/PillButton.js";

/**
 * /#/share/:slug — the viral surface.
 *
 * Anatomy:
 *   - Live OG card (rendered server-side by /v1/og/<slug>.svg)
 *   - One-tap "tweet this" / "post on Discord" / "copy link" actions
 *   - Copy-paste embed (markdown / HTML)
 *
 * No agent-internal data shown. Pure share tools. Designed so a follower
 * can land here, hit one button, and broadcast the verdict in 5 seconds.
 */
export function SharePage({ slug }: { slug: string }) {
  const base = verdictApi.apiUrl.replace(/\/$/, "");
  const ogUrl = `${base}/v1/og/${slug}.svg`;
  const badgeUrl = `${base}/v1/badge/${slug}.svg`;
  const profileUrl = `${typeof window !== "undefined" ? window.location.origin : ""}/#/agents/${slug}`;

  const [agent, setAgent] = useState<AgentProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  // ?ref=<sender> from outreach DMs. Hash-routed so we read the
  // hash query string (after the second '?'), falling back to the
  // window's main query string when the URL is plain.
  const ref = parseRef();

  useEffect(() => {
    let cancel = false;
    verdictApi
      .agent(slug)
      .then((a) => {
        if (!cancel) setAgent(a);
      })
      .catch((e) => {
        if (!cancel) setError(e.message);
      });
    return () => {
      cancel = true;
    };
  }, [slug]);

  // Outreach attribution: when a visitor lands here from an outreach DM
  // (?ref=<sender>) fire a single click ping AND sticky the (ref, slug)
  // pair to localStorage. ClaimPage reads it on successful finalize so
  // the conversion gets credited back to the original sender even after
  // they navigate away from /share.
  useEffect(() => {
    if (!ref) return;
    const apiBase = verdictApi.apiUrl.replace(/\/$/, "");
    fetch(`${apiBase}/v1/refs/${encodeURIComponent(ref)}/click`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_slug: slug }),
      keepalive: true,
    }).catch(() => {});
    try {
      window.localStorage.setItem(
        "murmur-verdict.ref-attribution.v1",
        JSON.stringify({ ref, agent_slug: slug, at: Date.now() }),
      );
    } catch {
      // storage disabled / quota — silent fail
    }
  }, [ref, slug]);

  const tweetBody =
    agent === null
      ? `🪧 ${slug} on Murmur Verdict — the public referee for autonomous market agents. ${profileUrl}`
      : `🪧 ${agent.display_name} on Murmur Verdict — public referee for autonomous market agents. Score updates live. ${profileUrl}`;
  const tweetUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(tweetBody)}`;
  const telegramUrl = `https://t.me/share/url?url=${encodeURIComponent(profileUrl)}&text=${encodeURIComponent(tweetBody)}`;

  const markdownEmbed = `[![${agent?.display_name ?? slug} on Murmur](${badgeUrl})](${profileUrl})`;
  const htmlEmbed = `<a href="${profileUrl}"><img src="${badgeUrl}" alt="${agent?.display_name ?? slug} on Murmur" /></a>`;

  const copy = (key: string, value: string) => {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(key);
      setTimeout(() => setCopied(null), 1500);
    });
  };

  return (
    <div className="min-h-dvh flex flex-col bg-[var(--color-bg)] text-[var(--color-primary)]">
      <Topbar
        crumb={
          <span>
            share <span className="text-[var(--color-border-vis)] mx-2">/</span>
            <strong className="text-[var(--color-display)] font-bold">{slug}</strong>
          </span>
        }
      />

      <main className="flex-1 max-w-[1024px] w-full mx-auto px-6 md:px-10 py-12">
        {error && (
          <div className="border border-[var(--color-accent)] px-6 py-8 t-body-sm text-[var(--color-accent)] mb-10">
            [ERROR] {error}
          </div>
        )}

        <header className="mb-10">
          <p className="t-label text-[var(--color-secondary)] mb-3">
            {ref ? `share · referred by @${ref}` : "share"}
          </p>
          <h1 className="t-heading max-w-[40ch]">
            {agent ? agent.display_name : slug}{" "}
            <span className="text-[var(--color-display)]">on Murmur Verdict</span>.
          </h1>
          {ref && (
            <p className="t-body mt-3 max-w-[60ch] text-[var(--color-secondary)]">
              <span className="text-[var(--color-display)]">@{ref}</span> shared this
              verdict with you. Score updates live; receipts are independently verifiable.
            </p>
          )}
        </header>

        {/* OG PREVIEW — full bleed */}
        <section className="mb-12">
          <p className="t-label text-[var(--color-secondary)] mb-3">social card · 1200×630</p>
          <div className="border border-[var(--color-border)]">
            <img
              src={ogUrl}
              alt={`${agent?.display_name ?? slug} verdict card`}
              className="block w-full"
              loading="eager"
            />
          </div>
          <p className="t-meta text-[var(--color-disabled)] mt-2">
            <a href={ogUrl} className="hover:text-[var(--color-display)]" target="_blank" rel="noreferrer">
              {ogUrl}
            </a>
          </p>
        </section>

        {/* SHARE ACTIONS */}
        <section className="mb-12 flex flex-wrap items-center gap-3">
          <a href={tweetUrl} target="_blank" rel="noreferrer" className="contents">
            <PillButton variant="primary">POST ON X</PillButton>
          </a>
          <a href={telegramUrl} target="_blank" rel="noreferrer" className="contents">
            <PillButton variant="secondary">TELEGRAM</PillButton>
          </a>
          <PillButton variant="secondary" onClick={() => copy("link", profileUrl)}>
            {copied === "link" ? "[ COPIED ]" : "COPY LINK"}
          </PillButton>
        </section>

        {/* EMBED SNIPPETS */}
        <section className="mb-12 flex flex-col gap-6">
          <Snippet
            label="MARKDOWN · README / GITHUB"
            value={markdownEmbed}
            copied={copied === "markdown"}
            onCopy={() => copy("markdown", markdownEmbed)}
          />
          <Snippet
            label="HTML · NOTION / DISCORD / WEB"
            value={htmlEmbed}
            copied={copied === "html"}
            onCopy={() => copy("html", htmlEmbed)}
          />
        </section>

        <footer className="t-meta text-[var(--color-disabled)] flex flex-wrap gap-x-6 gap-y-2">
          <a href={`#/agents/${slug}`} className="hover:text-[var(--color-display)]">agent profile</a>
          <a href="#/leaderboard" className="hover:text-[var(--color-display)]">leaderboard</a>
          <a href="#/launch" className="hover:text-[var(--color-display)]">install murmur</a>
        </footer>
      </main>
    </div>
  );
}

/**
 * Extract `?ref=<handle>` from either the hash-route's own query string
 * (e.g. `#/share/cred?ref=timidan`) or the page-level query (`?ref=…`).
 * Sanitised to alphanumerics + dash/underscore so injected refs can't carry
 * markup into the page.
 */
function parseRef(): string | null {
  if (typeof window === "undefined") return null;
  const fromHash = (() => {
    const hash = window.location.hash || "";
    const idx = hash.indexOf("?");
    if (idx < 0) return null;
    return new URLSearchParams(hash.slice(idx + 1)).get("ref");
  })();
  const fromPage = new URLSearchParams(window.location.search).get("ref");
  const raw = fromHash ?? fromPage;
  if (!raw) return null;
  const safe = raw.replace(/[^a-zA-Z0-9_\-.]/g, "").slice(0, 32);
  return safe.length === 0 ? null : safe;
}

function Snippet({
  label,
  value,
  copied,
  onCopy,
}: {
  label: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <span className="t-label text-[var(--color-secondary)]">{label}</span>
        <button
          onClick={onCopy}
          className="t-button text-[var(--color-secondary)] hover:text-[var(--color-display)] press-feedback"
        >
          {copied ? "[ COPIED ]" : "COPY"}
        </button>
      </div>
      <pre className="bg-[var(--color-surface)] border border-[var(--color-border)] px-4 py-3 t-data text-[var(--color-display)] whitespace-pre-wrap break-all">
        {value}
      </pre>
    </div>
  );
}
