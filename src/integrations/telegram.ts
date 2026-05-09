import type Database from "better-sqlite3";
import { agentsRepo, resolutionsRepo } from "../verdict/db.js";
import {
  get24hVerifiedVolume,
  getLeaderboard,
} from "../verdict/leaderboard.js";
import { projectCallRow } from "../verdict/projections.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TelegramConfig {
  botToken?: string;
  chatId?: string;
  /** Public dashboard base URL — used in card links/claim CTAs. */
  publicBaseUrl?: string;
  /** Inject for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Override for tests. */
  now?: () => Date;
  /** Disable network sends; cards are returned but not posted. */
  dryRun?: boolean;
}

export interface PostResult {
  ok: boolean;
  text: string;
  /** When dryRun=true or in tests, no HTTP call happens — `posted` is false. */
  posted: boolean;
  reason?: string;
}

// ─── TelegramNotifier ────────────────────────────────────────────────────────

export class TelegramNotifier {
  private readonly botToken: string;
  private readonly chatId: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly dryRun: boolean;

  constructor(cfg: TelegramConfig = {}) {
    this.botToken = cfg.botToken ?? process.env.TELEGRAM_BOT_TOKEN ?? "";
    this.chatId = cfg.chatId ?? process.env.TELEGRAM_PUBLIC_CHAT_ID ?? "";
    this.baseUrl = (cfg.publicBaseUrl ?? process.env.MURMUR_PUBLIC_URL ?? "https://murmur.local").replace(/\/$/, "");
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.now = cfg.now ?? (() => new Date());
    this.dryRun = cfg.dryRun ?? (!this.botToken || !this.chatId);
  }

  isLive(): boolean {
    return !this.dryRun;
  }

  async postResolutionCard(db: Database.Database, call_id: string): Promise<PostResult> {
    const full = resolutionsRepo.loadFullCall(db, call_id);
    if (!full?.resolution) {
      return { ok: false, text: "", posted: false, reason: "call_not_resolved" };
    }
    const agent = agentsRepo.byId(db, full.submission.agent_id);
    if (!agent) return { ok: false, text: "", posted: false, reason: "agent_missing" };
    const projectionMeta = db
      .prepare(
        `SELECT s.privacy_mode, s.commit_hash, cr.reveal_hash_valid
         FROM submissions s
         LEFT JOIN call_reveals cr ON cr.call_id = s.call_id
         WHERE s.call_id = ?`,
      )
      .get(call_id) as
      | { privacy_mode: string | null; commit_hash: string | null; reveal_hash_valid: number | null }
      | undefined;
    const projected = projectCallRow({
      call_id: full.submission.call_id,
      status: full.submission.status,
      accepted_at: full.submission.accepted_at,
      privacy_mode: projectionMeta?.privacy_mode ?? null,
      commit_hash: projectionMeta?.commit_hash ?? null,
      side: full.submission.side,
      asset_id: full.submission.asset_id,
      horizon_hours: full.submission.horizon_hours,
      confidence: full.submission.confidence,
      reveal_hash_valid: projectionMeta?.reveal_hash_valid ?? null,
    });

    const lb = getLeaderboard(db);
    const rankRow = lb.find((r) => r.agent_id === agent.agent_id);
    const text = formatResolutionCard({
      agent_kind: agent.kind,
      agent_slug: agent.display_slug,
      side: projected.side as "BUY" | "SELL" | undefined,
      horizon_hours: projected.horizon_hours,
      confidence: projected.confidence,
      outcome: full.resolution.outcome,
      signed_return: Number(full.resolution.signed_return),
      call_score: full.resolution.call_score,
      // Wave 4b: receipts subsystem dropped. Card uses a short call_id
      // identifier to give readers something to chain on (the call_id
      // itself is the canonical handle).
      call_id,
      rank: rankRow?.rank ?? null,
      tier: rankRow?.tier ?? "provisional",
      call_url: `${this.baseUrl}/calls/${call_id}`,
      claim_url:
        agent.kind === "shadow"
          ? `${this.baseUrl}/agents/${agent.display_slug}/claim`
          : null,
    });
    return this.send(text);
  }

  async postDailyTop10(db: Database.Database): Promise<PostResult> {
    const rows = getLeaderboard(db, { tier: "main", limit: 10 });
    const volume = get24hVerifiedVolume(db);
    const text = formatDailyTopN({
      rows: rows.map((r) => ({
        rank: r.rank ?? 0,
        slug: r.display_slug,
        verdict_score: r.verdict_score ?? 0,
        win_rate: r.win_rate,
        resolved_calls: r.resolved_calls,
      })),
      volume_24h: volume.count,
      base_url: this.baseUrl,
      now_iso: this.nowIso(),
    });
    return this.send(text);
  }

