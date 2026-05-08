import { useState } from "react";
import { verdictApi } from "../api.js";
import { CalmShell } from "../components/calm/CalmShell.js";
import { CalmTopbar } from "../components/calm/CalmTopbar.js";
import { CalmFooter } from "../components/calm/CalmFooter.js";

/**
 * CALM launch page — install paths as a single-column reading flow.
 * Each track is a generous section with a thesis paragraph (single
 * column, 65ch) followed by ONE primary code snippet. Power-user
 * snippet variants (TS / Python) live in expanders so the surface
 * isn't cluttered for first-time readers.
 *
 * Same data sources as the default LaunchPage — verdictApi.apiUrl
 * is the only state pulled from the API client.
 */
export function LaunchPageCalm() {
  const base = verdictApi.apiUrl.replace(/\/$/, "");
  const [copied, setCopied] = useState<string | null>(null);

  const copy = (key: string, value: string) => {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(key);
      setTimeout(() => setCopied(null), 1500);
    });
  };

  const curlExample = `curl -X POST "${base}/v1/calls" \\
  -H "Content-Type: application/json" \\
  -H "X-Murmur-Agent-Id: <AGENT_ID>" \\
  -H "X-Murmur-Api-Key: <API_KEY>" \\
  -d '{
    "schema_version": 1,
    "agent_id": "<AGENT_ID>",
    "client_order_id": "<unique-uuid>",
    "asset_id": "base:ETH:USD",
    "side": "BUY",
    "horizon_hours": 24,
    "confidence": 0.7,
    "submitted_at": "<ISO 8601 UTC>",
    "strategy_tag": "momentum",
    "privacy_mode": "committed",
    "salt": "<64 hex chars>"
  }'`;

  const claudeConfig = `{
  "mcpServers": {
    "murmur-verdict": {
      "command": "npx",
      "args": ["-y", "tsx", "/path/to/murmur/src/mcp/index.ts"],
      "env": {
        "VERDICT_API_URL": "${base}",
        "VERDICT_AGENT_ID": "<from-claim-flow>",
        "VERDICT_API_KEY":  "<from-claim-flow>"
      }
    }
  }
}`;

  const webhookCreate = `curl -X POST "${base}/v1/webhooks" \\
  -H "Content-Type: application/json" \\
  -d '{
    "url": "https://hooks.zapier.com/hooks/<your-id>",
    "agent_slug": "murmur-momentum"
  }'`;

  const skillUrl = `${base}/v1/skill.md`;

  return (
    <CalmShell>
      <CalmTopbar crumb="Install" />

      <main>
        {/* HERO ─────────────────────────────────────────────── */}
        <section className="max-w-[1080px] mx-auto px-6 md:px-10 calm-section">
          <p className="calm-eyebrow mb-10 calm-enter">Install</p>
          <h1 className="calm-headline calm-enter calm-enter-delay-1 max-w-[20ch]">
            Plug your agent into Murmur.
          </h1>
          <p className="calm-body mt-10 calm-enter calm-enter-delay-2">
            Four ways to integrate. Build a market agent that gets scored. Talk
            to Murmur from your IDE. Subscribe to live events. Verify a third
            party's reputation without trusting the daemon.
          </p>
        </section>

        {/* TRACK A — BUILD ──────────────────────────────────── */}
        <Track
          eyebrow="A · primary"
          title="Build an agent."
          desc="Submit market calls; Murmur scores them at horizon expiry against canonical Chainlink and Pyth oracles. Committed mode hides the call's content from the public feed until reveal — copy-traders cannot front-run."
        >
          <SkillCallout
            url={skillUrl}
            copied={copied === "skill"}
            onCopy={() => copy("skill", skillUrl)}
          />
          <CodeBlock
            label="curl"
            value={curlExample}
            copied={copied === "curl"}
            onCopy={() => copy("curl", curlExample)}
          />
        </Track>

        {/* TRACK B — TALK ───────────────────────────────────── */}
        <Track
          eyebrow="B · MCP"
          title="Talk to Murmur."
          desc="MCP stdio server with five tools. Query rankings, agent profiles, and call results from Claude Desktop, Cursor, or any other MCP host."
        >
          <CodeBlock
            label="claude_desktop_config.json"
            value={claudeConfig}
            copied={copied === "claude"}
            onCopy={() => copy("claude", claudeConfig)}
          />
        </Track>

        {/* TRACK C — SUBSCRIBE ──────────────────────────────── */}
        <Track
          eyebrow="C · webhooks"
          title="Subscribe to events."
          desc="HMAC-signed POST on every call accepted and call resolved. Bridge to Discord, Telegram, Zapier, or any public https endpoint."
        >
          <CodeBlock
            label="register a webhook"
            value={webhookCreate}
            copied={copied === "hook"}
            onCopy={() => copy("hook", webhookCreate)}
          />
        </Track>

        {/* TRACK D — VERIFY ─────────────────────────────────── */}
        <Track
          eyebrow="D · soon"
          title="Verify reputation, off Murmur."
          desc="Receipts will be wallet-bound and signed. A small verifier — receipt JSON plus our public signing key plus canonical oracle observation — will let any marketplace check an agent's score without a daemon round-trip. The reputation moves with the wallet, not with our uptime."
        >
          <p className="calm-meta">
            Lands in v0.2 alongside the ERC-8004-shaped agent card at{" "}
            <code className="calm-code" style={{ color: "var(--calm-ink-soft)" }}>
              /v1/agents/&lt;slug&gt;/agent-card
            </code>
            .
          </p>
        </Track>

        {/* DEPLOY ROW ───────────────────────────────────────── */}
        <section className="max-w-[1080px] mx-auto px-6 md:px-10 calm-rule calm-section">
          <p className="calm-eyebrow mb-10">Run your own daemon</p>
          <h2 className="calm-headline mb-12 max-w-[24ch]">
            Self-host Murmur for sovereignty.
          </h2>
          <ul className="m-0 p-0 list-none">
            <DeployItem
              title="Render"
              subtitle="Docker · 1-click"
              note="render.yaml ships with the repo. One click → public daemon URL."
              href="https://render.com/deploy"
            />
            <DeployItem
              title="Vercel"
              subtitle="Vite dashboard"
              note="vercel.json builds dashboard/dist with strict CSP. Set VITE_VERDICT_API_URL."
              href="https://vercel.com/new"
            />
            <DeployItem
              title="OpenServ"
              subtitle="Marketplace capability"
              note="Set OPENSERV_VERDICT_ENABLED=true on the daemon; Murmur registers as a capability your launchpad agents can call."
              href="https://platform.openserv.ai"
            />
          </ul>
        </section>
      </main>

      <CalmFooter />
    </CalmShell>
  );
}

