# Murmur Verdict — Dashboard Design Spec

> **Status**: living working spec for branch `nothing-preview`. This is what's in the tree right now plus what's still missing. Update on landing structural UI changes — don't let this rot.
>
> **Source of truth for visuals**: `dashboard/src/styles.css` + `dashboard/src/verdict/styles/compact.css`. If this doc disagrees with CSS, CSS wins.

---

## 1. Design philosophy

Five principles. If a screen breaks one, the screen is wrong.

1. **Subtract, don't add.** Every element earns its pixel. Default to removal.
2. **Structure is ornament.** The grid, the data, the hierarchy itself are the visuals.
3. **Monochrome is the canvas.** Color is an event, not a default. Only data status (win/loss/void) and the single brand-red interrupt break this. The canvas is monochrome in both themes (dark OLED black + paper cream); the interrupt red is pinned across themes.
4. **Type does the heavy lifting.** Scale + weight + spacing build hierarchy. Not color, not icons, not shadows.
5. **Industrial warmth.** Technical and precise. A human hand should still be felt — never sterile.

Compact is the only variant. Bold and calm were A/B siblings — removed in 13885f9 once the closeout plan landed compact-only.

---

## 2. Tokens (canonical)

All values from `dashboard/src/styles.css` `@theme` block.

### 2.1 Fonts

| Family | Var | Use | Constraint |
|---|---|---|---|
| **Doto** | `--font-display` | Display only — hero counters, mega numerals | **36px+**, numerals only, never a sentence (an external reviewer found Doto headlines hard to read, 2026-10-02). One sanctioned exception: `ck-steprail-num` clamp(22–30px) for the `/install` rail numerals (owner-approved 2026-08-06). Inside `.mmr-shell` KPI figures (`ck-stat-value`, `ck-stat-hero`) are the only other Doto; titles, labels and row scores are Space Mono. Doto's period reads as "+" below ~24px, so small decimals stay mono. (Nothing discipline; Ndot 57 stand-in via Google Fonts variable axis) |
| **Space Grotesk** | `--font-sans` | UI, body, headings | Default sans |
| **Space Mono** | `--font-mono` | Labels, data, ALL CAPS chrome, every numeric value | All caps for labels; `font-variant-numeric: tabular-nums` for data |

Loaded via Google Fonts in `dashboard/index.html:14-17`. No fontsource package — Doto needs the variable axis only Google serves.

### 2.2 Colors (dual theme: dark + paper)

Two themes share the same CSS-variable surface. Dark is the default. Paper is activated by `<html data-theme="paper">`. The accent red is the SAME hex in both themes — pinned for brand emphasis.

| Var | Dark | Paper | Use |
|---|---|---|---|
| `--color-bg` | `#0A0A0A` | `#FCF9F2` | Canvas |
| `--color-surface` | `#161616` | `#F4EFE5` | Card/panel surface (rare) |
| `--color-raised` | `#1F1F1F` | `#EAE3D3` | Raised surface (rarer) |
| `--color-border` | `#262626` | `#D8D2C8` | Hairline divider |
| `--color-border-vis` | `#363636` | `#B8AE99` | Visible/interactive border |
| `--color-disabled` | `#8A8A8A` | `#6B6350` | Disabled, timestamps, hints |
| `--color-secondary` | `#999999` | `#605A49` | Labels, captions, metadata |
| `--color-primary` | `#E8E8E8` | `#1F1B14` | Body text |
| `--color-display` | `#FFFFFF` | `#0A0A0A` | Hero numerals, the ONE thing per screen |
| `--color-brand-mark` | `#FD3C3C` | `#FD3C3C` | Immutable approved logo-dot red; never follows UI palette changes |
| `--color-accent` | `#C87367` | `#C87367` | **Single chromatic UI event accent.** Muted terracotta, pinned in both modes. |
| `--color-accent-ink` | `#C87367` | `#A64843` | Text and thin-border red; paper value remains AA across every paper surface |
| `--color-accent-tint` | `rgba(200, 115, 103, 0.15)` | `rgba(200, 115, 103, 0.15)` | Selection and low-emphasis event tint |
| `--color-on-accent` | `#0A0A0A` | `#0A0A0A` | Fixed dark ink on accent fills; never resolves to paper cream |
| `--color-success` | `#4A9E5C` | `#2E6F3D` | Win outcome, healthy oracle (data-encoding only) |
| `--color-warning` | `#D4A843` | `#8A6A1F` | Stale-but-acceptable, void band (data-encoding only) |

Dark uses a near-black `#0A0A0A` (OLED-friendly canvas). Paper uses cream `#FCF9F2` sampled from the approved asset pack.

**Paper text tiers re-cut against `raised` (2026-09-02).** `--color-disabled` and
`--color-secondary` were tuned against the paper CANVAS only, and landed at
4.39:1 and 4.60:1 on `--color-raised` — the FormulaTip box's own background —
so every formula line in a light-theme tooltip failed AA. Both moved together
(4.66 / 5.38 on raised, 5.66 / 6.54 on bg): darkening only `disabled` would
have made the quieter tier the louder one. Any future paper token is checked
against `raised`, not `bg`.