  async postWeeklyRecap(db: Database.Database): Promise<PostResult> {
    // Last 7 days of resolved calls, grouped to surface best/worst.
    const rows = db
      .prepare(
        `SELECT a.display_slug, a.kind, r.outcome, r.call_score, r.signed_return, r.resolved_at, s.call_id
         FROM t1_resolutions r
         JOIN submissions s ON s.call_id = r.call_id
         JOIN agents a ON a.agent_id = s.agent_id
         WHERE r.resolved_at >= datetime('now', '-7 days')
           AND r.outcome IN ('win','loss')
         ORDER BY r.call_score DESC`,
      )
      .all() as Array<{
      display_slug: string;
      kind: string;
      outcome: string;
      call_score: number | null;
      signed_return: string;
      resolved_at: string;
      call_id: string;
    }>;
    const valid = rows.filter((r) => r.call_score !== null);
    const best = valid.slice(0, 3);
    const worst = valid.slice(-3).reverse();
    const calibrated = computeMostCalibrated(db);
    const text = formatWeeklyRecap({
      best: best.map((r) => ({
        slug: r.display_slug,
        signed_return: Number(r.signed_return),
        call_score: r.call_score!,
        call_id: r.call_id,
      })),
      worst: worst.map((r) => ({
        slug: r.display_slug,
        signed_return: Number(r.signed_return),
        call_score: r.call_score!,
        call_id: r.call_id,
      })),
      calibrated,
      base_url: this.baseUrl,
      now_iso: this.nowIso(),
    });
    return this.send(text);
  }

  async postClaimCta(db: Database.Database, agent_id: string): Promise<PostResult> {
    const a = agentsRepo.byId(db, agent_id);
    if (!a || a.kind !== "shadow") {
      return { ok: false, text: "", posted: false, reason: "not_a_shadow_agent" };
    }
    const text = formatClaimCta({
      slug: a.display_slug,
      identities: a.verified_identities,
      claim_url: `${this.baseUrl}/agents/${a.display_slug}/claim`,
    });
    return this.send(text);
  }

  private async send(text: string): Promise<PostResult> {
    if (this.dryRun) {
      return { ok: true, text, posted: false, reason: "dry_run" };
    }
    try {
      const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
      const res = await this.fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: this.chatId,
          text,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }),
      });
      if (!res.ok) {
        return { ok: false, text, posted: false, reason: `http_${res.status}` };
      }
      return { ok: true, text, posted: true };
    } catch (err) {
      return {
        ok: false,
        text,
        posted: false,
        reason: err instanceof Error ? err.message : "send_failed",
      };
    }
  }

  private nowIso(): string {
    return this.now().toISOString().replace(/\.\d+Z$/, "Z");
  }
}

// ─── Card formatters (pure, exported for tests) ──────────────────────────────

interface ResolutionCardArgs {
  agent_kind: string;
  agent_slug: string;
  side?: "BUY" | "SELL";
  horizon_hours?: number;
  confidence?: number;
  outcome: string;
  signed_return: number;
  call_score: number | null;
  call_id: string;
  rank: number | null;
  tier: string;
  call_url: string;
  claim_url: string | null;
}

export function formatResolutionCard(a: ResolutionCardArgs): string {
  const emoji =
    a.outcome === "win" ? "✅" : a.outcome === "loss" ? "❌" : a.outcome === "void" ? "⚪️" : "⚠️";
  const subject = a.side && a.horizon_hours && a.confidence !== undefined
    ? `${a.side} ETH ${a.horizon_hours}h @${(a.confidence * 100).toFixed(0)}%`
    : `COMMITTED SEALED`;
  const ret = (a.signed_return * 100).toFixed(2);
  const score = a.call_score === null ? "—" : a.call_score.toFixed(3);
  const rankLine = a.rank ? `#${a.rank}` : a.tier;
  // Wave 4b: receipts subsystem dropped. Surface the last 8 chars of
  // the call_id as the link label; the call_id itself is the canonical
  // handle for any follow-up lookup.
  const shortId = a.call_id.slice(-8);
  const shadowLine = a.claim_url
    ? `\n— Shadow agent. Claim this profile: ${a.claim_url}`
    : "";
  return [
    `${emoji} <b>${esc(a.agent_slug)}</b> ${subject}`,
    `→ <b>${a.outcome.toUpperCase()}</b> ${ret}%  · score ${score}  · ${rankLine}`,
    `<a href="${a.call_url}">…${shortId}</a>${shadowLine}`,
  ].join("\n");
}

interface DailyTopNArgs {
  rows: Array<{
    rank: number;
    slug: string;
    verdict_score: number;
    win_rate: number | null;
    resolved_calls: number;
  }>;
  volume_24h: number;
  base_url: string;
  now_iso: string;
}

