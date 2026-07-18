import { useEffect, useState } from "react";
import { verdictApi, API_BASE, type AgentProfile } from "../api.js";
import { CompactTopbar } from "../components/compact/Topbar.js";
import { Panel } from "../components/compact/Panel.js";

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
 * Compact cockpit idiom — CompactTopbar + hairline Panels + ck-* type scale,
 * matching recruiters / leaderboard.
 */
export function SharePage({ slug }: { slug: string }) {
  const base = API_BASE;
  const ogUrl = `${base}/v1/og/${slug}.svg`;
  const badgeUrl = `${base}/v1/badge/${slug}.svg`;
  // The dashboard hash URL (`origin/#/agents/<slug>`) is fine for in-app
  // navigation, but social scrapers (X, Discord, Slack) ignore the URL
  // fragment and only see the SPA's static index meta — so the per-agent
  // OG card never renders. The daemon's `/share/:slug` is the OG-meta
  // interceptor: it serves the right tags AND meta-refreshes browsers
  // through to `#/share/<slug>`. Share that URL externally; keep the
  // hash URL only for the in-app footer link below.
  const ref = parseRef();
  const shareUrl = ref
    ? `${base}/share/${slug}?ref=${encodeURIComponent(ref)}`
    : `${base}/share/${slug}`;

  const [agent, setAgent] = useState<AgentProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

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
  // (?ref=<sender>) fire a single click ping and sticky the (ref, slug)
  // pair for account-page attribution.
  useEffect(() => {
    if (!ref) return;
    fetch(`${API_BASE}/v1/refs/${encodeURIComponent(ref)}/click`, {
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
      ? `${slug} on Murmur Verdict — the public referee for autonomous market agents. ${shareUrl}`
      : `${agent.display_name} on Murmur Verdict — public referee for autonomous market agents. Score updates live. ${shareUrl}`;
  const tweetUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(tweetBody)}`;
  const telegramUrl = `https://t.me/share/url?url=${encodeURIComponent(shareUrl)}&text=${encodeURIComponent(tweetBody)}`;

  const markdownEmbed = `[![${agent?.display_name ?? slug} on Murmur](${badgeUrl})](${shareUrl})`;
  const htmlEmbed = `<a href="${shareUrl}"><img src="${badgeUrl}" alt="${agent?.display_name ?? slug} on Murmur" /></a>`;

  const copy = (key: string, value: string) => {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(key);
      setTimeout(() => setCopied(null), 1500);
    });
  };

  return (
    <div className="mmr-shell min-h-dvh flex flex-col">
      <CompactTopbar
        crumb={
          <span>
            share <span className="ck-dim mx-1">/</span>
            <span className="ck-pos">{slug}</span>
          </span>
        }
      />

      {/* HERO STRIP ─────────────────────────────────── */}
      <section className="border-b border-[var(--color-border)] px-3 py-3 flex flex-col gap-1">
        <span className="ck-label ck-dim">
          {ref ? `share / referred by @${ref}` : "share"}
        </span>
        <span className="ck-mono">
          {agent ? agent.display_name : slug}{" "}
          <span className="ck-pos">on Murmur Verdict</span>.
        </span>
        {ref && (
          <span className="ck-mono ck-dim max-w-[70ch]">
            <span className="ck-pos">@{ref}</span> shared this verdict with you.
            Score updates live; receipts are independently verifiable.
          </span>
        )}
      </section>

      <main className="flex-1 min-h-0 overflow-y-auto ck-scroll flex flex-col gap-3 p-3">
        {error && (
          <div className="px-3 py-2 ck-mono ck-neg">[error] {error}</div>
        )}

        {/* OG PREVIEW — full bleed */}
        <Panel title="social card" meta="1200×630">
          <div className="p-2 flex flex-col gap-1">
            <div className="ck-frame">
              <img
                src={ogUrl}
                alt={`${agent?.display_name ?? slug} verdict card`}
                className="block w-full"
                loading="eager"
              />
            </div>
            <a
              href={ogUrl}
              target="_blank"
              rel="noreferrer"
              className="ck-mono ck-dim break-all no-underline hover:text-[var(--color-display)]"
            >
              {ogUrl}
            </a>
          </div>
        </Panel>

        {/* SHARE ACTIONS */}
        <Panel title="broadcast">
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
              {copied === "link" ? "copied" : "copy link"}
            </button>
          </div>
        </Panel>

        {/* EMBED SNIPPETS */}
        <Snippet
          title="markdown · readme / github"
          value={markdownEmbed}
          copied={copied === "markdown"}
          onCopy={() => copy("markdown", markdownEmbed)}
        />
        <Snippet
          title="html · notion / discord / web"
          value={htmlEmbed}
          copied={copied === "html"}
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
  title,
  value,
  copied,
  onCopy,
}: {
  title: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <Panel
      title={title}
      actions={
        <button onClick={onCopy} className="ck-btn ck-btn-bracket">
          {copied ? "copied" : "copy"}
        </button>
      }
    >
      <pre className="ck-mono ck-pos whitespace-pre-wrap break-all px-2 py-2 leading-tight">
        {value}
      </pre>
    </Panel>
  );
}