**`--color-accent-ink` carries every red that sits on `raised`.** The graphic
accent is 2.69:1 there, which fails even the 3:1 non-text floor, so the
`/install` step numeral, the active-tab bars and the side-tab rail bar all take
the ink token. On dark the two resolve to the same hex, so nothing moves.

**Hierarchy rule:** max 4 text levels per screen, drawn from `disabled / secondary / primary / display`. Red is not part of the hierarchy — if nothing is urgent, no red on screen.

**Active state ink:** active toggles/tabs (`.ck-btn-active`) render in `--color-display` ink, not red — red stays reserved for urgency/interrupt.

**UI red refinement (2026-07-18):** interface events moved from the asset-pack `#FD3C3C` to the calmer `#C87367`, with fixed `#0A0A0A` ink on fills. Official wordmarks, favicons, and animated mark dots remain pinned to their approved `#FD3C3C`; the UI palette never recolors a logo.

### 2.3 Spacing

8px scale. Tight (4-8) means "these belong together." Medium (16) means "same group, different items." Wide (32-48) means "new group." Vast (64-96) means "new context."

If you reach for a divider line, the spacing was wrong. Dividers exist only in dense list/table rows where items are structurally identical.

### 2.4 Motion

Subtle ease-out only. `--ease-out: cubic-bezier(0.25, 0.1, 0.25, 1)`. No spring, no bounce. Reduced-motion respected throughout.

Exactly one ambient animation runs on the compact shell: the live-dot glyph's transmission pulse (`compact.css`, `.ck-live-tx`), which dims and recovers the glyph's core while its chevrons swell outward on a 2.8s cycle. It is conditioned on a real open SSE connection — never on hover or a timer — and gated behind `prefers-reduced-motion`. The topbar's connection dot is a static colour indicator (success green when live, accent otherwise); it does not animate. Nothing else in the shell loops.

### 2.5 Compact shell styles

When the page sits inside `.mmr-shell`, overrides at `dashboard/src/verdict/styles/compact.css`. Sizes below are the SHIPPED ones as of the 2026-08-08 type-scale notch — read from the stylesheet, not from an older table. (History: base was 11px → 13 → 15 → **16**; this table lagged three of those raises, which is why it is now derived from the CSS on every change.)

**The 12px floor (hard constraint).** Nothing in the cockpit renders below 12px — no hint, timestamp, badge, column header, pinned nav tip, or step-rail title. Owner ruling, 2026-08-08. The quiet tiers sit *on* 12, never under it. If text feels too loud, do not shrink it under 12 — quiet it with ink (`ck-dim`) or tracking, or raise the tier it sits in. Sub-12px arbitrary size utilities — the 10px and 11px ones this cockpit used to carry — do not exist here and must not come back. (Described, not spelled: Tailwind v4 compiles a class name it finds in *prose* into a real rule, and this very sentence used to regenerate both of the utilities it bans. A doc must not manufacture what it forbids.) `--text-xs` is retuned to `0.8125rem` (13px) in the `@theme` block precisely so no stock Tailwind utility can duck under the floor either.

**The floor is enforced, not conventional.** Two committed mechanisms, added 2026-08-09:

1. **Nothing outside the app can reach the bundle.** `dashboard/src/styles.css` disables Tailwind's automatic content detection (`@import "tailwindcss" source(none)`) and declares `dashboard/src` + `dashboard/index.html` as the only `@source`s. Before this, v4 scanned from the git root, so a size written in a plan, spec or design doc compiled into shipped CSS — which is exactly how the two banned utilities kept their rules alive with zero call sites.
2. **A sub-12px size fails a check.** `dashboard/src/verdict/type-floor.check.ts` runs in `npm run smoke:all` (and therefore `verify:readiness`) and scans the same source set the stylesheet declares, **plus `dashboard/public/landing-cinematic/`** (added 2026-09-02). The landing is served from `public/`, so it never entered the Tailwind bundle and was never scanned — and it had drifted almost wholly under the floor while the cockpit was swept four times: nav 11.5px, section labels 10.4, footer 9.6. It is the first page a visitor sees, and the floor is a product ruling rather than a bundler artefact, so the check follows the pixels. It fails on any arbitrary text-size utility, inline `fontSize`, or stylesheet `font-size`/font-size custom property that resolves under 12px, naming the file, line and value. Relative units (`em`, `%`) are out of its reach by design — see the check's header for why.

#### Type ladder

