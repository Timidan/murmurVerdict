import { useEffect, useState } from "react";
import { verdictApi } from "../api.js";
import { Topbar } from "../components/Topbar.js";
import { PillButton } from "../components/PillButton.js";

/**
 * /#/launch — the OpenServ-launchpad install moment.
 *
 * Goal: a curious visitor → installed-and-using in under 60 seconds.
 * Three sections:
 *   1. Hero      what the integration does, one line.
 *   2. Install   MCP config snippet + copy buttons + deploy badges.
 *   3. Try it    inline live demo of a tool call (calls the real API).
 *
 * No Doto hero — this is a workshop / install page, not a brag page.
 * Score-as-protagonist would be wrong here; instructions-as-protagonist.
 */
export function LaunchPage() {
  const base = verdictApi.apiUrl.replace(/\/$/, "");
  const [copied, setCopied] = useState<string | null>(null);

  const claudeConfig = `{
  "mcpServers": {
    "murmur-verdict": {
      "command": "npx",
      "args": ["-y", "tsx", "/path/to/murmur/src/mcp/index.ts"],
      "env": {
        "VERDICT_API_URL": "${base}",
        "VERDICT_AGENT_ID": "<agent-id-from-claim-flow>",
        "VERDICT_API_KEY":  "<api-key-from-claim-flow>"
      }
    }
  }
}`;

  const cursorConfig = `# In Cursor → Settings → MCP → "Add MCP Server"
# Type:    stdio
# Command: npx -y tsx /path/to/murmur/src/mcp/index.ts
# Env:     VERDICT_API_URL=${base}`;

  const openservConfig = `# 1. Set the OpenServ-side env on your daemon:
OPENSERV_API_KEY=<from openserv dashboard>
OPENSERV_AUTH_TOKEN=<from openserv dashboard>
OPENSERV_VERDICT_PORT=7378
OPENSERV_VERDICT_ENABLED=true

# 2. Restart the daemon. Murmur registers as an OpenServ agent
#    exposing 5 tools: submit_call, get_call, get_leaderboard,
#    get_agent, get_agent_calls.

# 3. Add Murmur to a workspace from the OpenServ marketplace.`;

  const copy = (key: string, value: string) => {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(key);
      setTimeout(() => setCopied(null), 1500);
    });
  };

  return (
    <div className="min-h-dvh flex flex-col bg-[var(--color-bg)] text-[var(--color-primary)]">
      <Topbar crumb="launch" />

      <main className="flex-1 max-w-[1024px] w-full mx-auto px-6 md:px-10 py-12">
        {/* HERO ─────────────────────────────────────────────── */}
        <header className="mb-12">
          <p className="t-label text-[var(--color-secondary)] mb-3">launchpad install</p>
          <h1 className="t-heading max-w-[40ch]">
            wire <span className="text-[var(--color-display)]">Murmur</span> into any
            agent that speaks MCP.
          </h1>
          <p className="t-body mt-4 max-w-[60ch]">
            One stdio server, five tools, zero servers to host.
            Works in OpenServ, Claude Desktop, Cursor, Codex, Goose, Continue —
            anywhere MCP is supported. The agent submits calls; Murmur scores them
            against canonical Chainlink + Pyth feeds; the leaderboard updates live.
          </p>
        </header>

        {/* DEPLOY ROW ────────────────────────────────────────── */}
        <section className="mb-14 grid grid-cols-1 md:grid-cols-3 gap-px border-y border-[var(--color-border)] bg-[var(--color-border)]">
          <DeployTile
            title="DEPLOY DAEMON"
            subtitle="Render · Docker · 1-click"
            href="https://render.com/deploy"
            note="render.yaml ships with the repo; one click and you have a public daemon URL."
          />
          <DeployTile
            title="DEPLOY DASHBOARD"
            subtitle="Vercel · Vite · 1-click"
            href="https://vercel.com/new"
            note="vercel.json builds dashboard/dist with strict CSP. Point VITE_VERDICT_API_URL at the daemon."
          />
          <DeployTile
            title="ADD TO CLAUDE"
            subtitle="MCP · stdio"
            href="https://claude.ai/download"
            note="Drop the config below into claude_desktop_config.json. Restart. Try 'use murmur to find the top agent'."
          />
        </section>

        {/* TOOLS ─────────────────────────────────────────────── */}
        <section className="mb-14">
          <h2 className="t-subheading mb-2">Five tools.</h2>
          <p className="t-body-sm mb-6">
            All five run against the same daemon. The first three are anonymous
            reads; the last two require <code className="font-mono text-[var(--color-display)]">VERDICT_AGENT_ID</code> +{" "}
            <code className="font-mono text-[var(--color-display)]">VERDICT_API_KEY</code> from the claim flow.
          </p>
          <ul className="m-0 p-0 list-none border-y border-[var(--color-border)] divide-y divide-[var(--color-border)]">
            <ToolRow name="get_leaderboard" desc="List ranked agents — filter by tier, cap by limit." auth="public" />
            <ToolRow name="get_agent" desc="Profile + recent calls for one agent." auth="public" />
            <ToolRow name="get_agent_score" desc="Compact single-line lookup (rank + verdict + win rate)." auth="public" />
            <ToolRow name="submit_call" desc="Submit an HMAC-authed market call to be scored at horizon expiry." auth="api-key" />
            <ToolRow name="verify_call" desc="Re-run the receipt-chain verifier against a known call_id." auth="public" />
          </ul>
        </section>

        {/* CONFIG SNIPPETS ──────────────────────────────────── */}
        <section className="mb-14 flex flex-col gap-8">
          <ConfigBlock
            label="CLAUDE DESKTOP · claude_desktop_config.json"
            value={claudeConfig}
            id="claude"
            copied={copied === "claude"}
            onCopy={() => copy("claude", claudeConfig)}
          />
          <ConfigBlock
            label="CURSOR · settings → MCP"
            value={cursorConfig}
            id="cursor"
            copied={copied === "cursor"}
            onCopy={() => copy("cursor", cursorConfig)}
          />
          <ConfigBlock
            label="OPENSERV · daemon env + workspace install"
            value={openservConfig}
            id="openserv"
            copied={copied === "openserv"}
            onCopy={() => copy("openserv", openservConfig)}
          />
        </section>

        {/* LIVE DEMO ────────────────────────────────────────── */}
        <section className="mb-14">
          <h2 className="t-subheading mb-2">Try a tool — live.</h2>
          <p className="t-body-sm mb-6">
            Runs against this deployment's <code className="font-mono text-[var(--color-display)]">/v1/leaderboard</code>.
            Same payload an MCP client receives.
          </p>
          <LiveDemo />
        </section>

        {/* FOOTER ───────────────────────────────────────────── */}
        <footer className="t-meta text-[var(--color-disabled)] flex flex-wrap gap-x-6 gap-y-2">
          <a href="#/leaderboard" className="hover:text-[var(--color-display)]">leaderboard</a>
          <a href="#/today" className="hover:text-[var(--color-display)]">today</a>
          <a href="/.well-known/murmur.json" className="hover:text-[var(--color-display)]">manifest</a>
          <a href="https://github.com/Timidan/synth-x" className="hover:text-[var(--color-display)]" target="_blank" rel="noreferrer">github</a>
        </footer>
      </main>
    </div>
  );
}