export function formatDailyTopN(a: DailyTopNArgs): string {
  if (a.rows.length === 0) {
    return [
      `<b>📊 Murmur Verdict — Daily Top 10</b>`,
      `${esc(a.now_iso)}`,
      ``,
      `No ranked agents yet. Tag your first call <code>#MurmurCall ETH BUY 4H 72</code> on X to seed your shadow profile.`,
      ``,
      `Verified volume (24h): ${a.volume_24h}`,
    ].join("\n");
  }
  const lines = a.rows.slice(0, 10).map((r) => {
    const wr = r.win_rate === null ? "—" : `${(r.win_rate * 100).toFixed(0)}%`;
    return `<b>#${r.rank}</b> ${esc(r.slug)} · score ${r.verdict_score.toFixed(3)} · WR ${wr} · ${r.resolved_calls} calls`;
  });
  return [
    `<b>📊 Murmur Verdict — Daily Top 10</b>`,
    `${esc(a.now_iso)}`,
    ``,
    ...lines,
    ``,
    `Verified volume (24h): ${a.volume_24h}`,
    `<a href="${a.base_url}/leaderboard">Full leaderboard →</a>`,
  ].join("\n");
}

interface WeeklyRecapArgs {
  best: Array<{
    slug: string;
    signed_return: number;
    call_score: number;
    call_id: string;
  }>;
  worst: Array<{
    slug: string;
    signed_return: number;
    call_score: number;
    call_id: string;
  }>;
  calibrated: { slug: string; brier_avg: number } | null;
  base_url: string;
  now_iso: string;
}

export function formatWeeklyRecap(a: WeeklyRecapArgs): string {
  const fmt = (label: string, e: WeeklyRecapArgs["best"][number]) =>
    `${label} <b>${esc(e.slug)}</b> · ${(e.signed_return * 100).toFixed(2)}% · score ${e.call_score.toFixed(3)} · <a href="${a.base_url}/calls/${e.call_id}">→</a>`;
  return [
    `<b>🏆 Murmur Verdict — Weekly Recap</b>`,
    `${esc(a.now_iso)}`,
    ``,
    `<b>Best calls</b>`,
    ...a.best.map((e, i) => fmt(`${i + 1}.`, e)),
    ``,
    `<b>Biggest blowups</b>`,
    ...a.worst.map((e, i) => fmt(`${i + 1}.`, e)),
    ``,
    a.calibrated
      ? `<b>Most calibrated</b>: ${esc(a.calibrated.slug)} (avg Brier ${a.calibrated.brier_avg.toFixed(3)})`
      : `<b>Most calibrated</b>: insufficient data`,
    ``,
    `<a href="${a.base_url}/leaderboard">Leaderboard →</a>`,
  ].join("\n");
}

interface ClaimCtaArgs {
  slug: string;
  identities: ReadonlyArray<{ kind: string; value: string }>;
  claim_url: string;
}

export function formatClaimCta(a: ClaimCtaArgs): string {
  const idLines = a.identities.map((i) => `${i.kind}: ${esc(i.value)}`).join(" · ");
  return [
    `🪪 <b>Shadow profile open: ${esc(a.slug)}</b>`,
    `Identity: ${idLines}`,
    ``,
    `Claim it to make wins count toward the leaderboard, unlock the API, and earn distribution.`,
    `<a href="${a.claim_url}">Claim →</a>`,
  ].join("\n");
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function computeMostCalibrated(
  db: Database.Database,
): { slug: string; brier_avg: number } | null {
  // Per-agent average squared (p − y) over the last 7 days, lower is better,
  // restricted to agents with ≥5 win/loss outcomes in the window.
  const rows = db
    .prepare(
      `SELECT a.display_slug AS slug, s.confidence, r.outcome
       FROM t1_resolutions r
       JOIN submissions s ON s.call_id = r.call_id
       JOIN agents a ON a.agent_id = s.agent_id
       WHERE r.resolved_at >= datetime('now', '-7 days')
         AND r.outcome IN ('win','loss')`,
    )
    .all() as Array<{ slug: string; confidence: number; outcome: "win" | "loss" }>;
  type Bucket = { sum: number; count: number };
  const byAgent = new Map<string, Bucket>();
  for (const r of rows) {
    const y = r.outcome === "win" ? 1 : 0;
    const sq = (r.confidence - y) ** 2;
    const b = byAgent.get(r.slug) ?? { sum: 0, count: 0 };
    b.sum += sq;
    b.count += 1;
    byAgent.set(r.slug, b);
  }
  let best: { slug: string; brier_avg: number } | null = null;
  for (const [slug, b] of byAgent.entries()) {
    if (b.count < 5) continue;
    const brier = b.sum / b.count;
    if (!best || brier < best.brier_avg) best = { slug, brier_avg: brier };
  }
  return best;
}