| Class / selector | Size | Rest |
|---|---|---|
| `.mmr-shell` | **16px** base | 1.4 line-height, 0.02em tracking, mono everywhere |
| `.ck-title` (T1) | **18px** | 700, 0.01em, `--color-display`, 6px square `::before` marker — panel/section titles, the loudest chrome in the content area |
| `.ck-mono` | **16px** | tabular-nums; beats bare `pre`/`code`/utility font-sizes (0,2,0 unlayered) |
| `.ck-btn` | **15px** | 700, 0.03em, `4px 10px` padding, no radius, hover→`--color-display` |
| `.ck-value-lg` / `.ck-value` / `.ck-value-sm` | **15 / 14 / 13px** | all 700 — the readout paired with a `ck-label`; declared after `.ck-mono` so it wins the equal-specificity fight |
| `.ck-label` (T3) | **13px** | 700, 0.04em, `--color-secondary` — inline field labels |
| `.ck-meta` | **13px** | small meta line under display titles |
| `.ck-colhead` (T2) | **12px** | 700, 0.09em, `--color-disabled` — table column headers, quiet scaffolding. Sits ON the floor |
| `.ck-tag` / `.ck-tag-ok` | **12px** | 700, 0.04em, `--color-disabled` — a list row's own state beside its control (`ck-tag-ok` tints it `--color-success` for "selling"). Sits ON the floor |
| `.mmr-nav-link`, `.mmr-topbar-meta`, `.mmr-topbar-crumb` | **`--nav-font-size` = 0.78rem** (12.48px) | 400, 0 tracking, 44px target, `--nav-link-gap` 32px (68px under `hover:none`, where the pinned tips are always shown), unboxed with intent underline |
| `.mmr-nav-tip` | **12px** | pinned/hover label; same 12px in the `hover:none` branch (padding tightens to `3px 5px`, not the size) |
| `.ck-steprail-title`, `.ck-stephint`, `.ck-steppanel-foot` | **12px** | /install rail chrome |
| `.ck-steprail-num` | **clamp(22px, 4vw, 30px)** | the ONE sanctioned Doto exception inside the shell (owner-approved 2026-08-06) |
| `.mmr-shell pre` | **15px** | 1.45 line-height, zero padding — block code is primary content and sets its own register |
| `.mmr-shell code` | **`max(0.92em, 12px)`** | inline code is a token *inside* prose, so it is RELATIVE and tracks whatever tier it lands in (16px body → 14.72; 12px hint → 12, on the floor). `.mmr-shell pre code` re-inherits the block's 15px so a `<code>` in a `<pre>` is never double-scaled |
| `@media (max-width: 639px)` inputs | **16px** | iOS zoom-on-focus floor; kept as a belt now that the base is 16 |

#### Non-type chrome

| Class | Effect |
|---|---|
| `.ck-page` | **the page measure: `max-width: 1100px`, centred.** One class, so it cannot drift again — it had reached three values (IntegratePage 820 · AccountPage 960 · AgentSettingsPage 1100) once each page typed its own. 1100 is the widest surface's real need: a rail plus a code body, where the TS gateway snippet's longest line is 88 mono characters and wraps under ~900px. Put it on the page's `<main>` — loading and error shells included, or the page jumps width on every cold load. Panels inside stay `w-full`; prose still caps itself at `max-w-[60ch]`. Modals, drawers, tooltips and the mobile nav are components, not pages, and keep their own widths. Two pages keep their own narrower measure on purpose and are not drift: `/install` (760px reading column, marketing type, not a cockpit page) and `AgentOnboardPage` (`max-w-2xl`, one centred form — a form stretched to 1100 is worse, not wider) |
| `.ck-pos` / `.ck-neg` / `.ck-dim` | display / accent-ink / disabled tones — colour only, never size |
| `.ck-frame` / `.ck-frame-strong` | hairline frame on `--color-border` / `--color-border-vis` |
| `.ck-header` | `min-height: 31px`, `6px 8px` padding on `--color-surface` — derived, not chosen: 18px title line box + 6+6 padding + 1px border |
| `.ck-row` | grid row, hover lift via `color-mix(in srgb, var(--color-primary), transparent 97%)` (theme-correct — the old `rgba(255,255,255,0.03)` hazed white on paper) |
| `.ck-sidetabs` (+ `-rail` / `-body`) | rail left, body right, one frame around both; active cell wears an inset accent bar; below `md` the rail lies down into a scrolling strip. Two rail widths: bare = **56px icon-only** (`.ck-sidetab--icon` + `.ck-sidetab-tip`, used by AgentSettingsPage's eight tabs, whose labels truncate at word width), `.ck-sidetabs--wide` = **170px worded** (IntegratePage's four short labels, which do not). `.ck-sidetab-body--fixed` floors the body at 400px so switching panes never resizes the page |
| `.ck-dot[-ok\|-stale]` | 5px square LED, static colour only — no animation |
| `.ck-ladder` (+ `--market`) | **the agent ladder's grid**, owned here rather than retyped per page. Nine tracks (eight on `--market`), and below 640px only four: rank, agent, score, floor. The 436px of fixed numeric track left the `1fr` handle column resolving to ZERO on a 390px phone — the leaderboard rendered nameless rows and the market ladder printed its tier badge over the score. Cells that leave wear `.ck-ladder-drop`; the loading skeleton wears it on the same five bars so it cannot wrap to three rows under a one-row table |
| `.ck-fam-row` | the families panel's four-track row. The unit ("of families") moved from every row into the column header, which is what had been truncating the handle to `operator-…` in a 290px side panel |

#### Dead classes — do not re-document as live

