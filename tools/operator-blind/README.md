# Operator-Blind FHE Round-Trip — Release-Gate Script

> **Arbitrum copy:** the tool now targets Arbitrum Sepolia (421614) and reads
> `ARBITRUM_RPC_URL`. Follow [the Arbitrum runbook](../../ARBITRUM.md).
> Base network references and past results below are historical evidence only.

> **NOTE:** the Lean V1 / V2 invariants model a PREVIOUS contract revision and
> do NOT cover the current six-instant schedule contract. See
> `contracts/proofs/MurmurFV/README.md`. This script's runtime evidence stands
> on its own; do not present it as backed by current formal verification.

Runtime counterpart to the Lean V1 / V2 invariants. Those theorems proved the
*contract* can't make a verdict public early; this script checks that the
*daemon's API* and the *dashboard* don't surface one either. It inspects HTTP
responses and the rendered DOM — never the database — so read the scope note
below before citing it. It runs one full sealed-call lifecycle against the live Base Sepolia
deployment of `MurmurSealedVerdicts` + the local daemon + the local dashboard,
takes three snapshots, and asserts the plaintext sentinel is absent from those
surfaces before reveal and present after.

This is a **release-gate** check, not CI. It requires a funded Base Sepolia EOA,
takes ~7 minutes wall-clock, and is run by hand before any prod deploy.

## What this does and does NOT demonstrate

This runs against `/v2/gateway/calls/seal`, the SERVER-SEALED path, where the
daemon receives the plaintext verdict by design. The three assertions below
inspect the HTTP response and the rendered DOM — nothing reads SQLite. So they
prove the daemon does not SURFACE that plaintext before reveal, through its API
or its UI. They do NOT prove Murmur never saw it (on this path it did), and
they do NOT prove it was never written to disk — no assertion here opens the
database.

The path where Murmur never holds plaintext is `/v2/gateway/calls`: the client
seals locally and only ciphertext handles ever reach the daemon. That property
lives in the client, so no server-side script can assert it.

Do not cite this run as evidence of operator-blindness in general. Cite it for
what it is: the daemon and dashboard do not leak a verdict they were handed.

## What it asserts (3 assertions across 3 snapshots)

- **A1 — The daemon's API response is opaque pre-reveal.**
  After `/v2/gateway/calls/seal` accepts and the daemon Gateway records the submit,
  `GET /v1/calls/<callId>` returns ciphertext handles
  (`fhenix.binary_index_ct_hash`, `fhenix.confidence_ct_hash`) but no
  `fhenix.revealed_verdict` sub-object. A per-run randomized confidence sentinel
  (5100-9500 bps) is searched in the response via BOTH
  `JSON.stringify(resp).includes("<sentinel>")` AND a deep numeric walk over
  every numeric leaf. Either hit fails the assertion.

- **A2 — Dashboard render is masked pre-reveal.**
  Playwright Chromium navigates headless to
  `${DASHBOARD_URL}/#/calls/<callId>` (the dashboard uses hash routing). The
  rendered DOM must NOT contain the confidence sentinel anywhere in
  `document.body.innerText`. The page must show the sealed affordance
  (`fhenix sealed` chip + the literal text `sealed`). A screenshot is captured
  to `screenshots/pre-<runId>.png` for human inspection.

- **A3 — The API response + UI carry plaintext post-publish.**
  After `publishReveal` lands and the daemon indexes `VerdictRevealed`, both
  the API and DOM must surface the plaintext confidence sentinel. This is the
  symmetric check: A1 + A2 without A3 could pass on a silently broken daemon
  that never indexes anything.

## Prerequisites

1. **Local stack up:**
   - Daemon running and reachable at `DAEMON_URL` (its `/v1/health` returns 200).
   - Dashboard running and reachable at `DASHBOARD_URL` (its `/` returns 200).
   - Both pointed at the same Base Sepolia node as `BASE_RPC_URL`.

2. **Seeded Gateway fixture.**
   Run `tsx tools/seed-operator-blind-fixtures.ts` before the round-trip. It
   writes real account / agent / controller-wallet / Runtime Key / market rows
   into the daemon DB and registers the deterministic test market on-chain.

3. **Funded EOA on Base Sepolia.**
   `FHENIX_GATEWAY_RELAYER_PRIVATE_KEY` pays for the Gateway submit tx and the
   script's `openReveal` / `publishReveal` txs. `AGENT_ADDRESS` must match the
   seeded controller wallet.

4. **Playwright Chromium browser installed.**
   ```sh
   npx playwright install chromium
   ```
   The `playwright` npm package is a devDep on this repo. The browser binary
   is a separate one-time download that lives outside `node_modules`.

5. **Deployment manifest populated.** `data/deployments.json` must already
   carry the live Base Sepolia `MurmurSealedVerdicts` deployment for chain
   `84532`. The script aborts with a clear error if not.

## Required env vars

