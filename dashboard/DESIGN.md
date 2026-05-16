# Murmur Verdict — Dashboard Design Spec

> **Status**: living working spec for branch `nothing-preview`. This is what's in the tree right now plus what's still missing. Update on landing structural UI changes — don't let this rot.
>
> **Source of truth for visuals**: `dashboard/src/styles.css` + `dashboard/src/verdict/styles/{compact,bold,calm}.css`. If this doc disagrees with CSS, CSS wins.

---

## 1. Design philosophy

Five principles. If a screen breaks one, the screen is wrong.

1. **Subtract, don't add.** Every element earns its pixel. Default to removal.
2. **Structure is ornament.** The grid, the data, the hierarchy itself are the visuals.
3. **Monochrome is the canvas.** Color is an event, not a default. Only data status (win/loss/void) and the single brand-red interrupt break this. The canvas is monochrome in both themes (dark OLED black + paper cream); the interrupt red is pinned across themes.
4. **Type does the heavy lifting.** Scale + weight + spacing build hierarchy. Not color, not icons, not shadows.
5. **Industrial warmth.** Technical and precise. A human hand should still be felt — never sterile.

Compact-first. Bold and calm are A/B siblings gated by `?variant=bold|calm` for marketing experiments. Compact is what the user sees by default.

---

## 2. Tokens (canonical)

All values from `dashboard/src/styles.css` `@theme` block.

### 2.1 Fonts

| Family | Var | Use | Constraint |
|---|---|---|---|
| **Doto** | `--font-display` | Display only — hero counters, mega numerals | **36px+ only** (Nothing discipline; Ndot 57 stand-in via Google Fonts variable axis) |
| **Space Grotesk** | `--font-sans` | UI, body, headings | Default sans |
| **Space Mono** | `--font-mono` | Labels, data, ALL CAPS chrome, every numeric value | All caps for labels; `font-variant-numeric: tabular-nums` for data |

Loaded via Google Fonts in `dashboard/index.html:14-17`. No fontsource package — Doto needs the variable axis only Google serves.

### 2.2 Colors (dual theme: dark + paper)

Two themes share the same CSS-variable surface. Dark is the default. Paper is activated by `<html data-theme="paper">`. The accent red is the SAME hex in both themes — pinned for brand emphasis.

| Var | Dark | Paper | Use |
|---|---|---|---|
| `--color-bg` | `#000000` | `#FCF9F2` | Canvas |
| `--color-surface` | `#111111` | `#F4EFE5` | Card/panel surface (rare) |
| `--color-raised` | `#1A1A1A` | `#EAE3D3` | Raised surface (rarer) |
| `--color-border` | `#222222` | `#D8D2C8` | Hairline divider |
| `--color-border-vis` | `#333333` | `#B8AE99` | Visible/interactive border |
| `--color-disabled` | `#666666` | `#A39A85` | Disabled, timestamps, hints |
| `--color-secondary` | `#999999` | `#6B6453` | Labels, captions, metadata |
| `--color-primary` | `#E8E8E8` | `#1F1B14` | Body text |
| `--color-display` | `#FFFFFF` | `#0A0A0A` | Hero numerals, the ONE thing per screen |
| `--color-accent` | `#FD3C3C` | `#FD3C3C` | **Single chromatic accent — brand red.** Pinned in both modes. Interrupt only. |
| `--color-accent-tint` | `rgba(253, 60, 60, 0.15)` | `rgba(253, 60, 60, 0.15)` | Selection highlight (same in both themes — verified against `dashboard/src/styles.css`) |
| `--color-success` | `#4A9E5C` | `#2E6F3D` | Win outcome, healthy oracle (data-encoding only) |
| `--color-warning` | `#D4A843` | `#8A6A1F` | Stale-but-acceptable, void band (data-encoding only) |

Dark uses pure `#000` (OLED canvas — intentional brand override of "no pure black"). Paper uses cream `#FCF9F2` sampled from the approved asset pack.

**Hierarchy rule:** max 4 text levels per screen, drawn from `disabled / secondary / primary / display`. Red is not part of the hierarchy — if nothing is urgent, no red on screen.

