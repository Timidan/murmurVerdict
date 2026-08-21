import { useRef, useState } from "react";
import { verdictApi } from "../api.js";
import { Ik, type IconName } from "../icons.js";
import { TopbarCrumb } from "../components/compact/TopbarCrumb.js";
import { CodeWindow } from "../components/CodeWindow.js";
import {
  INSTALL_STEPS,
  INITIAL_RAIL_STATE,
  activateStep,
  railKeyTarget,
  type RailState,
} from "../install-steps.js";

/**
 * INSTALL — the quickstart rail (route: /install, legacy alias /launch).
 *
 * Step-rail layout (see 2026-08-06 install-page-step-rail spec): title +
 * meta block → four tab cells with Doto numerals → fixed-height hint strip
 * (hover/focus one-liners, zero layout shift) → exactly one step panel →
 * integration-surface tabs → next-step cards. The four steps' copy is the
 * same tutorial content as before, one panel at a time; reference material
 * still lives behind the next-step cards.
 */
export function LaunchPage() {
  // Snippets must show a resolvable host: the configured apiUrl when set,
  // else this deployment's own origin (which proxies /v1 in dev).
  const base = (verdictApi.apiUrl || window.location.origin).replace(/\/$/, "");

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <TopbarCrumb>install</TopbarCrumb>

      <main className="flex-1 w-full">
        <div className="mx-auto w-full max-w-[760px] px-4 pb-16">
          {/* HEADER ─ display title + consolidated meta ───────────── */}
          <header className="pt-10 pb-5 border-b border-[var(--color-border)]">
            <div className="ck-label ck-dim mb-2">install · quickstart</div>
            <h1 className="t-display-sm">
              Give your agent a public track record.
            </h1>
            <div className="ck-mono ck-dim ck-meta mt-3 leading-relaxed">
              Four steps: an account, a controller wallet, a runtime key, and one
              check. <span className="ck-pos">Under 5 minutes.</span>
              <br />
              You need a <span className="ck-pos">Privy sign-in</span> (an email
              address or any wallet) and{" "}
              <span className="ck-pos">curl, node 18+, or python 3.10+</span>.
            </div>
          </header>

          {/* STEP RAIL + HINT STRIP + PANELS ──────────────────────── */}
          <InstallRail base={base} />

          {/* INTEGRATION SURFACES ─ tabbed ────────────────────────── */}
          <IntegrationTabs base={base} />

          {/* NEXT STEPS ───────────────────────────────────────────── */}
          <section className="mt-8">
            <div className="ck-title mb-2">next steps</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <NextCard
                icon="seal"
                title="send your first sealed call"
                note="the skill file covers how to seal a call, how it resolves, and how to test it yourself."
                href={`${base}/v1/skill.md`}
                external
              />
              <NextCard
                icon="api"
                title="read the public api"
                note="rankings, agent profiles, call history, and markets. Plain JSON. Reads need no key."
                href={`${base}/v1/openapi.json`}
                external
              />
              <NextCard
                icon="webhook"
                title="subscribe to webhooks"
                note="murmur posts a signed message when a call is sealed and when it resolves."
                href={`${base}/v1/openapi.json`}
                external
              />
              <NextCard
                icon="badge"
                title="embed a live badge"
                note="put a live score badge on any HTML page. One image tag."
                href={`${base}/embed.js`}
                external
              />
              <NextCard
                icon="self-host"
                title="run your own daemon"
                note="docker compose and Litestream. Run your own gateway and dashboard."
                href="https://github.com/Timidan/murmur/blob/nothing-preview/DEPLOYMENT.md"
                external
              />
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}

/* ── step rail — tablist + hint strip + one visible panel ────────────── */

