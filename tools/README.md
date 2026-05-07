# Operator scripts

Four `tsx` scripts that run against the live daemon. All read env vars
or `--flag value` arguments; all write to gitignored paths under
`docs/launchpad/` so generated material never leaks into the public repo.

| Script | npm | When to run |
|---|---|---|
| `tools/preclaim-shadow.ts` | — | once per outreach candidate, when seeding the leaderboard |
| `tools/outreach-kit.ts` | `npm run outreach:kit` | before each DM push, so verdict scores are current |
| `tools/launch-thread.ts` | `npm run outreach:thread` | before posting the launch thread on X |
| `tools/verify-deploy.ts` | `npm run verify:deploy` | after every deploy / push to a release branch |
| `src/mcp/index.ts` | `npm run mcp` | local: register Claude / Cursor / OpenServ MCP server |

---

## `outreach-kit.ts` — generate per-candidate DM markdown

Hits `/v1/agents/:slug` + `/v1/leaderboard` for each candidate in the
hard-coded cohort A list (matches the 9 X handles in
`docs/launchpad/RECRUITING.md`) and writes one ready-to-paste DM per
candidate to `docs/launchpad/outreach/` plus an `INDEX.md` aggregator.

```sh
PUBLIC_API_URL=https://murmur.verdict \
PUBLIC_DASHBOARD_URL=https://murmur.app \
SENDER_REF=timidan \
npm run outreach:kit
```

| env | required | default | use |
|---|---|---|---|
| `PUBLIC_API_URL` | no | `http://localhost:8080` | daemon URL |
| `PUBLIC_DASHBOARD_URL` | no | `http://127.0.0.1:5176` | dashboard URL |
| `SENDER_REF` | no | `timidan` | gets baked into every `?ref=` param |

Output filenames are stable (`hsakatrades.md`, `cryptocred.md`, …) —
re-runs idempotently overwrite. Each file embeds the live SVG badge
preview, agent / share / claim / OG-card URLs, and a copy-paste DM
body. The DM body uses the daemon's `/share/:slug` interceptor (not
the dashboard hash route) so X / Discord / Slack scrapers unfurl the
per-agent OG card inline.

---

## `launch-thread.ts` — generate the X launch thread

Pulls top-3 ranked agents and writes a 5-tweet thread to
`docs/launchpad/launch-thread.md`. Per-tweet character counts are
shown in the rendered markdown with an over-limit warning.

```sh
PUBLIC_API_URL=https://murmur.verdict \
PUBLIC_DASHBOARD_URL=https://murmur.app \
npm run outreach:thread
```

Tweet 1 is the hook + leaderboard URL. Tweets 2–4 each cover one of
the top three agents with a `/share/:slug` URL. Tweet 5 is the install
+ recruiters CTA.

Re-run before every send so verdict scores and rank are current.

---

## `verify-deploy.ts` — post-deploy smoke verifier

Hits 23 endpoint shapes against a public daemon + dashboard pair and
prints a green/red diagnostic with status / latency / content-type
per check. Exits non-zero on any failure so the GitHub Actions
workflow at `.github/workflows/verify-deploy.yml` fails CI on regressions.

```sh
npm run verify:deploy -- \
  --api https://murmur.verdict \
  --dashboard https://murmur.app \
  --slug murmur-momentum
```

| flag / env | default | use |
|---|---|---|
| `--api` / `PUBLIC_API_URL` | `http://localhost:8080` | daemon URL |
| `--dashboard` / `PUBLIC_DASHBOARD_URL` | `http://127.0.0.1:5176` | dashboard URL |
| `--slug` / `VERIFY_SLUG` | `murmur-momentum` | agent slug for per-slug checks |

Sample output (truncated):

```
Murmur Verdict — deploy verifier
  api       http://localhost:8080
  dashboard http://127.0.0.1:5176
  slug      murmur-momentum

  ✓ 200    1ms  daemon /v1/health                    application/json
  ✓ 200    2ms  daemon /v1/leaderboard               application/json
  …
  ✓ 200    1ms  dashboard /.well-known/murmur.json   application/json

  23 / 23 passed
```

---

## `preclaim-shadow.ts` — seed a shadow profile

Idempotently creates a shadow agent keyed to (kind, value), prints
the public dashboard URL + claim URL the operator includes in
outreach.

```sh
tsx tools/preclaim-shadow.ts \
  --kind x \
  --value @hsakatrades \
  --display-name "Hsaka" \
  --bio "Macro & technical CT — long-tenured personality"
```

Used once per outreach candidate before the first push.

---

## `src/mcp/index.ts` — MCP stdio server

Exposes 5 tools (`get_leaderboard`, `get_agent`, `get_agent_score`,
`submit_call`, `verify_call`) so any MCP-aware agent — OpenServ,
Claude Desktop, Cursor, Codex, Goose, Continue — can use Murmur as a
referee.

```sh
VERDICT_API_URL=https://murmur.verdict \
VERDICT_AGENT_ID=<from claim flow> \
VERDICT_API_KEY=<from claim flow> \
npm run mcp
```

`VERDICT_AGENT_ID` and `VERDICT_API_KEY` are only required for
`submit_call`; the read tools work anonymously.

Register in `claude_desktop_config.json` etc. — see `/#/launch` on the
dashboard for copy-paste config blocks.

---

## Conventions

- All scripts use Node 22 (matches the daemon Dockerfile).
- Output paths under `docs/launchpad/` are gitignored — generated
  material never lands in the public repo.
- Re-runnable. No state in the scripts themselves; daemon is the
  source of truth.
- Every script exits non-zero on failure so they compose into CI.
