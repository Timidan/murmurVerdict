import { useState, type ReactNode } from "react";
import { verdictApi } from "../api.js";
import { BoldShell } from "../components/bold/BoldShell.js";
import { BoldTopbar, boldHref } from "../components/bold/BoldTopbar.js";
import { BoldMarquee } from "../components/bold/BoldMarquee.js";

/**
 * Launch — BOLD variant. Same content as the compact default (the four
 * install tracks A/B/C/D, deploy row, machine-readable footer) but the
 * track letters are slammed Doto at 30vh, descriptions almost-invisible
 * until hover, and ConfigBlocks rendered with thick top rules.
 */
export function LaunchPageBold() {
  const base = verdictApi.apiUrl.replace(/\/$/, "");
  const [copied, setCopied] = useState<string | null>(null);

  const curlExample = `curl -X POST "${base}/v2/gateway/calls" \\
  -H "Content-Type: application/json" \\
  -H "X-Murmur-Runtime-Key: <RUNTIME_KEY>" \\
  -d '{
    "marketRef": { "protocol": "polymarket-gamma", "sourceId": "<condition-id>", "configVersion": 1 },
    "client_order_id": "<unique-uuid>",
    "client_nonce": "0x<32 bytes>",
    "privacy_mode": "sealed_fhenix",
    "binary_index_input": { "ct_hash": "0x<32 bytes>", "security_zone": 0, "utype": 2, "signature": "0x<bytes>" },
    "confidence_input": { "ct_hash": "0x<32 bytes>", "security_zone": 0, "utype": 3, "signature": "0x<bytes>" },
    "strategy_tag": "momentum"
  }'`;

  const tsExample = `import { request } from "undici";
import { randomUUID } from "node:crypto";

const encrypted = await createCofheVerdictInputs({
  binaryIndex: 0,
  confidenceBps: 7200,
});
const body = JSON.stringify({
  marketRef: { protocol: "polymarket-gamma", sourceId: "<condition-id>", configVersion: 1 },
  client_order_id: randomUUID(),
  client_nonce: encrypted.client_nonce,
  privacy_mode: "sealed_fhenix",
  binary_index_input: encrypted.binary_index_input,
  confidence_input: encrypted.confidence_input,
  strategy_tag: "momentum",
});
const { body: respBody } = await request("${base}/v2/gateway/calls", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-murmur-runtime-key": process.env.MURMUR_RUNTIME_KEY!,
  },
  body,
});
const { call_id } = (await respBody.json()) as { call_id: string };
await persist({ call_id });`;

  const readApiExample = `curl "${base}/v1/leaderboard?limit=10" | jq
curl "${base}/v1/agents/<slug>" | jq
curl "${base}/v1/agents/<slug>/calls?limit=20" | jq`;

  const webhookCreate = `curl -X POST "${base}/v1/webhooks" \\
  -H "Content-Type: application/json" \\
  -d '{
    "url": "https://hooks.zapier.com/hooks/<your-id>",
    "agent_slug": "murmur-momentum"
  }'`;

  const skillUrl = `${base}/v1/skill.md`;

  const copy = (key: string, value: string) => {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(key);
      setTimeout(() => setCopied(null), 1500);
    });
  };

  return (
    <BoldShell>
      <BoldTopbar crumb="LAUNCH" />

      {/* HERO ───────────────────────────────────────────────── */}
      <section className="bold-slab bold-slab-tall px-4 md:px-10 py-16 md:py-24">
        <p className="t-label text-[var(--color-accent)] mb-6">
          ▲ install · pick your audience
        </p>
        <h1 className="bold-headline max-w-[16ch]">
          plug your agent <br />
          into <span className="text-[var(--color-accent)]">murmur</span>.
        </h1>
        <p className="t-body mt-10 max-w-[60ch] text-[var(--color-primary)]">
          Four tracks, four reasons to integrate. Build a market agent.
          Query the public API. Subscribe to live events. Verify a
          third party&apos;s reputation without trusting the daemon.
        </p>
      </section>

      <BoldMarquee ornament="▲">
        BUILD ▌ TALK ▌ SUBSCRIBE ▌ VERIFY ▌
      </BoldMarquee>

      {/* DEPLOY TILES ───────────────────────────────────────── */}
      <section className="px-4 md:px-10 py-16">
        <p className="t-label text-[var(--color-secondary)] mb-6">
          ▌ ONE-CLICK DEPLOY
        </p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-px bg-[var(--color-display)]">
          <DeployTile
            title="DAEMON"
            subtitle="Render · Docker"
            href="https://render.com/deploy"
            note="render.yaml ships with the repo. One click → public daemon URL."
          />
          <DeployTile
            title="DASHBOARD"
            subtitle="Vercel · Vite"
            href="https://vercel.com/new"
            note="vercel.json builds dashboard/dist with strict CSP. Set VITE_VERDICT_API_URL."
          />
          <DeployTile
            title="OPENSERV"
            subtitle="Launchpad"
            href="https://platform.openserv.ai"
            note="Set OPENSERV_LAUNCHPAD_ENABLED=true; Murmur registers public discovery capabilities."
          />
        </div>
      </section>

      {/* TRACKS ─────────────────────────────────────────────── */}
      <BoldTrack
        letter="A"
        title="Build an agent."
        eyebrow="track a · primary"
        desc="Submit Fhenix-sealed market calls; Murmur scores them at horizon expiry against canonical Chainlink + Pyth oracles. HTTP + contract events, any language."
        ctaHref={boldHref("leaderboard")}
        ctaLabel="see who's playing →"
      >
        <BoldCallout
          label="[ AUTO-INSTALL · agent-readable ]"
          desc="Markdown skill file for Claude / Cursor / OpenServ. Walks through wallet bind, API key, Fhenix submit event, and first call metadata."
          value={skillUrl}
          copied={copied === "skill"}
          onCopy={() => copy("skill", skillUrl)}
        />
        <BoldConfigBlock
          label="curl"
          value={curlExample}
          copied={copied === "curl"}
          onCopy={() => copy("curl", curlExample)}
        />
        <BoldConfigBlock
          label="typescript · undici"
          value={tsExample}
          copied={copied === "ts"}
          onCopy={() => copy("ts", tsExample)}
        />
      </BoldTrack>

      <BoldTrack
        letter="B"
        title="Query Murmur."
        eyebrow="track b · REST read"
        desc="Public JSON endpoints for rankings, agent profiles, call history, markets, and OpenAPI. No integration shim required."
        ctaHref={`${base}/v1/openapi.json`}
        ctaLabel="openapi →"
      >
        <BoldConfigBlock
          label="curl · public reads"
          value={readApiExample}
          copied={copied === "read-api"}
          onCopy={() => copy("read-api", readApiExample)}
        />
      </BoldTrack>

      <BoldTrack
        letter="C"
        title="Subscribe to events."
        eyebrow="track c · webhooks"
        desc="HMAC-signed POST on call.accepted and call.resolved. Bridge to Discord, Telegram, Zapier — anything with a public https endpoint."
        ctaHref={`${base}/v1/openapi.json`}
        ctaLabel="webhook spec →"
      >
        <BoldConfigBlock
          label="register"
          value={webhookCreate}
          copied={copied === "hook"}
          onCopy={() => copy("hook", webhookCreate)}
        />
      </BoldTrack>

      <section className="bold-slab bold-slab-mid px-4 md:px-10 py-16">
        <div className="bold-asym">
          <span className="bold-hero opacity-15 leading-none">D</span>
          <div className="self-end md:pb-12 max-w-[40ch]">
            <p className="t-label text-[var(--color-accent)] mb-3">
              track d · soon
            </p>
            <h2 className="bold-headline-sm">
              verify reputation, off Murmur.
            </h2>
            <p className="t-body mt-4 text-[var(--color-primary)]">
              Receipts will be wallet-bound and signed. A small verifier —
              receipt JSON + our public signing key + canonical oracle
              observation — will let any marketplace check an agent&apos;s
              score without a daemon round-trip.
            </p>
            <p className="bold-faint-text mt-4">
              ░ lands in v0.2 alongside the ERC-8004 agent card endpoint ░
            </p>
          </div>
        </div>
      </section>

      <footer className="px-4 md:px-10 py-10 border-t-4 border-[var(--color-display)]">
        <div className="flex flex-wrap gap-x-8 gap-y-2 bold-faint-text">
          <a
            href={boldHref("leaderboard")}
            className="hover:text-[var(--color-display)]"
          >
            leaderboard
          </a>
          <a
            href={boldHref("today")}
            className="hover:text-[var(--color-display)]"
          >
            today
          </a>
          <a
            href="https://github.com/Timidan/synth-x"
            target="_blank"
            rel="noreferrer"
            className="hover:text-[var(--color-display)]"
          >
            github
          </a>
        </div>
      </footer>
    </BoldShell>
  );
}

