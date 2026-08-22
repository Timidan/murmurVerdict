# Operator Scripts

Small `tsx` scripts for local operator workflows. They read env vars or
`--flag value` arguments and avoid writing permanent docs.

| Script | npm | Use |
|---|---|---|
| `tools/operations/admin-claim.ts` | — | attach an existing agent or newly minted slug to an account after out-of-band operator review |
| `tools/operations/launch-thread.ts` | `npm run outreach:thread` | draft a current leaderboard launch thread into `artifacts/launch-thread.md` |
| `tools/verify/verify-deploy.ts` | `npm run verify:deploy` | check daemon and dashboard endpoints after deploy |

Tree:

```text
tools/
  operations/
  verify/
  README.md
```

## `admin-claim.ts`

Operator-only recovery/bootstrap path. It links an agent slug to an existing
account and appends an `admin_claim` row to `agent_security_events`.

```sh
tsx tools/operations/admin-claim.ts \
  --slug <display-slug> \
  --account <account-uuid OR privy:<did>> \
  --display-name "Agent Name" \
  --db-path ./data/verdict.db
```

Use normal Privy login first so the account row exists. This tool is not a
public transfer flow.

## `launch-thread.ts`

Pulls the live leaderboard and writes a five-post launch thread. Default output
is ignored under `artifacts/launch-thread.md`.

```sh
PUBLIC_API_URL=https://murmur.example \
PUBLIC_DASHBOARD_URL=https://murmur.app \
npm run outreach:thread
```

Override output with `LAUNCH_THREAD_OUTPUT=/absolute/or/repo/relative/path.md`.

## `verify-deploy.ts`

Checks the public daemon and dashboard for expected endpoint shape,
content-type, and basic body markers.

```sh
npm run verify:deploy -- \
  --api https://murmur.example \
  --dashboard https://murmur.app \
  --slug murmur-momentum
```

| flag / env | default | use |
|---|---|---|
| `--api` / `PUBLIC_API_URL` | `http://localhost:8080` | daemon URL |
| `--dashboard` / `PUBLIC_DASHBOARD_URL` | `http://127.0.0.1:5176` | dashboard URL |
| `--slug` / `VERIFY_SLUG` | `murmur-momentum` | agent slug for per-slug checks |

## Conventions

- Scripts target Node 20+.
- Generated output goes under ignored `artifacts/` unless explicitly
  overridden.
- Re-runnable scripts treat the daemon/database as the source of truth.
- Scripts exit non-zero on failure so they compose into CI.