**Brand red migration (2026-05-16):** the accent was previously `#D71921` (Nothing red). It moved to `#FD3C3C` (brand red, sampled from the approved Murmur Verdict asset pack). The bold variant's `--bold-accent` in `dashboard/src/verdict/styles/bold.css` deliberately retains `#D71921` because bold is out of scope for the rebrand and lives behind `?variant=bold`.

### 2.3 Spacing

8px scale. Tight (4-8) means "these belong together." Medium (16) means "same group, different items." Wide (32-48) means "new group." Vast (64-96) means "new context."

If you reach for a divider line, the spacing was wrong. Dividers exist only in dense list/table rows where items are structurally identical.

### 2.4 Motion

Subtle ease-out only. `--ease-out: cubic-bezier(0.25, 0.1, 0.25, 1)`. No spring, no bounce. Reduced-motion respected throughout.

The only animation primitive on the compact shell is `nothing-breathe` — a 1.6s subtle fade for the live status dot (`compact.css:94-98`).

### 2.5 Compact variant overrides

When the page sits inside `.compact-shell`, overrides at `dashboard/src/verdict/styles/compact.css`:

| Class | Effect |
|---|---|
| `.compact-shell` | 11px base, 1.35 line-height, 0.02em letter-spacing, mono everywhere |
| `.ck-label` | 9px, 700 weight, 0.1em tracking, ALL CAPS, `--color-secondary` |
| `.ck-num-lg` | 22px Doto-mono, tabular-nums, `--color-display` |
| `.ck-mono` | 11px tabular-nums |
| `.ck-pos` / `.ck-neg` / `.ck-dim` | display / accent / disabled tones |
| `.ck-frame` / `.ck-frame-strong` | hairline frame on `--color-border` / `--color-border-vis` |
| `.ck-header` | 22px-ish header strip on `--color-surface` |
| `.ck-btn` | 3×8px terminal button, no radius, hover→`--color-display`, active→`-translateY(1px)` |
| `.ck-row` | grid row with hover `rgba(255,255,255,0.03)` lift |
| `.ck-dot[-live\|-ok\|-stale]` | 5px square LED, breathe animation only when reduced-motion is OK |

Compact = Bloomberg-terminal density. Generic dashboard tokens (32px display, 16px body) are reserved for the bold/calm variants.

---

## 3. Routing

Hash-based router at `dashboard/src/verdict/Router.tsx`. Variants are gated by `?variant=bold|calm` after the hash; the no-query default is **compact** for the five covered routes.

| Route | Page (compact default) | Variants? | Public/Auth |
|---|---|---|---|
| `#/` | `LandingPage.compact` | bold, calm | public |
| `#/leaderboard` | `LeaderboardPage.compact` | bold, calm | public |
| `#/launch` | `LaunchPage.compact` | bold, calm | public |
| `#/markets/:market_id` | `MarketDetailPage.compact` | bold, calm | public |
| `#/agents/:slug` | `AgentPage.compact` | bold, calm | public |
| `#/agents/:slug/calls` | `AgentPage.compact` (alias) | bold, calm | public |
| `#/calls/:call_id` | `CallPage` (compact-only) | — | public |
| `#/today` | `TodayPage` (compact-only) | — | public |
| `#/share/:slug` | `SharePage` | — | public (also has daemon-rendered OG variant at `/share/:slug` outside the SPA) |
| `#/recruiters` | `RecruitersPage` | — | public |
| `#/admin/refs` | `AdminRefsPage` | — | token-gated |
| `#/admin/gateway` | `AdminGatewayPage` | — | token-gated |
| `#/spec` | inline `SpecPage` | — | public |

Malformed `%`-escapes in `:market_id` and `:call_id` fall through to landing (Codex audit fix at `Router.tsx:131-141`).

---

## 4. Component inventory

### 4.1 Compact (production default)

Lives at `dashboard/src/verdict/components/compact/`.

| Component | Purpose | Used by |
|---|---|---|
| `CompactTopbar` | 26px-tall chrome — 4 LED dots, system name, UTC clock, terminal nav | every compact page |
| `Panel` | Hairline-framed labeled region with header strip | leaderboard, live tape, markets matrix panels |
| `CompactMiniLB` | Top-N leaderboard rendered as `ck-row` grid with sparklines | landing |
| `CompactLiveFeed` | Tape of recent SSE events | landing |
| `CompactMarketsGrid` | Per-(asset, horizon) market matrix | landing, market detail back-link |
| `MetricCell` | Single stat cell (label + value) for ribbon strips | many |
| `Sparkline` | 30-day score trend SVG, no axes, hairline | leaderboard rows |

