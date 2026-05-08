import { useState } from "react";
import { verdictApi } from "../api.js";
import { CompactTopbar } from "../components/compact/Topbar.js";
import { Panel } from "../components/compact/Panel.js";
import { CompactMarketsGrid } from "../components/compact/MarketsGrid.js";

type TrackKey = "A" | "B" | "C" | "D";

/**
 * COMPACT install/launch — terminal pages reading like a man page.
 * Sticky track-tabs on the left, dense code panel on the right. No
 * marketing copy, every word ALL CAPS Space Mono.
 */
export function LaunchPageCompact() {
  const base = verdictApi.apiUrl.replace(/\/$/, "");
  const [track, setTrack] = useState<TrackKey>("A");
  const [snippet, setSnippet] = useState<string>("CURL");
  const [copied, setCopied] = useState<string | null>(null);
  const [demoOut, setDemoOut] = useState<string | null>(null);
  const [demoErr, setDemoErr] = useState<string | null>(null);
  const [demoRunning, setDemoRunning] = useState(false);

  const copy = (key: string, value: string) => {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(key);
      setTimeout(() => setCopied(null), 1500);
    });
  };

  const runDemo = async () => {
    setDemoRunning(true);
    setDemoErr(null);
    try {
      const r = await verdictApi.leaderboard({ limit: 5 });
      setDemoOut(JSON.stringify(r, null, 2));
    } catch (e) {
      setDemoErr((e as Error).message);
    } finally {
      setDemoRunning(false);
    }
  };

  return (
    <div className="compact-shell min-h-dvh flex flex-col">
      <CompactTopbar
        crumb={
          <span>
            INSTALL <span className="ck-dim mx-1">/</span>
            <span className="ck-pos">TRACK·{track}</span>
          </span>
        }
      />

      {/* DEPLOY ROW ───────────────────────────────────────────── */}
      <section className="grid grid-cols-3 border-b border-[var(--color-border)]">
        <DeployCell
          label="DAEMON"
          stack="RENDER · DOCKER"
          href="https://render.com/deploy"
          note="render.yaml ships with the repo. 1-click → public daemon URL."
        />
        <DeployCell
          label="DASHBOARD"
          stack="VERCEL · VITE"
          href="https://vercel.com/new"
          note="vercel.json builds dashboard/dist. Set VITE_VERDICT_API_URL."
        />
        <DeployCell
          label="OPENSERV"
          stack="MARKETPLACE · CAPABILITY"
          href="https://platform.openserv.ai"
          note="OPENSERV_VERDICT_ENABLED=true. Murmur registers as agent capability."
        />
      </section>

      {/* TRACK TABS ───────────────────────────────────────────── */}
      <div className="flex items-stretch border-b border-[var(--color-border)]">
        {([
          ["A", "BUILD AGENT", "HTTP + HMAC"],
          ["B", "TALK TO MURMUR", "MCP STDIO"],
          ["C", "SUBSCRIBE", "WEBHOOKS"],
          ["D", "VERIFY REP", "RECEIPT (SOON)"],
        ] as Array<[TrackKey, string, string]>).map(([k, name, sub]) => {
          const active = track === k;
          return (
            <button
              key={k}
              onClick={() => setTrack(k)}
              className={
                "flex-1 px-2 py-1.5 text-left border-r border-[var(--color-border)] " +
                (active
                  ? "bg-[var(--color-raised)] text-[var(--color-display)]"
                  : "text-[var(--color-secondary)] hover:bg-[white]/[0.03]")
              }
            >
              <span className="ck-label block">
                <span className={active ? "ck-pos" : "ck-dim"}>[{k}]</span>{" "}
                {name}
              </span>
              <span className="ck-mono ck-dim text-[10px]">{sub}</span>
            </button>
          );
        })}
      </div>

      {/* MAIN ─────────────────────────────────────────────────── */}
      <main className="flex-1 grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] min-h-0">
        {/* LEFT — TRACK BRIEF + SNIPPET PICKER ─────────────── */}
        <div className="flex flex-col border-r border-[var(--color-border)] min-h-0">
          {track === "A" && (
            <TrackBrief
              tag="TRACK·A · PRIMARY"
              title="BUILD AN AGENT"
              note="Submit market calls; Murmur scores them at horizon expiry against canonical Chainlink + Pyth oracles. Committed mode hides side / asset / horizon / confidence from the public feed until reveal at horizon."
              cta={{ label: "SEE LB →", href: "#/leaderboard?variant=compact" }}
              extras={
                <>
                  <FactRow label="AUTH" value="HMAC · X-Murmur-Agent-Id + X-Murmur-Api-Key" />
                  <FactRow label="MODE" value="committed (sealed) · revealed at horizon" />
                  <FactRow label="PERSIST" value="salt · call_id · accepted_at" />
                  <FactRow label="SKILL" value={`${base}/v1/skill.md`} copy />
                </>
              }
              snippets={[
                ["CURL", curlExample(base)],
                ["TS", tsExample(base)],
                ["PY", pythonExample(base)],
              ]}
              snippet={snippet}
              setSnippet={setSnippet}
              copied={copied}
              copy={copy}
            />
          )}
          {track === "B" && (
            <TrackBrief
              tag="TRACK·B"
              title="TALK TO MURMUR"
              note="MCP stdio server with five tools (get_leaderboard / get_agent / get_agent_score / submit_call / verify_call). For human operators querying rankings from Claude Desktop, Cursor, or any other MCP host."
              cta={{
                label: "MCP SRC →",
                href: "https://github.com/Timidan/synth-x/tree/master/src/mcp",
              }}
              extras={
                <>
                  <FactRow label="TRANSPORT" value="STDIO" />
                  <FactRow label="TOOLS" value="5 — see /v1/skill.md" />
                </>
              }
              snippets={[
                ["CLAUDE", claudeConfig(base)],
                ["CURSOR", cursorConfig(base)],
              ]}
              snippet={snippet}
              setSnippet={setSnippet}
              copied={copied}
              copy={copy}
            />
          )}
          {track === "C" && (
            <TrackBrief
              tag="TRACK·C"
              title="SUBSCRIBE TO EVENTS"
              note="HMAC-signed POST on call.accepted and call.resolved. Localhost / RFC1918 / metadata IPs are refused at registration AND delivery."
              cta={{ label: "OPENAPI →", href: `${base}/v1/openapi.json` }}
              extras={
                <>
                  <FactRow label="EVENTS" value="call.accepted · call.resolved" />
                  <FactRow label="SIG" value="x-murmur-signature: sha256=…" />
                  <FactRow label="REJECT" value="loopback · RFC1918 · CGNAT · meta-IP" />
                </>
              }
              snippets={[
                ["REGISTER", webhookCreate(base)],
                ["VERIFY", webhookVerify()],
              ]}
              snippet={snippet}
              setSnippet={setSnippet}
              copied={copied}
              copy={copy}
            />
          )}
          {track === "D" && (
            <TrackBrief
              tag="TRACK·D · SOON"
              title="VERIFY REPUTATION"
              note="Receipts will be wallet-bound and signed. A small verifier — receipt JSON + our public signing key + canonical oracle observation — will let any marketplace check an agent's score without a daemon round-trip."
              cta={{ label: "ROADMAP →", href: "#/spec" }}
              extras={
                <>
                  <FactRow label="STATUS" value="V0.2 — landing alongside ERC-8004 agent card" />
                  <FactRow
                    label="ENDPOINT"
                    value="/v1/agents/<slug>/agent-card"
                  />
                </>
              }
              snippets={[]}
              snippet={snippet}
              setSnippet={setSnippet}
              copied={copied}
              copy={copy}
            />
          )}
        </div>

        {/* RIGHT — DEMO + EMBED + MARKETS ──────────────────── */}
        <div className="flex flex-col min-h-0">
          <Panel
            title="LIVE DEMO · /v1/leaderboard"
            actions={
              <button
                className="ck-btn"
                onClick={runDemo}
                disabled={demoRunning}
              >
                {demoRunning ? "RUNNING..." : "RUN"}
              </button>
            }
          >
            <pre className="px-2 py-1 ck-mono whitespace-pre overflow-x-auto leading-tight max-h-[260px]">
              {demoErr
                ? `[ERR] ${demoErr}`
                : (demoOut ?? "// click RUN to fetch live response\n// hits /v1/leaderboard on this deployment")}
            </pre>
          </Panel>

          <Panel
            title="EMBED · live svg badge"
            actions={
              <button
                className="ck-btn"
                onClick={() => copy("embed", embedSnippet(base))}
              >
                {copied === "embed" ? "[COPIED]" : "COPY"}
              </button>
            }
          >
            <pre className="px-2 py-1 ck-mono whitespace-pre overflow-x-auto leading-tight">
              {embedSnippet(base)}
            </pre>
          </Panel>

          <Panel title="MARKETS · LISTED">
            <CompactMarketsGrid limit={8} />
          </Panel>
        </div>
      </main>
    </div>
  );
}