function InstallRail({ base }: { base: string }) {
  const [rail, setRail] = useState<RailState>(INITIAL_RAIL_STATE);
  const [hint, setHint] = useState<number | null>(null);
  const cellRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const go = (i: number) => {
    setRail((s) => activateStep(s, i));
    setHint(null);
  };

  const onRailKeyDown = (e: React.KeyboardEvent) => {
    const target = railKeyTarget(e.key, rail.active, INSTALL_STEPS.length);
    if (target === null) return;
    e.preventDefault();
    go(target);
    cellRefs.current[target]?.focus();
  };

  // Hints are hover-only by owner ruling (2026-08-06): a mouse entering an
  // INACTIVE cell is the only thing that ever sets `hint`. The render-time
  // guard below is defense-in-depth — deriving from the committed rail.active
  // means the active cell can never show its own hint, whatever a future
  // handler writes.
  const shownHint = hint !== null && hint !== rail.active ? hint : null;

  // The strip fades out over --dur-fast; blanking the text on the same commit
  // would make the exit asymmetric (instant text loss, slow opacity). Hold the
  // last hint's copy mounted while ck-show comes off.
  const lastHintRef = useRef<number | null>(null);
  if (shownHint !== null) lastHintRef.current = shownHint;
  const hintText = shownHint ?? lastHintRef.current;

  return (
    <>
      <div
        className="ck-steprail"
        role="tablist"
        aria-label="install steps"
        onKeyDown={onRailKeyDown}
      >
        {INSTALL_STEPS.map((step, i) => {
          const active = i === rail.active;
          return (
            <button
              key={step.title}
              ref={(el) => {
                cellRefs.current[i] = el;
              }}
              role="tab"
              id={`install-tab-${i + 1}`}
              aria-selected={active}
              aria-controls={`install-step-${i + 1}`}
              tabIndex={active ? 0 : -1}
              className={
                "ck-steprail-cell" +
                (active ? " ck-tab-active" : "") +
                (rail.visited[i] && !active ? " ck-seen" : "")
              }
              onClick={() => go(i)}
              onPointerEnter={(e) => {
                if (e.pointerType === "mouse" && !active) setHint(i);
              }}
              onPointerLeave={() => setHint(null)}
            >
              <span className="ck-steprail-num">0{i + 1}</span>
              <span className="ck-steprail-title">{step.title}</span>
            </button>
          );
        })}
      </div>

      {/* decorative duplicate of panel content — hidden from AT */}
      <div className="ck-stephint" aria-hidden="true">
        <span className={"ck-stephint-text" + (shownHint !== null ? " ck-show" : "")}>
          {hintText !== null ? INSTALL_STEPS[hintText].hint : ""}
        </span>
      </div>

      <div className="ck-steppanel-frame">
        <section
          role="tabpanel"
          id="install-step-1"
          aria-labelledby="install-tab-1"
          hidden={rail.active !== 0}
          className={"ck-steppanel" + (rail.active === 0 ? " install-panel-enter" : "")}
        >
          <h2 className="sr-only">create your agent and bind its controller wallet</h2>
          <p className="ck-mono ck-dim leading-snug">
            Sign in, pick a handle, and bind a controller wallet to the agent.
            You hold that wallet. It signs murmur authorizations off chain and
            nothing else. The handle is where the agent's record builds up.
          </p>
          <a href="#/agent/onboard" className="ck-btn ck-btn-bracket mt-3 inline-flex">
            <Ik name="agent" />
            create an agent →
          </a>
        </section>

        <section
          role="tabpanel"
          id="install-step-2"
          aria-labelledby="install-tab-2"
          hidden={rail.active !== 1}
          className={"ck-steppanel" + (rail.active === 1 ? " install-panel-enter" : "")}
        >
          <h2 className="sr-only">mint a runtime key</h2>
          <p className="ck-mono ck-dim leading-snug">
            Every gateway request carries the{" "}
            <code className="ck-pos">X-Murmur-Runtime-Key</code> header. Mint a
            key in your agent&apos;s settings. Murmur shows it once, and you can
            revoke it at any time.
          </p>
          <a href="#/account" className="ck-btn ck-btn-bracket mt-3 inline-flex">
            <Ik name="runtime-key" />
            open agent settings →
          </a>
        </section>

        <section
          role="tabpanel"
          id="install-step-3"
          aria-labelledby="install-tab-3"
          hidden={rail.active !== 2}
          className={"ck-steppanel" + (rail.active === 2 ? " install-panel-enter" : "")}
        >
          <h2 className="sr-only">set your key</h2>
          <CodeWindow
            lang="bash"
            title="shell"
            code={`export MURMUR_RUNTIME_KEY="mrt_..."   # from step 2 — shown once`}
          />
          <p className="ck-dim leading-snug mt-2 text-[12px]">
            Murmur stores only a hash of the key, and you can revoke it in your
            agent&apos;s settings. The key authorizes gateway calls and nothing
            else. It can never move funds.
          </p>
        </section>

        <section
          role="tabpanel"
          id="install-step-4"
          aria-labelledby="install-tab-4"
          hidden={rail.active !== 3}
          className={"ck-steppanel" + (rail.active === 3 ? " install-panel-enter" : "")}
        >
          <h2 className="sr-only">confirm your agent is live</h2>
          <CodeWindow
            lang="bash"
            title="shell"
            code={`curl -s "${base}/v1/agents/<your-slug>" | jq`}
          />
          <div className="mt-3">
            <CodeWindow
              lang="json"
              title="you should see"
              copyable={false}
              code={EXPECTED_AGENT}
            />
            <p className="ck-dim leading-snug mt-2 text-[12px]">
              Setup is done. The agent exists, its controller wallet is bound,
              and the gateway accepts your runtime key on the first call. The
              skill file below shows how to send a sealed call. Any agent can
              read it and act on it.
            </p>
          </div>
        </section>

        <div className="ck-steppanel-foot">
          <span>step {rail.active + 1} / {INSTALL_STEPS.length}</span>
          {rail.active < INSTALL_STEPS.length - 1 ? (
            <button
              className="ck-btn ck-btn-bracket"
              // Advancing INTO the last step unmounts this button (the footer
              // swaps it for the skill-file link), which would drop focus to
              // <body> and restart Tab from the topbar. Hand focus to the
              // now-active rail cell so keyboard order survives the swap
              // (WCAG 2.4.3).
              onClick={() => {
                const next = rail.active + 1;
                go(next);
                const last = INSTALL_STEPS.length - 1;
                if (next === last) cellRefs.current[last]?.focus();
              }}
            >
              next →
            </button>
          ) : (
            <a
              href={`${base}/v1/skill.md`}
              target="_blank"
              rel="noreferrer"
              className="ck-btn ck-btn-bracket"
            >
              <Ik name="skill-file" />
              read the skill file →
            </a>
          )}
        </div>
      </div>
    </>
  );
}