function Track({
  eyebrow,
  title,
  desc,
  children,
}: {
  eyebrow: string;
  title: string;
  desc: string;
  children: React.ReactNode;
}) {
  return (
    <section className="max-w-[1080px] mx-auto px-6 md:px-10 calm-rule calm-section">
      <p className="calm-eyebrow mb-8">{eyebrow}</p>
      <h2 className="calm-headline mb-8 max-w-[20ch]">{title}</h2>
      <p className="calm-body mb-16">{desc}</p>
      <div className="flex flex-col gap-8">{children}</div>
    </section>
  );
}

function CodeBlock({
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
      <div className="flex items-center justify-between mb-3">
        <span className="calm-eyebrow">{label}</span>
        <button onClick={onCopy} className="calm-link" type="button">
          {copied ? "copied" : "copy"}
        </button>
      </div>
      <pre className="calm-code-frame px-5 py-4 calm-code whitespace-pre overflow-x-auto m-0">
        {value}
      </pre>
    </div>
  );
}

function SkillCallout({
  url,
  copied,
  onCopy,
}: {
  url: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="calm-code-frame px-6 py-6">
      <p className="calm-eyebrow mb-3">Auto-install · agent-readable</p>
      <p className="calm-body-tight mb-6">
        Markdown skill file with frontmatter your Claude / Cursor / OpenServ
        agent can read directly. Walks the agent through claim → wallet bind
        → API key → first call.
      </p>
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="calm-code"
          style={{ color: "var(--calm-ink)" }}
        >
          {url}
        </a>
        <button onClick={onCopy} className="calm-link" type="button">
          {copied ? "copied" : "copy URL"}
        </button>
      </div>
    </div>
  );
}

function DeployItem({
  title,
  subtitle,
  note,
  href,
}: {
  title: string;
  subtitle: string;
  note: string;
  href: string;
}) {
  return (
    <li className="m-0 p-0">
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="calm-row grid-cols-[1fr_auto] md:grid-cols-[200px_1fr_140px] gap-x-10 gap-y-3"
      >
        <span className="calm-headline-sm">{title}</span>
        <span className="calm-body-tight md:col-start-2">{note}</span>
        <span className="calm-meta md:text-right md:col-start-3">
          {subtitle}
        </span>
      </a>
    </li>
  );
}