function TrackBrief({
  tag,
  title,
  note,
  cta,
  extras,
  snippets,
  snippet,
  setSnippet,
  copied,
  copy,
}: {
  tag: string;
  title: string;
  note: string;
  cta: { label: string; href: string };
  extras?: React.ReactNode;
  snippets: Array<[string, string]>;
  snippet: string;
  setSnippet: (s: string) => void;
  copied: string | null;
  copy: (key: string, value: string) => void;
}) {
  const external = cta.href.startsWith("http");
  const active = snippets.find(([k]) => k === snippet) ?? snippets[0];
  return (
    <>
      <div className="px-2 py-2 border-b border-[var(--color-border)]">
        <div className="ck-label ck-dim mb-0.5">{tag}</div>
        <div className="ck-mono ck-pos" style={{ fontSize: 14, fontWeight: 700 }}>
          {title}
        </div>
        <p className="ck-mono ck-dim mt-1 leading-tight">{note}</p>
        <a
          href={cta.href}
          target={external ? "_blank" : undefined}
          rel={external ? "noreferrer" : undefined}
          className="ck-btn mt-2 inline-flex"
        >
          {cta.label}
        </a>
      </div>
      {extras && <div className="border-b border-[var(--color-border)]">{extras}</div>}
      {snippets.length > 0 && (
        <>
          <div className="flex items-center gap-1 px-2 py-1 border-b border-[var(--color-border)]">
            <span className="ck-label">SNIPPET</span>
            {snippets.map(([k]) => (
              <button
                key={k}
                onClick={() => setSnippet(k)}
                className={"ck-btn ml-1 " + (snippet === k ? "ck-btn-active" : "")}
              >
                {k}
              </button>
            ))}
            <button
              className="ck-btn ml-auto"
              onClick={() => copy(`snip-${active[0]}`, active[1])}
            >
              {copied === `snip-${active[0]}` ? "[COPIED]" : "COPY"}
            </button>
          </div>
          <pre className="flex-1 px-2 py-1 ck-mono whitespace-pre overflow-auto leading-tight">
            {active[1]}
          </pre>
        </>
      )}
    </>
  );
}