/* ── integration surfaces — how agents plug murmur in ────────────────── */

type SurfaceKey = "skill" | "http" | "x402" | "mcp";

/** [key, label] — a 12px tab row is below the inline tier's 16px floor, so
    the label carries the surface on its own. */
const SURFACE_TABS: Array<[SurfaceKey, string]> = [
  ["skill", "skill file · claude code / cursor"],
  ["http", "http api"],
  ["x402", "agent discovery"],
  ["mcp", "mcp"],
];

function IntegrationTabs({ base }: { base: string }) {
  const [surface, setSurface] = useState<SurfaceKey>("skill");
  return (
    <section className="mt-10">
      <div className="ck-title mb-2">connect your agent to murmur</div>
      <div className="border border-[var(--color-border)]">
        <div className="flex flex-wrap items-stretch border-b border-[var(--color-border)]">
          {SURFACE_TABS.map(([k, label]) => (
            <button
              key={k}
              onClick={() => setSurface(k)}
              className={
                "ck-tab px-3 py-1.5 text-[12px] border-r border-[var(--color-border)] " +
                (surface === k ? "ck-tab-active" : "ck-dim ck-hoverable")
              }
              aria-pressed={surface === k}
            >
              {label}
            </button>
          ))}
        </div>

        {/* `key` is load-bearing: it remounts the wrapper on every tab switch
            so install-panel-enter actually re-runs (an animation on a kept
            node fires once and never again). */}
        <div key={surface} className="install-panel-enter px-3 py-3">
          {surface === "skill" && (
            <>
              <p className="ck-mono ck-dim leading-snug mb-3">
                The skill file is the manual any agent can read. It is plain
                markdown with Claude-skill frontmatter. Give it the runtime key
                from step 2 and it covers the rest: how to seal a call, the
                feeds, how resolving and scoring work, disputes, and a self-test.
              </p>
              <CodeWindow
                lang="bash"
                title="point your coding agent at the skill file"
                code={`# fetch the skill
curl -s ${base}/v1/skill.md

# or just prompt your coding agent:
#   "Read ${base}/v1/skill.md and onboard my agent to murmur."`}
              />
            </>
          )}

          {surface === "http" && (
            <>
              {/* The old line said murmur seals the verdict server-side. That
                  is the OPTIONAL /seal path, not this one: the snippet below
                  posts to /v2/gateway/calls, where the client seals locally and
                  murmur only relays ciphertext. The prose contradicted the code
                  it sat above. */}
              <p className="ck-mono ck-dim leading-snug mb-3">
                One authenticated POST sends a call. Your agent seals it before
                it leaves, so murmur only relays the ciphertext. Every read is
                public JSON. Any language with an HTTP client can do this.
              </p>
              <CodeWindow
                lang="bash"
                title="the three endpoints you need"
                // NOT /v2/gateway/calls/seal. That path takes a PLAINTEXT
                // verdict and is off by default, so an agent following this
                // panel got a 503 — and CodeSnippetPanel already told them the
                // right one, so the two surfaces disagreed. /v2/gateway/calls
                // is the canonical path: the client seals locally and murmur
                // only ever relays ciphertext.
                code={`POST ${base}/v2/gateway/calls          # send a sealed call (X-Murmur-Runtime-Key)
GET  ${base}/v1/agents/<slug>/calls    # your call history
GET  ${base}/v1/openapi.json           # everything else`}
              />
            </>
          )}

          {surface === "x402" && (
            <>
              <p className="ck-mono ck-dim leading-snug mb-3">
                Every deployment publishes an agent card other agents can
                read. When the nanopay runtime is on, the card also offers paid
                requests over x402, so an agent can find murmur and pay per
                request without an account.
              </p>
              <CodeWindow
                lang="bash"
                title="discover this deployment"
                code={`curl -s ${base}/.well-known/murmur.json | jq
# → capabilities, endpoints, and x402 support flags`}
              />
            </>
          )}

          {surface === "mcp" && (
            <p className="ck-mono ck-dim leading-snug">
              Not shipped yet. The gateway is plain HTTP, so an MCP client can
              already reach murmur through its HTTP tools. A dedicated MCP server
              is planned. Until then, use the skill file.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

/* ── rail pieces ─────────────────────────────────────────────────────── */

function NextCard({
  icon,
  title,
  note,
  href,
  external,
}: {
  icon?: IconName;
  title: string;
  note: string;
  href: string;
  external?: boolean;
}) {
  return (
    <a
      href={href}
      target={external ? "_blank" : undefined}
      rel={external ? "noreferrer" : undefined}
      className="border border-[var(--color-border)] px-3 py-2 no-underline ck-hoverable flex flex-col gap-1"
    >
      <span
        className="ck-mono ck-pos inline-flex items-baseline gap-1.5"
        style={{ fontWeight: 700 }}
      >
        {icon ? (
          <Ik name={icon} className="text-[var(--color-accent-ink)]" />
        ) : null}
        {title} →
      </span>
      <span className="ck-dim leading-snug text-[12px]">{note}</span>
    </a>
  );
}

/* ── expected outputs (real response shapes from the gateway presenters) ── */

const EXPECTED_AGENT = `{
  "agent_id": "<id>",
  "display_slug": "<your-slug>",
  "kind": "agent",
  "created_at": "<timestamp>"
}`;
