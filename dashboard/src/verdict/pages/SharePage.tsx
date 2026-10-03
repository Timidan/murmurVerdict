import { useEffect, useState } from "react";
import { verdictApi, API_BASE, type AgentProfile } from "../api.js";
import { TopbarCrumb } from "../components/compact/TopbarCrumb.js";
import { Panel } from "../components/compact/Panel.js";
import { InlineError } from "../components/compact/InlineError.js";

/**
 * /#/share/:slug: share tools for an agent. OG card preview (/v1/og/<slug>.svg),
 * post on X / Telegram / copy link, and markdown and HTML badge embeds.
 */
export function SharePage({ slug }: { slug: string }) {
  const base = API_BASE;
  const ogUrl = `${base}/v1/og/${slug}.svg`;
  const badgeUrl = `${base}/v1/badge/${slug}.svg`;
  // Share the daemon's `/share/:slug` externally: scrapers ignore the hash, and
  // it serves per-agent OG tags then redirects browsers to the agent's profile.
  const shareUrl = `${base}/share/${slug}`;

  const [agent, setAgent] = useState<AgentProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    let cancel = false;
    // Reset first, or a new slug's embeds carry the previous agent's name.
    setAgent(null);
    setError(null);
    setCopied(null);
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

  const tweetBody =
    agent === null
      ? `${slug} on Murmur Verdict — the public referee for autonomous market agents. ${shareUrl}`
      : `${agent.display_name} on Murmur Verdict — public referee for autonomous market agents. Score updates live. ${shareUrl}`;
  const tweetUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(tweetBody)}`;
  const telegramUrl = `https://t.me/share/url?url=${encodeURIComponent(shareUrl)}&text=${encodeURIComponent(tweetBody)}`;

  const alt = agent?.display_name ?? slug;
  const markdownEmbed = `[![${escapeMarkdown(alt)} on Murmur](${badgeUrl})](${shareUrl})`;
  const htmlEmbed = `<a href="${shareUrl}"><img src="${badgeUrl}" alt="${escapeHtmlAttr(alt)} on Murmur" /></a>`;

  // The clipboard can reject (async) or be missing (sync); either way the
  // button says to select the text by hand.
  const copy = (key: string, value: string) => {
    const done = (ok: boolean) => {
      setCopied(ok ? key : `${key}:failed`);
      setTimeout(() => setCopied(null), 2500);
    };
    try {
      void navigator.clipboard.writeText(value).then(
        () => done(true),
        () => done(false),
      );
    } catch {
      done(false);
    }
  };
  const copyLabel = (key: string, idle: string) =>
    copied === key ? "copied" : copied === `${key}:failed` ? "select it instead" : idle;

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <TopbarCrumb><span>
            share <span className="ck-dim mx-1">/</span>
            <span className="ck-pos">{slug}</span>
          </span></TopbarCrumb>

      {/* HERO STRIP ─────────────────────────────────── */}
      <section className="border-b border-[var(--color-border)] px-3 py-3 flex flex-col gap-1">
        <span className="ck-label ck-dim">
          Share
        </span>
        <span className="ck-mono">
          {agent ? agent.display_name : slug}{" "}
          <span className="ck-pos">on Murmur Verdict</span>.
        </span>
      </section>

      <main className="flex-1 min-h-0 overflow-y-auto ck-scroll flex flex-col gap-3 p-3">
        {error && <InlineError error={error} className="px-3 py-2 ck-mono" />}

        {/* OG PREVIEW — full bleed */}
        <Panel title="Social card" meta="1200×630">
          <div className="p-2 flex flex-col gap-1">
            <div className="ck-frame">
              <img
                src={ogUrl}
                alt={`${agent?.display_name ?? slug} verdict card`}
                className="block w-full"
                loading="eager"
              />
            </div>
          </div>
        </Panel>

        {/* SHARE ACTIONS */}
        <Panel title="Share it">
          <div className="p-3 flex flex-wrap items-center gap-4">
            <a
              href={tweetUrl}
              target="_blank"
              rel="noreferrer"
              className="ck-btn ck-btn-bracket ck-pos no-underline"
            >
              post on x
            </a>
            <a
              href={telegramUrl}
              target="_blank"
              rel="noreferrer"
              className="ck-btn ck-btn-bracket no-underline"
            >
              telegram
            </a>
            <button
              onClick={() => copy("link", shareUrl)}
              className="ck-btn ck-btn-bracket"
            >
              {copyLabel("link", "copy link")}
            </button>
          </div>
          {/* The link, selectable: the fallback when the clipboard is refused. */}
          <div className="px-3 pb-3 ck-mono ck-dim break-all">{shareUrl}</div>
        </Panel>

        {/* EMBED SNIPPETS */}
        <Snippet
          title="Markdown — for a readme or GitHub"
          value={markdownEmbed}
          label={copyLabel("markdown", "copy")}
          onCopy={() => copy("markdown", markdownEmbed)}
        />
        <Snippet
          title="HTML — for Notion, Discord, or a web page"
          value={htmlEmbed}
          label={copyLabel("html", "copy")}
          onCopy={() => copy("html", htmlEmbed)}
        />

        <footer className="px-1 py-2 ck-mono ck-dim flex flex-wrap gap-x-6 gap-y-2">
          <a
            href={`#/agents/${slug}`}
            className="no-underline hover:text-[var(--color-display)]"
          >
            agent profile
          </a>
          <a
            href="#/leaderboard"
            className="no-underline hover:text-[var(--color-display)]"
          >
            leaderboard
          </a>
          <a
            href="#/install"
            className="no-underline hover:text-[var(--color-display)]"
          >
            install murmur
          </a>
        </footer>
      </main>
    </div>
  );
}

/** Display names are arbitrary text: escape them for markdown and HTML alt text. */
function escapeMarkdown(value: string): string {
  return value.replace(/[\\[\]()!]/g, (ch) => `\\${ch}`);
}

function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function Snippet({
  title,
  value,
  label,
  onCopy,
}: {
  title: string;
  value: string;
  /** The button's current word — idle, copied, or the refused-clipboard hint. */
  label: string;
  onCopy: () => void;
}) {
  return (
    <Panel
      title={title}
      actions={
        <button onClick={onCopy} className="ck-btn ck-btn-bracket">
          {label}
        </button>
      }
    >
      <pre className="ck-mono ck-pos whitespace-pre-wrap break-all px-2 py-2 leading-tight">
        {value}
      </pre>
    </Panel>
  );
}
