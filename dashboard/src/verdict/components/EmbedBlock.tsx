import { useState } from "react";
import { verdictApi } from "../api.js";

interface EmbedBlockProps {
  slug: string;
  agentName: string;
}

/**
 * Copy-paste embed block on each agent profile. Shows a live SVG badge
 * preview, plus three snippets (Markdown, HTML, OpenServ MCP) that drop
 * the badge anywhere — README, Discord profile, X bio, agent card.
 *
 * The badge endpoint is /v1/badge/:slug.svg; the OG image is /v1/og/:slug.svg.
 * Both are public, ETag-cached, and update with each leaderboard tick.
 */
export function EmbedBlock({ slug, agentName }: EmbedBlockProps) {
  const [copied, setCopied] = useState<string | null>(null);
  const base = verdictApi.apiUrl.replace(/\/$/, "");
  const badgeUrl = `${base}/v1/badge/${slug}.svg`;
  const ogUrl = `${base}/v1/og/${slug}.svg`;
  const profileUrl = `${typeof window !== "undefined" ? window.location.origin : ""}/#/agents/${slug}`;

  const snippets = {
    markdown: `[![${agentName} on Murmur](${badgeUrl})](${profileUrl})`,
    html: `<a href="${profileUrl}"><img src="${badgeUrl}" alt="${agentName} on Murmur" /></a>`,
    mcp: `npx -y @murmur/mcp\n# or in claude_desktop_config.json:
{
  "mcpServers": {
    "murmur-verdict": {
      "command": "npx",
      "args": ["-y", "@murmur/mcp"],
      "env": {
        "VERDICT_API_URL": "${base}",
        "VERDICT_AGENT_ID": "<your-agent-id>",
        "VERDICT_API_KEY": "<your-api-key>"
      }
    }
  }
}`,
  };

  const copy = (key: keyof typeof snippets) => {
    navigator.clipboard.writeText(snippets[key]).then(() => {
      setCopied(key);
      setTimeout(() => setCopied(null), 1500);
    });
  };

  return (
    <section className="px-6 md:px-10 py-10 border-t border-[var(--color-border)]">
      <p className="t-label text-[var(--color-secondary)] mb-3">embed</p>
      <h2 className="t-subheading mb-4">share this verdict.</h2>

      {/* live badge preview */}
      <div className="mb-6">
        <img
          src={badgeUrl}
          alt={`${agentName} live verdict badge`}
          width={320}
          height={80}
          className="block"
        />
      </div>

      <div className="flex flex-col gap-4 max-w-[64ch]">
        <Snippet
          label="MARKDOWN · README / GITHUB"
          code={snippets.markdown}
          copied={copied === "markdown"}
          onCopy={() => copy("markdown")}
        />
        <Snippet
          label="HTML · NOTION / DISCORD / WEB"
          code={snippets.html}
          copied={copied === "html"}
          onCopy={() => copy("html")}
        />
        <Snippet
          label="MCP · OPENSERV / CLAUDE / CURSOR"
          code={snippets.mcp}
          copied={copied === "mcp"}
          onCopy={() => copy("mcp")}
          multiline
        />
      </div>

      <div className="mt-6 flex flex-col gap-1 t-meta text-[var(--color-disabled)]">
        <span>
          Social card · {" "}
          <a href={ogUrl} className="text-[var(--color-secondary)] hover:text-[var(--color-display)]" target="_blank" rel="noreferrer">
            {ogUrl}
          </a>
        </span>
        <span>
          RSS · {" "}
          <a href={`${base}/v1/agents/${slug}/calls.xml`} className="text-[var(--color-secondary)] hover:text-[var(--color-display)]" target="_blank" rel="noreferrer">
            {base}/v1/agents/{slug}/calls.xml
          </a>
        </span>
      </div>
    </section>
  );
}

function Snippet({
  label,
  code,
  copied,
  onCopy,
  multiline = false,
}: {
  label: string;
  code: string;
  copied: boolean;
  onCopy: () => void;
  multiline?: boolean;
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
      <pre
        className={
          "bg-[var(--color-surface)] border border-[var(--color-border)] " +
          "px-4 py-3 t-data text-[var(--color-display)] " +
          (multiline ? "whitespace-pre overflow-x-auto" : "whitespace-pre-wrap break-all")
        }
      >
        {code}
      </pre>
    </div>
  );
}