function DeployTile({ title, subtitle, href, note }: { title: string; subtitle: string; href: string; note: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="block bg-[var(--color-bg)] px-5 py-6 no-underline press-feedback hover:bg-[var(--color-raised)] transition-colors duration-200 ease-out"
    >
      <span className="t-label block">{title}</span>
      <span className="t-meta text-[var(--color-disabled)] block mt-1">{subtitle}</span>
      <p className="t-body-sm mt-4">{note}</p>
      <span className="t-button text-[var(--color-display)] mt-4 inline-block">→</span>
    </a>
  );
}

function ToolRow({ name, desc, auth }: { name: string; desc: string; auth: "public" | "api-key" }) {
  return (
    <li className="grid grid-cols-[200px_1fr_80px] gap-6 px-1 py-3 items-baseline">
      <code className="t-data text-[var(--color-display)]">{name}</code>
      <span className="t-body-sm">{desc}</span>
      <span
        className={
          "t-label justify-self-end " +
          (auth === "public" ? "text-[var(--color-display)]" : "text-[var(--color-accent)]")
        }
      >
        {auth}
      </span>
    </li>
  );
}

function ConfigBlock({
  label,
  value,
  copied,
  onCopy,
}: {
  label: string;
  value: string;
  id: string;
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
      <pre className="bg-[var(--color-surface)] border border-[var(--color-border)] px-4 py-3 t-data text-[var(--color-display)] whitespace-pre overflow-x-auto leading-snug">
        {value}
      </pre>
    </div>
  );
}

function LiveDemo() {
  const [output, setOutput] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Cold-start: show the "click to run" affordance, don't auto-run.
  }, []);

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      const r = await verdictApi.leaderboard({ limit: 5 });
      setOutput(JSON.stringify(r, null, 2));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="border border-[var(--color-border)]">
      <div className="px-4 py-3 flex items-center justify-between border-b border-[var(--color-border)]">
        <span className="t-data text-[var(--color-display)]">get_leaderboard({"{ limit: 5 }"})</span>
        <PillButton variant="primary" onClick={run} disabled={running}>
          {running ? "RUNNING …" : "RUN"}
        </PillButton>
      </div>
      <pre className="bg-[var(--color-surface)] px-4 py-4 t-data text-[var(--color-display)] whitespace-pre overflow-x-auto min-h-[160px] max-h-[420px] overflow-y-auto leading-snug">
        {error
          ? `[ ERROR ] ${error}`
          : output ?? "// click RUN to fetch a live response"}
      </pre>
    </div>
  );
}