Defined in CSS, **zero `.tsx` usages** (checked 2026-08-09). They are kept only because deleting them is a separate call; treat them as removed when designing, and don't cite their sizes as precedent:

`.ck-num` (16px) · `.ck-num-lg` (30px) · `.ck-badge` (12px) · `.t-subheading` (22px) · `.t-stat-num` (28px) · `.t-data` (16px) · `.pill-owner` (12px)

Compact = Bloomberg-terminal density. The generic `t-*` tiers in `styles.css` (`t-display` clamp 96–200 · `t-display-md` clamp 64–128 · `t-display-sm` clamp 24–30 · `t-heading` 26 · `t-body` 17 · `t-body-sm` 16 · `t-meta` 15 · `t-button` 15 · `t-label` 13) serve the marketing/`/install` surfaces outside the compact shell.

**Page titles.** A page's `<h1>` must out-rank `.ck-title` (18px), never tie or duck under it. In-shell the shipped page-h1 size is **21px** (`IntegratePage`, `MarketDetailPage`); `AgentOnboardPage` is the one exception — it wears `ck-title ck-title-ik` at 18px because it is the only heading on that page and the 24px `agent` glyph's `-3px` optical offset is derived from 18. Outside the shell, `t-display-sm` / `t-heading` carry it.

---

## 3. Routing

Hash-based router at `dashboard/src/verdict/Router.tsx`. Every route renders the single compact page; `?variant=` routing was removed alongside the bold/calm files.

| Route | Page | Public/Auth |
|---|---|---|
| `#/` | `LandingPage` | public |
| `#/leaderboard` | `LeaderboardPage` | public |
| `#/launch` | `LaunchPage` | public |
| `#/markets/:market_id` | `MarketDetailPage` | public |
| `#/agents/:slug` | `AgentPage` | public |
| `#/agents/:slug/calls` | `AgentPage` (alias) | public |
| `#/calls/:call_id` | `CallPage` | public |
| `#/today` | `TodayPage` | public |
| `#/share/:slug` | `SharePage` | public (also has daemon-rendered OG variant at `/share/:slug` outside the SPA) |
| `#/admin/gateway` | `AdminGatewayPage` | token-gated |
| `#/spec` | inline `SpecPage` | public |
| `#/account` | `AccountPage` (inside `AccountShell`) | Privy-authed |
| `#/account/login` | `LoginPage` (supports `?next=`) | public |
| `#/agent/onboard` | `AgentOnboardPage` (slug input + in-browser signing → runtime key) | Privy-authed |
| `#/account/agent/:slug/{payout\|wallet\|runtime\|keys}` | `AgentSettingsPage` | Privy-authed |
| `#/account/agent/:slug/integrate` | `IntegratePage` | Privy-authed |

Malformed `%`-escapes in `:market_id` and `:call_id` fall through to landing (Codex audit fix at `Router.tsx:131-141`).

---

## 4. Component inventory

### 4.1 Compact (production default)

Lives at `dashboard/src/verdict/components/compact/`.

| Component | Purpose | Used by |
|---|---|---|
| `CompactTopbar` | 64px shared chrome — MMark, context crumb, landing-canonical unboxed nav, UTC clock, theme, live status. Mounted ONCE by `Router`'s `AppShell`, outside `<Suspense>`, so it never unmounts. **Three-column invariant** — see below | the persistent shell |

**The topbar is persistent (2026-08-10).** `AppShell` in `Router.tsx` mounts it once, above the Suspense boundary; pages render content only. Before this every one of 18 pages rendered its own, so each navigation destroyed and rebuilt the bar — which dropped and reopened the SSE stream every time (measured: one fresh `/v1/stream` per nav click), flashed `live → offline → live`, and blanked the chrome entirely during a cold chunk fetch. It also meant the owner-approved "columns land" activation motion had **never once fired**: the effect compares against the previous route, and a bar that remounts has no previous route. Pages send their crumb through `<TopbarCrumb/>`, which portals into a slot in the persistent bar, so per-page loading and error branches keep their own crumbs.

**Topbar three-column invariant (2026-08-10).** The bar is `[left rail flex-1 basis-0] [nav shrink-0] [right rail flex-1 basis-0]`, and both rails carry the *same* horizontal padding (28px). That is what pins the nav glyph row to the viewport centre.

It used to be `[logo][crumb][nav flex-1 justify-center][right]`, which centred the nav in whatever space the crumb and right cluster left over — so the nav moved whenever either changed width. Measured before the fix: **65px** of drift in the first icon's x across the five nav routes (crumb `install` 65px → `recruiters /attribution` 196px), plus an 11px slide each time the live/offline readout changed width. Nav destinations that land somewhere different on every page are not a nav bar.

Two rules keep it honest, and both are load-bearing:
- **Rails grow, nav doesn't.** Putting a width on the nav, or dropping `basis-0` from a rail, re-opens the drift.
- **Equal rail padding.** Under `border-box`, a `flex-basis: 0` item cannot resolve below its own horizontal padding, so unequal padding gives the rails unequal floors and pushes the nav off-centre (it was 6px off at 28px vs 16px). Change one side's padding and you must change the other.