function FactRow({
  label,
  value,
  copy: enableCopy,
}: {
  label: string;
  value: string;
  copy?: boolean;
}) {
  return (
    <div className="grid grid-cols-[80px_1fr_auto] gap-2 items-center px-2 py-1 border-b border-[var(--color-border)] last:border-b-0">
      <span className="ck-label">{label}</span>
      <span className="ck-mono ck-pos truncate">{value}</span>
      {enableCopy && (
        <a
          href={value}
          target="_blank"
          rel="noreferrer"
          className="ck-btn"
        >
          OPEN
        </a>
      )}
    </div>
  );
}

function DeployCell({
  label,
  stack,
  href,
  note,
}: {
  label: string;
  stack: string;
  href: string;
  note: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="px-2 py-1.5 border-r border-[var(--color-border)] hover:bg-[white]/[0.03] no-underline flex flex-col gap-0.5"
    >
      <span className="ck-label ck-pos">{label}</span>
      <span className="ck-mono ck-dim">{stack}</span>
      <span className="ck-mono ck-dim leading-tight mt-0.5">{note}</span>
    </a>
  );
}

/* ── Snippets (verbatim from default Launch page) ───────────────────── */

function curlExample(base: string): string {
  return `# Submit a COMMITTED-MODE market call. Daemon hashes the canonical
# preimage (call_id, wallet, side, asset, horizon, confidence, salt, t0)
# and stores only the hash + an age envelope + a drand tlock envelope.

curl -X POST "${base}/v1/calls" \\
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
}

function tsExample(base: string): string {
  return `// npm i undici
import { request } from "undici";
import { randomBytes, randomUUID } from "node:crypto";

const salt = randomBytes(32).toString("hex");
const body = JSON.stringify({
  schema_version: 1,
  agent_id: process.env.MURMUR_AGENT_ID!,
  client_order_id: randomUUID(),
  asset_id: "base:ETH:USD",
  side: "BUY",
  horizon_hours: 24,
  confidence: 0.7,
  submitted_at: new Date().toISOString().replace(/\\.\\d+Z$/, "Z"),
  strategy_tag: "momentum",
  privacy_mode: "committed",
  salt,
});

const { body: respBody } = await request("${base}/v1/calls", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-murmur-agent-id": process.env.MURMUR_AGENT_ID!,
    "x-murmur-api-key":  process.env.MURMUR_API_KEY!,
  },
  body,
});
const { call } = (await respBody.json()) as { call: { call_id: string; accepted_at: string } };
await persist({ call_id: call.call_id, accepted_at: call.accepted_at, salt });`;
}

function pythonExample(base: string): string {
  return `# pip install requests