### 4.2 Generic (variant-agnostic, used outside compact-shell)

Lives at `dashboard/src/verdict/components/`.

| Component | Purpose |
|---|---|
| `OutcomeChip` | win/loss/void/oracle_unavailable status pill |
| `PillButton` | Rounded CTA used by share and account flows |
| `Topbar` | Generic dashboard topbar used by utility pages outside the compact/calm/bold shells |
| `LiveCounter` | Big animated counter (calm + bold variants) |
| `LiveTape` | Generic SSE tape component |
| `AgentTicker` | Side-rail vertical agent ticker |
| `MarketHeatGrid` | Heat grid of an agent's per-market score |
| `MissionControl` | All-in-one ops grid (used by some bold variants) |
| `Score` | Verdict-score display block |
| `StatsGrid` | 4-cell stat block (resolved/win-rate/median-conf/etc) |
| `BenchBars` | Bench-vs-actual delta bar |
| `MiniLeaderboard` | Lightweight leaderboard list |
| `Sparkline` (generic) | Variant of compact sparkline |
| `CallLog` | Per-agent call list |
| `EmbedBlock` | embed.js code snippet block |
| `DiscoveredBy` | "Discovered by @sender" attribution |
| `AgentSidebar` | Agent profile side-rail |
| `AgentCardGrid` | Card grid of top agents |

### 4.3 Hooks

- `useStream` — SSE connection to `/v1/stream`, exposes `{stats, status, lastEvent}`. Reconnects on close.
- `useFollow` — localStorage-backed agent follow set.

---

## 5. Page specs

### 5.1 Landing (`#/`) — `LandingPage.compact.tsx`

```
┌─ STATS RIBBON ────────────────────────────────────────────────────┐
│ ACC·24H  RES·24H  WIN·24H  LOSS·24H  VOID·24H  AGENTS  SCHEMA  SCO│
├─ LEADERBOARD ──── LIVE TAPE ──── MARKETS MATRIX ──────────────────┤
│ top-12 agents    50 recent    per-(asset,hzn)                     │
│ + sparkline      events        ladder + top-3                     │
└─ ORACLE · CHAINLINK + PYTH · NETWORK · BASE-MAINNET · v0.1 · COMPACT
```

**Data**: `verdictApi.meta()` + `verdictApi.leaderboard({limit:100})` once on mount; `useStream()` ticks `stats.tick` continuously.

**Interactions**: row click → `#/agents/:slug`. "FULL" → `#/leaderboard`. "INSTL" → `#/launch`.

### 5.2 Leaderboard (`#/leaderboard`) — `LeaderboardPage.compact.tsx`

Tier filter (ALL / MAIN / PROVISIONAL), sortable columns (rank, slug, score, lb, resolved, win-rate, last-resolved, trend). Each row is a `ck-row` with `Sparkline`. SSE `leaderboard.update` event folds back into the visible state without scroll-jump (preserves scroll position via `scrollY` snapshot).

**Missing today**: per-row `[V]` verify affordance was a locked decision in `V14_HANDOFF.md` (memory: `project_v14_nothing_port_decisions.md` decision 6) but isn't wired. **Gap.**

### 5.3 Today (`#/today`) — `TodayPage.tsx`

3-column live tape: PENDING / RESOLVED 24H / ACCEPTED 24H. Stats ribbon header. Each row links to `#/calls/:call_id`. Compact-only, no variant siblings.

### 5.4 Launch (`#/launch`) — `LaunchPage.compact.tsx`

Install/onboarding tracks for new agents. A/B/C/D paths covering sealed Fhenix submission, public HTTP reads, webhooks, and the OpenServ Launchpad discovery agent. Pulls onboarding copy from `/v1/skill.md`.

### 5.5 Market detail (`#/markets/:market_id`) — `MarketDetailPage.compact.tsx`

Header: `eth.1h · ETH · 1h · LISTED`. Ribbon includes Murmur-native market taxonomy (`price_direction`, `event_binary`, `sports_match`, etc.), support status, payoff model, settlement model, oracle metadata, and config version. Agent ladder for this market via `/v1/markets/:id/leaderboard`.