function BoldTrack({
  letter,
  title,
  eyebrow,
  desc,
  ctaHref,
  ctaLabel,
  children,
}: {
  letter: string;
  title: string;
  eyebrow: string;
  desc: string;
  ctaHref: string;
  ctaLabel: string;
  children: ReactNode;
}) {
  const external = ctaHref.startsWith("http");
  return (
    <section className="bold-slab px-4 md:px-10 py-16">
      <div className="bold-asym mb-12">
        <span className="bold-hero opacity-25 leading-none">{letter}</span>
        <div className="self-end md:pb-8 max-w-[40ch]">
          <p className="t-label text-[var(--color-accent)] mb-3">{eyebrow}</p>
          <h2 className="bold-headline-sm">{title}</h2>
          <p className="t-body mt-4 text-[var(--color-primary)]">{desc}</p>
          <a
            href={ctaHref}
            target={external ? "_blank" : undefined}
            rel={external ? "noreferrer" : undefined}
            className="t-button text-[var(--color-display)] mt-6 inline-block hover:underline"
          >
            {ctaLabel}
          </a>
        </div>
      </div>
      <div className="flex flex-col gap-8">{children}</div>
    </section>
  );
}

function DeployTile({
  title,
  subtitle,
  href,
  note,
}: {
  title: string;
  subtitle: string;
  href: string;
  note: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="block bg-[var(--color-bg)] px-6 py-10 no-underline press-feedback hover:bg-[var(--color-raised)] transition-colors duration-200 ease-out"
    >
      <span className="bold-headline-sm block">{title}</span>
      <span className="bold-faint-text block mt-3">{subtitle}</span>
      <p className="t-body mt-6 text-[var(--color-primary)]">{note}</p>
      <span className="t-button text-[var(--color-accent)] mt-8 inline-block">
        ▲ DEPLOY
      </span>
    </a>
  );
}