Only the left rail gets `min-w-0`: it absorbs any squeeze by truncating the crumb, so the right rail's fixed-size chrome never compresses.

**The bar is 98px where the tips are pinned (2026-09-02).** Under `hover: none`
every nav tip is shown at once, hanging 68-88px below the bar's top edge — 24px
past a 64px bar. They are out of flow, so on a hoverless ≥1024px device (an iPad
in landscape) six bracketed labels printed straight over the first rows of the
page: the leaderboard's ribbon, the agent's identity strip, the call's outcome.
`.mmr-topbar` (the class exists for this) grows to 98px in that branch and pins
its three rails back to 64px, so every measurement above still holds and only
the header box changes. `--nav-hit-area` and the rail padding are untouched.

**The clock is local, not UTC (2026-09-02).** It printed `toISOString()` with a
bare `Z` while every market window on the same screen was already rendered in
the reader's own zone. One zone per screen, and it is the reader's; the zone is
named in the label so nothing is ambiguous. UTC keeps the place it belongs,
which is the wire.
| `Panel` | Hairline-framed labeled region with header strip | leaderboard, live tape, markets matrix panels |
| `CompactMiniLB` | Top-N leaderboard rendered as `ck-row` grid with sparklines | landing |
| `CompactLiveFeed` | Tape of recent SSE events | landing |
| `CompactMarketsGrid` | Market matrix behind the checkable filter tiers (owner sign-off 2026-08-11): **venue → category → series → market**, each a multi-select row of checkbox chips (`MarketFilterBar` + lib/market-filters.ts; subtractive model — null = all checked, the old `toggleAsset` semantics). Checked = on the board. Only what murmur carries is offered; upper tiers narrow lower options; ghost selections prune silently; selection lives in the URL (`venue`/`category`/`series`/`market` params, replaceState). A tier holding one value renders as a plain label ("a tier earns a row only when it branches"); the series tier stays hidden while Gamma's per-asset series map 1:1 onto market leaves. The grid mirrors the bar: venue/category section headers appear only when >1 is showing. Category = the venue's own top-level tag (`venue_category`, matched against `POLYMARKET_TOP_LEVEL_TAGS` precedence, canonical labels, displayed lowercase), or "uncategorised" — never murmur's taxonomy class, which names settlement, not subject (owner ruling 2026-08-11). Market leaf identity = `series_slug` so a checked market follows its rolling windows. Archive rows (`/v2/markets/archive`: `provider`/`category_label`) narrow by venue+category tiers and by checked symbol leaves. Search tab stays flat: name (`q`) + ended-on date, server-side | landing, market detail back-link |
| `MetricCell` | Single stat cell (label + value) for ribbon strips | many |
| `Sparkline` | 30-day score trend SVG, no axes, hairline | leaderboard rows |

### 4.2 Generic (used outside mmr-shell utility pages)

Lives at `dashboard/src/verdict/components/`.

| Component | Purpose |
|---|---|
| `OutcomeChip` | win/loss/void/oracle_unavailable status pill |
| `Topbar` | Generic dashboard topbar used by utility pages outside the compact shell |
| `LiveCounter` | Big animated counter |
| `LiveTape` | Generic SSE tape component |
| `AgentTicker` | Side-rail vertical agent ticker |
| `MarketHeatGrid` | Heat grid of an agent's per-market score |
| `MissionControl` | All-in-one ops grid |
| `Score` | Verdict-score display block |
| `StatsGrid` | 4-cell stat block (resolved/win-rate/median-conf/etc) |
| `BenchBars` | Bench-vs-actual delta bar |
| `MiniLeaderboard` | Lightweight leaderboard list |
| `Sparkline` (generic) | Generic counterpart to the compact sparkline |
| `CallLog` | Per-agent call list |
| `EmbedBlock` | embed.js code snippet block |
| `AgentSidebar` | Agent profile side-rail |
| `AgentCardGrid` | Card grid of top agents |
| `FamilyLeaderboards` | Per-family (kind) leaderboard rollup used by the landing page |
| `FheStatusPanel` | Reads `/v1/meta`; renders sealed-Fhenix posture (chain, contract) |
| `TierBadge` | Tier pill (main / provisional) on leaderboard rows + agent ribbons |
| `ThemeToggle` | Dark ↔ paper theme switch in topbar |
| `Splash` | Cold-load mark splash (gated by a single rAF) |
| `MMark`, `Wordmark` | Brand glyph + wordmark SVG primitives |
| `PrivacyTierBadge` | Sealed-Fhenix tier indicator mounted on `CallPage` |
| `FormulaTip` (compact) | Stat-cell formula tooltip on leaderboard + agent pages |

### 4.3 Hooks

- `useStream` — SSE connection to `/v1/stream`, exposes `{stats, status, lastEvent}`. Reconnects on close.
- `useFollow` — localStorage-backed agent follow set.

---

## 5. Page specs

### 5.1 Landing (`#/`) — `LandingPage.tsx`

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

### 5.2 Leaderboard (`#/leaderboard`) — `LeaderboardPage.tsx`