| Var | Used for |
|---|---|
| `BASE_RPC_URL` | viem public + wallet client transport |
| `FHENIX_GATEWAY_RELAYER_PRIVATE_KEY` | Gateway relayer / reveal EOA private key |
| `AGENT_ADDRESS` | seeded controller wallet EOA |
| `OPERATOR_BLIND_RUNTIME_KEY` | `runtime_key_secret` printed by the seed tool |
| `DAEMON_URL` | base URL of the running local daemon (no trailing slash) |
| `DASHBOARD_URL` | base URL of the running local dashboard (no trailing slash) |
| `FHENIX_GATEWAY_ENABLED=true` | enables Gateway broadcasters in the daemon |
| `MURMUR_OWNED_SEALING_ENABLED=true` | **required** — this script submits `privacy_mode: "murmur_sealed_fhenix"`, and the flag now defaults to false |
| `FHENIX_RPC_URL` / `FHENIX_CHAIN_ID` | daemon Gateway RPC configuration |

Optional:

- `OPERATOR_BLIND_MARKET_ID` — override the deterministic fixture market ID.

Loaded via `dotenv/config` (the repo's existing convention). Pre-flight aborts
loudly if any required var is missing.

## How to run

```sh
tsx tools/seed-operator-blind-fixtures.ts
export OPERATOR_BLIND_RUNTIME_KEY="<runtime_key_secret from seed stdout>"
# Set FHENIX_GATEWAY_ENABLED=true in .env, then restart the daemon.
tsx tools/operator-blind-roundtrip.ts
```

That's the only invocation. There is intentionally NO `npm run` shortcut — the
spec (§8) calls this out to keep the script out of accidental `npm run` muscle
memory. Pre-deploy operators reach for it by typing it explicitly.

Wall-clock: ~7 minutes (90s reveal-window wait + up to 300s threshold-network
decrypt latency + tx confirmations + the two snapshot delays).

## What a PASS looks like

Stdout walks through nine labelled steps, ending in something like:

```text
[operator-blind] PASS runId=ob-1715812345-7531 callId=<daemon-call-id> onchainCallId=0xabc… elapsed=412s
[operator-blind]   A1 daemon opaque pre-reveal: ok
[operator-blind]   A2 dashboard masked pre-reveal: ok
[operator-blind]   A3 daemon + dashboard carry plaintext post-publish: ok
[operator-blind]   screenshots: tools/operator-blind/screenshots/pre-ob-…png
[operator-blind]                tools/operator-blind/screenshots/post-ob-…png
```

Exit code `0`.

## What a FAILURE looks like

Each assertion prints the offending excerpt before exiting non-zero. Examples:

- **A1 fail (daemon leak):** `[operator-blind] A1 FAIL: daemon response contains
  confidence sentinel 7531 — excerpt: …` followed by the snippet of the
  daemon JSON that included the plaintext. Exit `1`.

- **A2 fail (dashboard leak):** `[operator-blind] A2 FAIL: dashboard DOM
  contains confidence sentinel 7531 — innerText excerpt: …`. Exit `1`.

- **A3 fail (post-publish daemon never surfaced plaintext):** `[operator-blind]
  A3 FAIL: GET /v1/calls/<callId> returned no fhenix.revealed_verdict after
  publishReveal landed at tx 0x… and the daemon was given 60s to index.`
  Exit `1`.

- **Pre-flight fail:** `[operator-blind] pre-flight FAIL: DAEMON_URL
  http://localhost:8080 unreachable (ECONNREFUSED)`. Exit `1`. No txs were
  sent on-chain, no gas was spent.

There is **no silent retry on operator-blind assertions** — a leak is a leak,
not a flake. The indexer-lag poll is bounded at 60s and produces a distinct
diagnostic when it times out (so an unhealthy daemon never produces a
privacy-pass).

## Sentinel randomization

Each run generates a fresh `runId = "ob-<unix-ms>-<sentinel>"` and a fresh
`sentinelConfidence` uniformly in `[5100, 9500]` (the contract's
`MurmurSealedVerdicts.sol:310-313` valid band for confidence_bps). Re-running
the script picks a new sentinel, so a cached pre-reveal dashboard render from a
previous run can't false-positive A2.

## Spec-vs-daemon contract pinning

The spec's §13 pins the daemon's `revealed_verdict` sub-object field names as
`binary_index` and `confidence_bps` (verified against
[src/verdict/api.ts:2269-2272](../../src/verdict/api.ts)). The script asserts
on those exact names. If the daemon projection drifts, A3 will fail with a
clear `expected key X but got keys [a, b, c]` diagnostic — that's contract
drift, not a privacy leak. Fix the daemon and the spec + this script in
lockstep.

## What this does NOT prove

- That the daemon source code is free of plaintext-leak bugs in untested code
  paths. It proves the *observed runtime* doesn't leak on the single tested
  call.
- That CoFHE crypto is sound — that's the sibling smoke's job
  (`src/integrations/murmur-sealed-verdicts.live-smoke.ts`) and ultimately
  Fhenix's job.
- That the dashboard is safe from XSS / CSP / other web vulns. Operator-
  blindness is one property among many.

## When to run

Before any prod deploy of the dashboard or daemon, after the local stack is
known to come up cleanly against the live Base Sepolia contracts. This is the
runtime gate for the contractual claim "Murmur never sees your verdict before
it's public".