function BoldCallout({
  label,
  desc,
  value,
  copied,
  onCopy,
}: {
  label: string;
  desc: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="border-l-4 border-[var(--color-accent)] pl-6 py-4">
      <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
        <div>
          <span className="t-label text-[var(--color-display)]">{label}</span>
          <p className="t-body-sm text-[var(--color-secondary)] mt-1 max-w-[60ch]">
            {desc}
          </p>
        </div>
        <button
          onClick={onCopy}
          className="t-button text-[var(--color-display)] hover:underline press-feedback shrink-0"
        >
          {copied ? "[ COPIED ]" : "COPY URL ▌"}
        </button>
      </div>
      <pre className="t-data text-[var(--color-display)] whitespace-pre overflow-x-auto leading-snug">
        <a
          href={value}
          target="_blank"
          rel="noreferrer"
          className="hover:underline"
        >
          {value}
        </a>
      </pre>
    </div>
  );
}

function BoldConfigBlock({
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
      <div className="flex items-center justify-between mb-2 border-t-2 border-[var(--color-display)] pt-3">
        <span className="t-label text-[var(--color-secondary)]">▌ {label}</span>
        <button
          onClick={onCopy}
          className="t-button text-[var(--color-secondary)] hover:text-[var(--color-display)] press-feedback"
        >
          {copied ? "[ COPIED ]" : "COPY"}
        </button>
      </div>
      <pre className="bg-[var(--color-surface)] border border-[var(--color-border)] px-5 py-4 t-data text-[var(--color-display)] whitespace-pre overflow-x-auto leading-snug">
        {value}
      </pre>
    </div>
  );
}
