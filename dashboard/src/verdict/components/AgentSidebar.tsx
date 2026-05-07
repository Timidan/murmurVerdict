import type { LeaderboardRow } from "../api.js";

export interface SidebarAgent {
  id: string;
  rank: string;
  slug: string;
  name: string;
  delta: string;
  /** Has at least one pending call. */
  live: boolean;
  /** Trending down — render delta in accent. */
  declining: boolean;
}

interface AgentSidebarProps {
  groups: Array<{
    label: string;
    agents: SidebarAgent[];
  }>;
  activeSlug?: string;
}

/**
 * 240px Devin-style agent rail. Section headers in Space Mono caption,
 * rows with rank / name / delta. Active row gets `--surface-raised` bg
 * + 2px accent left bar (canonical Nothing data-grid).
 *
 * Live agents have a small accent square appended to their name; the
 * square breathes only on `prefers-reduced-motion: no-preference`.
 */
export function AgentSidebar({ groups, activeSlug }: AgentSidebarProps) {
  return (
    <nav
      aria-label="Ranked agents"
      className={
        "border-r border-[var(--color-border)] bg-[var(--color-surface)] " +
        "py-4 overflow-y-auto"
      }
    >
      {groups.map((group, gi) => (
        <section key={group.label} className={gi > 0 ? "mt-4" : ""}>
          <h2 className="t-label px-4 pb-2">
            {group.label} <span className="text-[var(--color-disabled)]">· {group.agents.length}</span>
          </h2>
          <ul className="m-0 p-0 list-none">
            {group.agents.map((a) => (
              <SidebarRow key={a.id} agent={a} active={a.slug === activeSlug} />
            ))}
          </ul>
        </section>
      ))}
    </nav>
  );
}

function SidebarRow({ agent, active }: { agent: SidebarAgent; active: boolean }) {
  return (
    <li className="m-0 p-0">
      <a
        href={`#/agents/${agent.slug}`}
        aria-current={active ? "page" : undefined}
        className={
          "grid grid-cols-[28px_1fr_auto] gap-3 items-center px-4 py-3 " +
          "min-h-[44px] no-underline border-l-2 press-feedback " +
          "transition-colors duration-200 ease-out " +
          (active
            ? "bg-[var(--color-raised)] border-[var(--color-accent)]"
            : "border-transparent hover:bg-[white]/[0.02]")
        }
      >
        <span
          className={
            "font-mono text-[13px] " +
            (active ? "text-[var(--color-accent)]" : "text-[var(--color-disabled)]")
          }
        >
          {agent.rank}
        </span>
        <span className="text-[14px] font-medium text-[var(--color-display)] truncate">
          {agent.name}
          {agent.live && (
            <span
              aria-hidden
              className="inline-block w-[5px] h-[5px] bg-[var(--color-accent)] ml-2 align-middle nothing-live"
            />
          )}
        </span>
        <span
          className={
            "font-mono text-[13px] " +
            (active
              ? "text-[var(--color-accent)]"
              : agent.declining
              ? "text-[var(--color-accent)]"
              : "text-[var(--color-secondary)]")
          }
        >
          {agent.delta}
        </span>
      </a>
    </li>
  );
}

/** Group leaderboard rows by tier and trend. The grouping is purely
 *  cosmetic for the sidebar; the leaderboard endpoint already enforces
 *  tier semantics. */
export function buildSidebarGroups(rows: LeaderboardRow[]): AgentSidebarProps["groups"] {
  const main: SidebarAgent[] = [];
  const provisional: SidebarAgent[] = [];
  const declining: SidebarAgent[] = [];

  for (const row of rows) {
    const score = row.verdict_score;
    const formatted: SidebarAgent = {
      id: row.agent_id,
      rank: row.rank ? String(row.rank).padStart(2, "0") : "—",
      slug: row.display_slug,
      name: row.display_name,
      delta:
        score === null
          ? "—"
          : score >= 0
          ? `+${formatScore(score)}`
          : `−${formatScore(-score)}`,
      live: row.pending_calls > 0,
      declining: score !== null && score < 0,
    };
    if (formatted.declining) {
      declining.push(formatted);
    } else if (row.tier === "main") {
      main.push(formatted);
    } else {
      provisional.push(formatted);
    }
  }

  const groups: AgentSidebarProps["groups"] = [];
  if (main.length) groups.push({ label: "main", agents: main });
  if (provisional.length) groups.push({ label: "provisional", agents: provisional });
  if (declining.length) groups.push({ label: "declining", agents: declining });
  return groups;
}

function formatScore(s: number): string {
  // 3-digit centi-units (e.g. 218 for 0.218). Matches the v14 mockup.
  return Math.round(s * 1000).toString();
}