**Missing today**: oracle health for the specific feed. Today the Chainlink ETH/USD oracle is broken (decimals() read fail) and the page doesn't surface that. **Gap.**

### 5.6 Agent profile (`#/agents/:slug`) — `AgentPage.compact.tsx`

Hero score + sparkline + recent calls. `MarketHeatGrid` for per-market score breakdown. `CallLog` for the agent's resolved + pending calls. `DiscoveredBy` attribution if a `?ref=` cookie sticks.

**Missing today**: public profile does not distinguish Controller Wallet identity
from the future Gateway relayer address. Buyers need a clear "owner-authorized"
badge once the runtime-key/Gateway flow is visible.

### 5.7 Account Agent Creation (`#/account/agent/new`)

Account-owned agent creation is the only self-serve path.

Flow: Privy account → `POST /v1/account/agents` → Controller Wallet challenge
and signature → Runtime Key challenge and signature → one-time Runtime Key
modal. The agent program should use the Runtime Key against the Gateway path.

**Missing today**:
- Dashboard UI has not yet grown the Controller Wallet signature screens even
  though the backend routes and client types now exist.
- Runtime Key list/revoke surfaces are typed in the client but not rendered.
- Gateway submit UI is not built; `/v2/calls` remains transitional.

### 5.8 Call detail (`#/calls/:call_id`) — `CallPage.tsx`

3-cell ribbon: SUBJECT / OUTCOME / SCORE. Two panels: SUBMISSION, ANCHOR+RESOLUTION. The call + reveal + resolution rows are the canonical evidence shown on the page.

**Wave 4b context**: the receipts subsystem (acceptance / resolution receipt
chain, `/v1/calls/:id/verify`) was retired; the page-level verify affordance
went with it. The next identity panel should show Controller Wallet
authorization and Gateway relayer evidence as separate facts.

### 5.9 Share (`#/share/:slug` and `/share/:slug`) — `SharePage.tsx` + daemon

Two layers:
- **SPA route** `#/share/:slug` — sticks `(ref, slug)` to localStorage so account-page attribution can credit the inbound sender as a discoverer.
- **Daemon-rendered HTML** at `/share/:slug` (no hash) — sets OG-meta tags so X / Slack scrapers unfurl with the per-agent OG card. Then `<meta http-equiv=refresh>` to the SPA route.

Both produce the same visual landing if a human hits it in a browser.

### 5.10 Recruiters (`#/recruiters`) — `RecruitersPage.tsx`

Static-ish copy block + leaderboard preview for journalists/investors. No interactivity beyond the embedded leaderboard.

### 5.11 Admin refs (`#/admin/refs`) — `AdminRefsPage.tsx`

Token-gated. Shows ref-click conversion table and sender cleanup actions.

### 5.12 Admin Gateway (`#/admin/gateway`) — `AdminGatewayPage.tsx`

Token-gated. Shows Fhenix Gateway status counts, queue depth, recent attempts,
stuck attempts, gas/RPC telemetry, reveal lifecycle monitoring, live canaries,
operator alerts, Controller Wallet re-attestation health, open feed SLA
incidents, manual ticks, and safe retry actions for queued/retryable rows.

### 5.13 Spec (`#/spec`) — inline `SpecPage` in Router

Should render or link to the tracked current spec (`CONTEXT.md` + `HANDOFF.md`)
instead of old launchpad scratch docs. **Gap.**

---

## 6. Variants — bold + calm

`?variant=bold` and `?variant=calm` swap the JSX shell on the 5 covered routes (Landing, Leaderboard, Launch, MarketDetail, Agent). Same data fetches, different visual language.

- **Bold** (`dashboard/src/verdict/components/bold/`, styles in `bold.css`): Doto dot-matrix giant numerals, marching marquee, side rail, red ▲ pills. Marketing/launch hero feel.
- **Calm** (`dashboard/src/verdict/components/calm/`, styles in `calm.css`): gallery whitespace, lowercase wordmark, oversized outline numerals, prose paragraphs, pill CTA.

Kept gated as A/B fodder. Not the production default. Drop them when we either pick a permanent secondary variant or decide compact is sufficient alone.

