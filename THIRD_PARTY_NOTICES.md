# Third-party notices

## Streamline Sharp Line icons

`dashboard/src/verdict/icons.tsx` inlines 16 inline glyphs and 2 nav-tier
glyphs (rest + active states) sourced from **Streamline**'s "Sharp Line" /
"Sharp Solid" icon families, free CC BY 4.0 tier.

- Source: https://github.com/webalys-hq/streamline-vectors (`sharp/line/`, `sharp/solid/`)
- Publisher: Streamline / Webalys — https://streamlinehq.com
- License: [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) — free
  for commercial use with attribution.
- Changes made: hardcoded `stroke="#000000"` / `fill="#000000"` recolored to
  `stroke="currentColor"` / `fill="currentColor"`; per-path `stroke-width`
  and decorative `id`/`<desc>` metadata removed (weight now set once on the
  shared `<svg>` root in `icons.tsx`, matching the file's existing
  convention for the hand-drawn glyphs). No path geometry was altered.

Icons used (`icons.tsx` name → Streamline name):

| murmur name | Streamline icon | Tier |
|---|---|---|
| `agent` | cyborg | inline + nav (rest/active) |
| `controller-wallet` | wallet-purse | inline |
| `attest` | signature | inline |
| `runtime-key` | smart-key | inline |
| `verdict` | justice-scale-2 | inline |
| `resolve` | hierarchy-line-1 | inline |
| `api` | browser-code-2 | inline |
| `skill-file` | zoom-document | inline |
| `badge` | star-badge | inline + nav (rest/active) |
| `self-host` | database-server-2 | inline |
| `settings` | vertical-slider-2 | inline |
| `revoke` | credit-card-disable | inline |
| `rotate` | rotate-right | inline |
| `kill-switch` | button-power-circle-1 | inline |
| `link` | link-chain | inline |
| `external-link` | link-share-2 | inline |

The remaining murmur icons (`seal`, `confirm-live`, `market`, `dispute`,
`leaderboard`, `feed`, `webhook`, `x402`, `mcp`, `live-dot`, `copy`, plus the
`market`/`leaderboard`/`feed`/`confirm-live` nav pairs) are original artwork,
not derived from Streamline or any third-party set — see the sourcing note
at the top of `icons.tsx` for why each one stayed hand-drawn.