Tier filter (ALL / MAIN / PROVISIONAL), sortable columns (rank, slug, score, lb, resolved, win-rate, last-resolved, trend). Each row is a `ck-row` with `Sparkline`. SSE `leaderboard.update` event folds back into the visible state without scroll-jump (preserves scroll position via `scrollY` snapshot).

Each row exposes a compact `[V]` affordance that opens the agent evidence
profile. Row click and verify currently land on the same public profile because
the retired receipts subsystem no longer has a standalone verify endpoint.

### 5.3 Today (`#/today`) — `TodayPage.tsx`

3-column live tape: PENDING / RESOLVED 24H / ACCEPTED 24H. Each row links to `#/calls/:call_id`. The page subscribes to `useStream` — every `call.accepted` / `call.resolved` event refetches the feed so the three panels stay live.

Open item: a stats-ribbon header (aggregate counts across the three panels) is planned but not currently rendered.

### 5.4 Launch (`#/launch`) — `LaunchPage.tsx`

Install/onboarding tracks for new agents. A/B/C/D paths covering sealed Fhenix submission, public HTTP reads, webhooks, and the OpenServ Launchpad discovery agent. Pulls onboarding copy from `/v1/skill.md`.

### 5.5 Market detail (`#/markets/:market_id`) — `MarketDetailPage.tsx`

Header: `eth.1h · ETH · 1h · LISTED`. Ribbon includes Murmur-native market taxonomy (`price_direction`, `event_binary`, `sports_match`, etc.), support status, payoff model, settlement model, oracle metadata, and config version. Agent ladder for this market via `/v1/markets/:id/leaderboard`.

The config drawer surfaces per-market oracle registry health, including primary
and fallback oracle IDs, listed/missing status, and asset-match checks.

### 5.6 Agent profile (`#/agents/:slug`) — `AgentPage.tsx`

Hero score + sparkline + recent calls. `MarketHeatGrid` for per-market score breakdown. `CallLog` for the agent's resolved + pending calls.

Public profiles distinguish Controller Wallet identity from Gateway relay
execution with an `owner-authorized` badge linked to the bound controller
wallet where an explorer URL is known.

### 5.7 Agent Onboarding (`#/agent/onboard`)

The dashboard owns the full agent registration flow. The bot only ever
sees one credential — `MURMUR_RUNTIME_KEY` — minted at the end of this
page. The Privy session never leaves the browser.

Flow: Privy login on `#/account/login` → AccountPage shows the profile +
existing agents → operator clicks `[ + add agent ]` → AgentOnboardPage
collects the agent's slug and chains seven calls in-browser using the
Privy embedded (or external) wallet:

1. `POST /v1/account/agents`
2. `POST /v1/account/agents/:slug/wallet/challenge`
3. `useSignMessage` against the controller wallet
4. `PATCH /v1/account/agents/:slug/wallet`
5. `POST /v1/account/agents/:slug/runtime-keys/challenge`
6. `useSignMessage` against the controller wallet again
7. `POST /v1/account/agents/:slug/runtime-keys`

On 201 the page opens `RuntimeKeyMintModal`, which reveals the runtime
key once with the standard friction-loaded dismissal pattern. The display
name auto-derives from the slug (`my-bot` → `My Bot`); the operator can
edit it later from agent settings.

If create-agent succeeds but a later step fails (e.g. operator rejected
the wallet popup), the page surfaces a "continue setup" link to
`#/account/agent/:slug/wallet`, so the operator doesn't have to retype
the slug and orphan the first row.

Per-agent management (additional wallet binds, runtime-key list/revoke,
payout address, account API keys) lives at
`#/account/agent/:slug/{payout|wallet|runtime|keys}` once the agent
exists.

The dashboard intentionally does not offer an in-browser bot-submit path. Bots
invoke `POST /v2/gateway/calls` directly via their runtime key.

External-wallet support is wired through Privy's `useSignMessage` abstraction.
Operators with non-Privy-managed wallets (raw MetaMask without Privy connector)
are not currently a target.

### 5.8 Call detail (`#/calls/:call_id`) — `CallPage.tsx`

3-cell ribbon: SUBJECT / OUTCOME / SCORE. Two panels: SUBMISSION, ANCHOR+RESOLUTION. The call + reveal + resolution rows are the canonical evidence shown on the page.

**Wave 4b context**: the receipts subsystem (acceptance / resolution receipt
chain, `/v1/calls/:id/verify`) was retired; the page-level verify affordance
went with it. The next identity panel should show Controller Wallet
authorization and Gateway relayer evidence as separate facts.

### 5.9 Share (`#/share/:slug` and `/share/:slug`) — `SharePage.tsx` + daemon

Two layers:
- **SPA route** `#/share/:slug` — the share tools: card preview, post and copy actions, badge embeds.
- **Daemon-rendered HTML** at `/share/:slug` (no hash) — sets OG-meta tags so X / Slack scrapers unfurl with the per-agent OG card. Then `<meta http-equiv=refresh>` to the SPA route.

