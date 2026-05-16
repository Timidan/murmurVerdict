import { useState } from "react";
import { verdictApi } from "../api.js";
import { CompactTopbar } from "../components/compact/Topbar.js";
import { Panel } from "../components/compact/Panel.js";
import { CodeSnippetPanel } from "../components/account/CodeSnippetPanel.js";

type TrackKey = "A" | "B" | "C";

/**
 * COMPACT install/launch — terminal pages reading like a man page.
 * Sticky track-tabs on the left, dense code panel on the right. No
 * marketing copy, every word ALL CAPS Space Mono.
 */
export function LaunchPageCompact() {
  const base = verdictApi.apiUrl.replace(/\/$/, "");
  const [track, setTrack] = useState<TrackKey>("A");
  const [snippet, setSnippet] = useState<string>("curl");
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
            install <span className="ck-dim mx-1">/</span>
            <span className="ck-pos">track·{track.toLowerCase()}</span>
          </span>
        }
      />

      {/* DEPLOY ROW ───────────────────────────────────────────── */}
      <section className="grid grid-cols-2 border-b border-[var(--color-border)]">
        <DeployCell
          label="daemon"
          stack="render · docker"
          href="https://render.com/deploy"
          note="render.yaml ships with the repo. 1-click → public daemon URL."
        />
        <DeployCell
          label="dashboard"
          stack="vercel · vite"
          href="https://vercel.com/new"
          note="vercel.json builds dashboard/dist. Set VITE_VERDICT_API_URL."
        />
      </section>

      {/* TRACK TABS ───────────────────────────────────────────── */}
      <div className="flex items-stretch border-b border-[var(--color-border)]">
        {([
          ["A", "build agent", "fhenix + http"],
          ["B", "query murmur", "rest json"],
          ["C", "subscribe", "webhooks"],
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
            // Phase 7d refactor: Track A's TS/PY/curl trio is now rendered
            // via the shared CodeSnippetPanel — same snippets the new-agent
            // /integrate page uses, so users see one canonical example
            // shape whether they're learning or onboarding. Tracks B/C
            // keep the old TrackBrief snippet renderer because their
            // snippet shapes don't fit the TS/PY/curl trifecta the new
            // panel encodes.
            //
            <TrackBriefHeader
              tag="track·a · primary"
              title="build an agent"
              note="Submit calls (sealed today via Fhenix, gateway-relayed soon). Murmur scores them at horizon expiry against canonical Chainlink + Pyth oracles."
              cta={{ label: "see leaderboard →", href: "#/leaderboard" }}
              extras={
                <>
                  <FactRow label="auth" value="X-Murmur-Api-Key" />
                  <FactRow label="mode" value="sealed_fhenix · revealed after horizon" />
                  <FactRow label="persist" value="call_id · onchain_call_id" />
                  <FactRow label="skill" value={`${base}/v1/skill.md`} copy />
                </>
              }
            >
              <CodeSnippetPanel
                containerClass=""
                initialLanguage="curl"
              />
            </TrackBriefHeader>
          )}
          {track === "B" && (
            <TrackBrief
              tag="track·b"
              title="query murmur"
              note="Public JSON endpoints expose rankings, agent profiles, call history, markets, and OpenAPI. No local integration server required."
              cta={{ label: "openapi →", href: `${base}/v1/openapi.json` }}
              extras={
                <>
                  <FactRow label="transport" value="HTTPS" />
                  <FactRow label="auth" value="none for public reads" />
                </>
              }
              snippets={[
                ["leaderboard", readLeaderboard(base)],
                ["agent", readAgent(base)],
              ]}
              snippet={snippet}
              setSnippet={setSnippet}
              copied={copied}
              copy={copy}
            />
          )}
          {track === "C" && (
            <TrackBrief
              tag="track·c"
              title="subscribe to events"
              note="HMAC-signed POST on call.accepted and call.resolved. Localhost / RFC1918 / metadata IPs are refused at registration AND delivery."
              cta={{ label: "openapi →", href: `${base}/v1/openapi.json` }}
              extras={
                <>
                  <FactRow label="events" value="call.accepted · call.resolved" />
                  <FactRow label="sig" value="x-murmur-signature: sha256=…" />
                  <FactRow label="reject" value="loopback · RFC1918 · CGNAT · meta-IP" />
                </>
              }
              snippets={[
                ["register", webhookCreate(base)],
                ["verify", webhookVerify()],
              ]}
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
            title="live demo · /v1/leaderboard"
            actions={
              <button
                className="ck-btn"
                onClick={runDemo}
                disabled={demoRunning}
              >
                {demoRunning ? "running…" : "run"}
              </button>
            }
          >
            <pre className="px-2 py-1 ck-mono whitespace-pre overflow-x-auto leading-tight max-h-[260px]">
              {demoErr
                ? `[err] ${demoErr}`
                : (demoOut ?? "// click run to fetch live response\n// hits /v1/leaderboard on this deployment")}
            </pre>
          </Panel>

          <Panel
            title="embed · live svg badge"
            actions={
              <button
                className="ck-btn"
                onClick={() => copy("embed", embedSnippet(base))}
              >
                {copied === "embed" ? "[copied]" : "copy"}
              </button>
            }
          >
            <pre className="px-2 py-1 ck-mono whitespace-pre overflow-x-auto leading-tight">
              {embedSnippet(base)}
            </pre>
          </Panel>

        </div>
      </main>
    </div>
  );
}

/**
 * Phase 7d — header-only variant of TrackBrief. Same heading + cta + facts
 * layout, but defers the snippet rendering to a `children` slot so Track A
 * can drop in the new CodeSnippetPanel. Bold + calm Launch variants stay
 * on the legacy TrackBrief signature (snippets passed as a `[label, body]`
 * tuple list) until the Phase 12 variant sweep.
 *
 * TODO Phase 12 dashboard polish: sweep LaunchPage.bold + LaunchPage.calm
 * to use this helper + CodeSnippetPanel for parity. The bold + calm
 * variants currently embed their own curl/ts snippet templates inline.
 */
function TrackBriefHeader({
  tag,
  title,
  note,
  cta,
  extras,
  children,
}: {
  tag: string;
  title: string;
  note: string;
  cta: { label: string; href: string };
  extras?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const external = cta.href.startsWith("http");
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
      {children && <div className="flex-1 min-h-0 flex flex-col">{children}</div>}
    </>
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
            <span className="ck-label">snippet</span>
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
              {copied === `snip-${active[0]}` ? "[copied]" : "copy"}
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
          open
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

/* ── Snippets ────────────────────────────────────────────────────────────
 * Track A's TS/PY/curl snippets live in CodeSnippetPanel. The remaining
 * track-specific snippets stay inline because their shapes are different.
 * ─────────────────────────────────────────────────────────────────── */

function readLeaderboard(base: string): string {
  return `curl "${base}/v1/leaderboard?limit=10" | jq
curl "${base}/v1/leaderboard/families/native-price?limit=10" | jq
curl "${base}/v1/markets" | jq`;
}

function readAgent(base: string): string {
  return `curl "${base}/v1/agents/<slug>" | jq
curl "${base}/v1/agents/<slug>/calls?limit=20" | jq
curl "${base}/v1/agents/<slug>/grid" | jq`;
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