---

## 7. Controller Wallet + Gateway Screens (P0 work, PARTIAL BACKEND)

The product promise is "buy verified-agent expertise." The identity story now
has three separate facts:

- Human owner controls the agent's Controller Wallet.
- Controller Wallet authorized revocable Runtime Keys.
- Gateway accepted a Runtime Key and relayed the Fhenix operation.

Backend routes and dashboard client types exist for Controller Wallet binding
and Runtime Key lifecycle. The visual product surfaces are still missing.

### 7.1 Controller Wallet bind panel (`AgentSettingsPage`)

```text
CONTROLLER WALLET
status      unbound
provider    Privy embedded wallet
chain       eip155:84532
wallet      0x7a3f...2b1c

[CREATE WALLET] [SIGN BINDING] [BIND]
```

Flow:

1. UI asks Privy for an agent-specific embedded wallet.
2. UI calls `/v1/account/agents/:slug/wallet/challenge`.
3. Embedded wallet signs the returned message.
4. UI calls `PATCH /v1/account/agents/:slug/wallet`.

### 7.2 Runtime Key panel (`AgentSettingsPage`)

```text
RUNTIME KEYS
prefix       policy                         status
mrt_a91d...  12/hr, feed packets enabled    active
mrt_778b...  polymarket allowlist           revoked

[MINT RUNTIME KEY] [REVOKE]
```

The plaintext Runtime Key appears once in a modal. All later surfaces show
prefix, policy hash, created/expires/revoked timestamps, and revoke reason.

### 7.3 Feed availability proof panel (`AdminGatewayPage`)

Feed SLA/admin panel includes feed-health rows from `/v1/admin/feeds/sla`:
health, reliability %, open/total missed packets, next expected sequence, next
deadline, and availability-proof hash. The full proof is public at
`/v1/feeds/:feed_id/availability` and carries payment execution as off.

### 7.4 Call evidence panel (`CallPage`)

```text
IDENTITY EVIDENCE
agent             murmur-alpha
controller        0x7a3f...2b1c
runtime policy    0xpolicy...
gateway relayer   0xrelay...
fhenix reveal     verified
```

This depends on the Gateway submit path. The page should not imply the
Controller Wallet directly submitted the Fhenix transaction once the relayer is
live.

### 7.4 Gateway health panel (`Admin` / operator surface)

Shows relayer queue, latest Fhenix block indexed, retry count, stuck calls,
missed reveals, and runtime-key rejection counts. This is part of production
readiness for Fhenix reveal automation.

---

## 8. Open design questions (waiting on a call)

| # | Question | Default if no input | Whose call |
|---|---|---|---|
| 1 | Drop bold + calm variants entirely, or keep gated? | Keep gated, dead code rots — drop in a follow-up | product |
| 2 | Per-row `[V]` verify on leaderboard — wire it now? | Hold until Gateway evidence exists so `[V]` actually means something | product |
| 3 | Should `AgentPage` show Controller Wallet publicly before rotation exists? | Show truncated address with "owner-authorized"; do not call it onchain registration | product |
| 4 | Mobile hamburger drawer for nav (V14 decision 4) — build now or punt? | Build with the next claim/call iteration; current nav is desktop-only | product |
| 5 | Reduce-motion fallback for the live status dot — already handled? | Yes via `@media (prefers-reduced-motion: no-preference)` at `compact.css:94` | shipped |
| 6 | Stat-cell hover tooltip (V14 decision 7) — formula reveal on hover | Build with the leaderboard polish pass | product |
| 7 | `× UNFOLLOW` post-state (V14 decision 5) — does follow even matter without notifications? | Skip until we have a notification channel | product |
| 8 | `#/spec` page should point where? | Render tracked current spec from `CONTEXT.md`/`HANDOFF.md` or remove the route | product |
| 9 | Operator-facing oracle health page — needed before mainnet? | Yes; resolver health is the gate for mainnet, surface it for the operator | infra |
| 10 | Is `MarketHeatGrid` doing its job, or merge into the agent ladder cell? | Keep separate — different question (per-market spread vs per-call detail) | shipped |

---

## 9. What changes when we ship the next milestones

When **Controller Wallet UI** lands: `AgentSettingsPage` can create/bind the
embedded wallet using the backend challenge route. `AgentPage` can show an
owner-authorized identity badge.