Both produce the same visual landing if a human hits it in a browser.

### 5.10 Admin Gateway (`#/admin/gateway`) — `AdminGatewayPage.tsx`

Token-gated. Shows Fhenix Gateway status counts, queue depth, recent attempts,
stuck attempts, gas/RPC telemetry, reveal lifecycle monitoring, live canaries,
operator alerts, Controller Wallet re-attestation health, open feed SLA
incidents, manual ticks, and safe retry actions for queued/retryable rows.

### 5.11 Spec (`#/spec`) — inline `SpecPage` in Router

Dev-only placeholder. Production builds route it to the 404 page.

---

## 6. Variants — removed

Bold and calm A/B variants were dropped in 13885f9 (10 page files + 10
variant components + 2 stylesheets removed). `?variant=` routing is gone
from Router.tsx. The closeout decision: compact is canonical, the
fragmentation cost of carrying experiments without active users wasn't
worth it. If we want a marketing-hero variant in the future, build it
as a new top-level route, not a sibling JSX swap.

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
| 1 | ~~Drop bold + calm variants entirely?~~ | **Resolved 2026-05-22:** dropped in 13885f9. | product |
| 2 | Per-row `[V]` verify on leaderboard — wire it now? | Hold until Gateway evidence exists so `[V]` actually means something | product |
| 3 | Should `AgentPage` show Controller Wallet publicly before rotation exists? | Show truncated address with "owner-authorized"; do not call it onchain registration | product |
| 4 | Mobile hamburger drawer for nav (V14 decision 4) — build now or punt? | Build with the next claim/call iteration; current nav is desktop-only | product |
| 5 | Reduce-motion fallback for the live status dot — already handled? | Yes via `@media (prefers-reduced-motion: no-preference)` at `compact.css:94` | shipped |
| 6 | Stat-cell hover tooltip (V14 decision 7) — formula reveal on hover | Build with the leaderboard polish pass | product |
| 7 | `× UNFOLLOW` post-state (V14 decision 5) — does follow even matter without notifications? | Skip until we have a notification channel | product |
| 8 | `#/spec` page should point where? | Dev-only placeholder; remove the route once nothing uses it | product |
| 9 | Operator-facing oracle health page — needed before mainnet? | Yes; resolver health is the gate for mainnet, surface it for the operator | infra |
| 10 | Is `MarketHeatGrid` doing its job, or merge into the agent ladder cell? | Keep separate — different question (per-market spread vs per-call detail) | shipped |

---

## 9. What changes when we ship the next milestones

When **Controller Wallet UI** lands: `AgentSettingsPage` can create/bind the
embedded wallet using the backend challenge route. `AgentPage` can show an
owner-authorized identity badge.

When **Runtime Key UI** lands: owners can mint/revoke bot keys without touching
their Controller Wallet after setup.

When **Gateway submit evidence UI** lands: `CallPage` gets the evidence panel
from §7.3 showing relayer attempt, tx, confirmation, and accepted call rows.

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

**No-FOUC:** inline script in `dashboard/index.html`, positioned BEFORE the fonts stylesheet link, runs synchronously to apply `data-theme`, update `meta-theme-color`, and swap the favicon `<link>` hrefs. The favicon `<link>` tags appear BEFORE the script in document order so `getElementById` can find them at script-execution time. Pre-mount value resolution uses the same order as `resolveTheme()` in `dashboard/src/verdict/ui/theme.ts`.

**Runtime apply:** `applyTheme(theme)` in `dashboard/src/verdict/ui/theme.ts` is the single source for runtime theme writes (DOM attribute, meta-theme-color, favicon hrefs, localStorage). The bootstrap script mirrors this logic — flagged "keep in sync" with comments in both files.

**Toggle:** `ThemeToggle` (`dashboard/src/verdict/components/ThemeToggle.tsx`) mounts in the compact topbar's right cluster, between the clock and the LIVE/OFFLINE status. Cross-tab sync via the `storage` event with an idempotency short-circuit.

**The cinematic landing is dark in both themes, on purpose.** `/` is a
full-bleed photographic scene (`public/landing-cinematic/`) with its own
stylesheet, its own tokens and `color-scheme: dark`; the composition is a
graded night photograph, and there is no light twin of it. A paper reader
therefore meets a dark entrance and a cream app. That is a deliberate
brand-surface exception, not an unfinished theme — recorded here so it is not
"fixed" by accident. If the landing ever needs a paper twin it needs a second
art direction first, not a token sweep.

---

## 12. Logo + wordmark