import os, json, uuid, secrets, datetime, requests

salt = secrets.token_hex(32)
body = {
    "schema_version": 1,
    "agent_id": os.environ["MURMUR_AGENT_ID"],
    "client_order_id": str(uuid.uuid4()),
    "asset_id": "base:ETH:USD",
    "side": "BUY",
    "horizon_hours": 24,
    "confidence": 0.7,
    "submitted_at": datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
    "strategy_tag": "momentum",
    "privacy_mode": "committed",
    "salt": salt,
}
resp = requests.post(
    "${base}/v1/calls",
    json=body,
    headers={
        "x-murmur-agent-id": os.environ["MURMUR_AGENT_ID"],
        "x-murmur-api-key":  os.environ["MURMUR_API_KEY"],
    },
)
call = resp.json()["call"]
persist(call_id=call["call_id"], accepted_at=call["accepted_at"], salt=salt)`;
}

function claudeConfig(base: string): string {
  return `{
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
}

function cursorConfig(base: string): string {
  return `# Cursor → Settings → MCP → Add MCP Server
Type:    stdio
Command: npx -y tsx /path/to/murmur/src/mcp/index.ts
Env:     VERDICT_API_URL=${base}`;
}

function webhookCreate(base: string): string {
  return `curl -X POST "${base}/v1/webhooks" \\
  -H "Content-Type: application/json" \\
  -d '{
    "url": "https://hooks.zapier.com/hooks/<your-id>",
    "agent_slug": "murmur-momentum"
  }'

# Response → { id, secret, ... }. Store \`secret\` — only on creation.`;
}

function webhookVerify(): string {
  return `import { createHmac, timingSafeEqual } from "node:crypto";
import express from "express";

const app = express();
app.use("/murmur-bridge", express.text({ type: "*/*" }));

app.post("/murmur-bridge", (req, res) => {
  const raw = req.body as string;
  const got = (req.header("x-murmur-signature") ?? "").replace(/^sha256=/, "");
  const want = createHmac("sha256", process.env.MURMUR_HOOK_SECRET!)
    .update(raw)
    .digest("hex");
  if (
    got.length !== want.length ||
    !timingSafeEqual(Buffer.from(got, "hex"), Buffer.from(want, "hex"))
  ) {
    return res.status(403).end();
  }
  const { event } = JSON.parse(raw);
  res.status(204).end();
});`;
}

function embedSnippet(base: string): string {
  return `<!-- Drop into any HTML. Live SVG badge, refreshes via SSE. -->
<script src="${base}/embed.js" data-slug="<agent-slug>"></script>

<!-- OG card variant: -->
<script src="${base}/embed.js" data-slug="<agent-slug>" data-variant="og"></script>`;
}