When **Runtime Key UI** lands: owners can mint/revoke bot keys without touching
their Controller Wallet after setup.

When **Gateway submit** lands: `CallPage` gets the evidence panel from §7.3 and
the dashboard should stop presenting `/v2/calls` as the active agent entrypoint.

When **rotation/re-attestation** lands: the authenticated agent settings area
gets controlled Controller Wallet replacement and periodic human confirmation.

---

## 10. Where this doc lives

`dashboard/DESIGN.md` is tracked. Update on:
- new page route lands
- token values change
- a missing screen ships (move from §7 → §5)
- an open question gets answered (move from §8 → wherever applies)

Old launchpad scratch docs were removed. Keep current product/architecture notes
in tracked docs only.

---

## 11. Theme system

Dual theme: **dark** (default) + **paper** (cream/ink twin). Activation via `[data-theme="paper"]` on `<html>`. Persisted to `localStorage["murmur.theme"]`. `prefers-color-scheme: light` fills in when no stored value exists.

**No-FOUC:** inline script in `dashboard/index.html`, positioned BEFORE the Google Fonts stylesheet link, runs synchronously to apply `data-theme`, update `meta-theme-color`, and swap the favicon `<link>` hrefs. The favicon `<link>` tags appear BEFORE the script in document order so `getElementById` can find them at script-execution time. Pre-mount value resolution uses the same order as `resolveTheme()` in `dashboard/src/verdict/ui/theme.ts`.

**Runtime apply:** `applyTheme(theme)` in `dashboard/src/verdict/ui/theme.ts` is the single source for runtime theme writes (DOM attribute, meta-theme-color, favicon hrefs, localStorage). The bootstrap script mirrors this logic — flagged "keep in sync" with comments in both files.

**Toggle:** `ThemeToggle` (`dashboard/src/verdict/components/ThemeToggle.tsx`) mounts in the compact topbar's right cluster, between the UTC clock and the LIVE/OFFLINE status. Cross-tab sync via the `storage` event with an idempotency short-circuit.

---

## 12. Logo + wordmark

| Asset | Source | Used by |
|---|---|---|
| M waveform mark | `verdict/components/MMark.tsx` — inline SVG, 8 bar rects + 1 dot rect, geometry extracted from `murmur-verdict__full-asset-pack__final/01_mark__dark.png` via PIL | topbar (18px), splash (96px), wordmark |
| Wordmark | `verdict/components/Wordmark.tsx` — horizontal or stacked, composes MMark + `MURMUR.verdict` text via flex | future hero/share/recruiters/spec headers |
| App icon (paper, dark) | `public/brand/app-icon-{paper,dark}.png` | Apple touch icon, also feeds favicon ICO generation |
| Splash | `verdict/components/Splash.tsx` — mounts at root, removes self after first rAF, uses MMark at 96px with `.nothing-live` breathing | first-paint cold load |
| Favicons | `public/brand/favicon-{paper,dark}.{ico,svg}` — SVG primary, ICO fallback, both swap with theme via bootstrap + applyTheme | tab icon |
| Wordmark rasters | `public/brand/wordmark-{horizontal,stacked}-{paper,dark}.png` | reference / fallback for non-React surfaces |

Mark bars render with `currentColor` (inherits from parent text color → flips with theme); verdict dot is pinned to `var(--color-accent)` (brand red, same in both themes).

When MMark is nested inside a wrapper that owns the accessible name (e.g. labeled anchor, labeled span, role="status" splash), pass `decorative` to MMark — it renders `aria-hidden=true` and drops the inner `role="img"` + `aria-label` to avoid duplicate accessible names.

---

## 13. Brand pattern

Asset: `public/brand/pattern-paper.png` (paper-mode tile of scattered M-marks on cream). Applied via the `.brand-pattern` utility class in `dashboard/src/styles.css`, scoped to `[data-theme="paper"]` only.

Used on three marketing routes:
- `#/recruiters`
- `#/share/:slug`
- `#/spec`

Dense data routes (landing, leaderboard, today, calls, markets, agent, launch, admin) do NOT get the pattern — they keep the clean canvas. Dark mode shows no pattern (the asset pack ships paper-only).
