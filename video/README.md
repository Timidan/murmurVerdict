# Murmur Verdict — Logo Sting (Remotion)

A self-contained [Remotion](https://www.remotion.dev) project that renders the
Murmur Verdict logo animation to an `.mp4`. It is intentionally kept out of the
dashboard bundle (its own `package.json` / `node_modules`).

- **Composition:** `LogoSting`, 1920×1080, 30fps, 150 frames (5s), one-shot.
- **Palette (dark):** bg `#0A0A0A`, bars `#FFFFFF`, verdict dot `#FD3C3C`.
- **Wordmark:** Space Grotesk (uppercase, weight ~300, letter-spacing ~0.12em),
  loaded via `@remotion/google-fonts/SpaceGrotesk` with a system geometric-sans
  fallback stack if the font cannot be fetched offline.

## Beat map

Reimplemented frame-for-frame from
`docs/superpowers/specs/2026-07-11-murmur-logo-animation-design.md`
(`frame = ms / 1000 * 30`):

1. **Rise-in** (0–1000ms) — bars grow `0 → EQ_A[i]`, staggered 60ms/bar, ~+8% overshoot.
2. **Murmur / EQ** (1000–2000ms) — bars step `EQ_A → EQ_B → EQ_C`, ease-in-out.
3. **Settle** (2000–2600ms) — bars ease `EQ_C → H` (true mark).
4. **Verdict dot** (2600–3000ms) — square dot drops with a bounce, fades in, one pulse.
5. **Wordmark wipe** (3000–4200ms) — `MURMUR` revealed L→R via `clip-path: inset`; `.VERDICT` fades in (3600–4200ms).
6. **Hold** (4200–5000ms) — lockup holds; bars breathe subtly (opacity 1↔0.85).

All bars keep their center at `y=50` (animate `h`, set `y = 50 - h/2`, `rx = w/2`).

## Usage

```bash
npm install          # pulls Remotion + a headless Chromium (heavy/slow)
npm run preview      # open Remotion Studio to scrub the timeline
npm run render       # -> out/murmur-logo-sting.mp4
npm run typecheck    # tsc --noEmit
```

`npm run render` is equivalent to:

```bash
remotion render LogoSting out/murmur-logo-sting.mp4
```