| Asset | Source | Used by |
|---|---|---|
| M waveform mark | `verdict/components/MMark.tsx` — inline SVG, 8 bar rects + 1 dot rect, geometry extracted from `murmur-verdict__full-asset-pack__final/01_mark__dark.png` via PIL | topbar (28px), splash (96px via `AnimatedMark`), wordmark |
| Wordmark | `verdict/components/Wordmark.tsx` — horizontal or stacked, composes MMark + `MURMUR.verdict` text via flex | future hero/share/spec headers |
| App icon (paper, dark) | `public/brand/app-icon-{paper,dark}.png` | Apple touch icon, also feeds favicon ICO generation |
| Brand sting | `verdict/components/Splash.tsx` — full-bleed `logo-sting.mp4` (5.06s), landing route + first visit only (`murmur.sting.seen`), dismissed on end/interaction/skip/7s timeout; skipped entirely under reduced motion | landing entrance |
| Logo loader | `verdict/components/LogoLoader.tsx` — looping `logo-loop.mp4` (0.70s). Held invisible for 350ms by a CSS animation delay, so waits shorter than that never flash a loader at all — only a real wait shows one | Suspense fallback, auth gate, admin + settings loads |
| Favicons | `public/brand/favicon-{paper,dark}.{ico,svg}` — SVG primary, ICO fallback, both swap with theme via bootstrap + applyTheme | tab icon |
| Wordmark rasters | `public/brand/wordmark-{horizontal,stacked}-{paper,dark}.png` | reference / fallback for non-React surfaces |

**Logo motion assets** (`public/brand/`, encoded from `assets/murmur-logo-sting.mp4`):
`logo-sting.mp4` is the full 5.06s entrance; `logo-loop.mp4` is a seamless 0.70s
window (source 0.57–1.27s — frame 0 is black, so a naive 0–1s loop blinks).
Both are muted and have their black point crushed to pure `#000`, which is what
lets `mix-blend-mode: screen` (dark) and `invert(1) hue-rotate(180deg)` +
`multiply` (paper) render the video field as exactly the page background in
either theme. The sting's black backdrop is painted by the `index.html`
bootstrap via `:root[data-sting]` before first paint — React cannot mount
early enough, so without it the first visit flashed the theme background and
then slammed to black. `AnimatedMark` is now used only by the `/logo` dev route.

Mark bars render with `currentColor` (inherits from parent text color → flips with theme); verdict dot is pinned to `var(--color-accent)` (brand red, same in both themes).

When MMark is nested inside a wrapper that owns the accessible name (e.g. labeled anchor, labeled span, role="status" splash), pass `decorative` to MMark — it renders `aria-hidden=true` and drops the inner `role="img"` + `aria-label` to avoid duplicate accessible names.

---

## 13. Brand pattern

Asset: `public/brand/pattern-paper.png` (paper-mode tile of scattered M-marks on cream). Applied via the `.brand-pattern` utility class in `dashboard/src/styles.css`, scoped to `[data-theme="paper"]` only.

Used on two marketing routes:
- `#/share/:slug`
- `#/spec`

Dense data routes (landing, leaderboard, today, calls, markets, agent, launch, admin) do NOT get the pattern — they keep the clean canvas. Dark mode shows no pattern (the asset pack ships paper-only).

---

## 14. Icon sourcing

`dashboard/src/verdict/icons.tsx` is the source of truth — read its header
comment for the full reasoning. Summary:

Original grammar: every icon hand-drawn, 16-grid inline / 24-grid nav,
square-cap/miter-join, 1px hairline, half-grid pixel-snapped. Still the rule
for anything drawn from scratch.

**2026-08-10 sourcing pass.** The owner wanted new/replacement icons that fit
the *design system* (monochrome, dual dark/paper theme, restrained motion,
technical-but-not-sterile) rather than the hand-drawn set's own drawing
grammar. Evaluated Lucide (9/10 textbook fit, rejected as too saturated —
default behind shadcn/ui and most current dark-mode SaaS) and Solar Icons
(arguably more saturated than Lucide within crypto/trading-dashboard
templates specifically) before landing on **Streamline's "Sharp Line"**
style — hard miter joins, square caps, no rounding, explicitly *not*
Streamline's own flagship "Core" style (self-described as "the Helvetica of
icons," i.e. deliberately generic).

16 of the 27 inline concepts and 2 of the 6 nav destinations (`agent`,
`badge`) now use real Streamline Sharp geometry (CC BY 4.0 — attribution in
`THIRD_PARTY_NOTICES.md`). The rest stayed hand-drawn on purpose: no real
Streamline icon exists for `seal` / `confirm-live` / `dispute` / `webhook` /
`x402` (murmur-specific concepts a general icon library doesn't cover),
`mcp`'s only candidate collides with `link`, `leaderboard`'s only candidate
was a wrong-domain UN-SDG-style icon, `copy`'s candidate implied a link
specifically (narrower than actual usage), and `live-dot` — despite a
reasonable match existing — stays hand-drawn because its exact path
structure (two chevrons + one core rect, in order) is what
`compact.css`'s `.ck-live-tx` transmission-pulse animation targets; the app's
one ambient animation was not worth risking for an icon swap.

Mixed-grid rendering: `Ik` picks viewBox/stroke-width per glyph
(16-grid/1px hand-drawn vs. 24-grid/1.5px Streamline — the same relative
weight, so both read as one family at any shared render size).
`STREAMLINE_ICON_NAMES` / `NAV_STREAMLINE_ICON_NAMES` (exported from
`icons.tsx`) are the single source of truth for which glyphs came from
where; `icons.smoke.ts` branches its pixel-snap guards off them.
