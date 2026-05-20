# Operator-Blind FHE Round-Trip — Release-Gate Script

Runtime counterpart to the Lean V1 / V2 invariants. V1 + V2 prove the *contract*
can't leak plaintext early; this script proves the *daemon* and *dashboard* can't
either. It runs one full sealed-call lifecycle against the live Base Sepolia
deployment of `MurmurSealedVerdicts` + the local daemon + the local dashboard,
takes three snapshots, and asserts plaintext is absent before reveal and present
after. Implements the design at
[`docs/superpowers/specs/2026-05-19-operator-blind-roundtrip-design.md`](../../docs/superpowers/specs/2026-05-19-operator-blind-roundtrip-design.md).

This is a **release-gate** check, not CI. It requires a funded Base Sepolia EOA,
takes ~7 minutes wall-clock, and is run by hand before any prod deploy.

## What it asserts (3 assertions across 3 snapshots)

- **A1 — Daemon DB is opaque pre-reveal.**
  After `submitSealedFor` lands and the daemon indexes `SealedCallSubmitted`,
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

- **A3 — Daemon DB + UI carry plaintext post-publish.**
  After `publishReveal` lands and the daemon indexes `VerdictRevealed`, both
  the API and DOM must surface the plaintext confidence sentinel. This is the
  symmetric check: A1 + A2 without A3 could pass on a silently broken daemon
  that never indexes anything.

## Prerequisites

1. **Local stack up:**
   - Daemon running and reachable at `DAEMON_URL` (its `/v1/health` returns 200).
   - Dashboard running and reachable at `DASHBOARD_URL` (its `/` returns 200).
   - Both pointed at the same Base Sepolia node as `BASE_RPC_URL`.

2. **Funded EOA on Base Sepolia.**
   The relayer key in `FHENIX_GATEWAY_RELAYER_PRIVATE_KEY` is also used as the
   "agent" address for the test call. It needs Base Sepolia ETH for ~4 txs
   (`registerFixedRevealMarket`, `submitSealedFor`, `openReveal`,
   `publishReveal`).

3. **Playwright Chromium browser installed.**
   ```sh
   npx playwright install chromium
   ```
   The `playwright` npm package is a devDep on this repo. The browser binary
   is a separate one-time download that lives outside `node_modules`.

4. **Deployment manifest populated.** `data/deployments.json` must already
   carry the live Base Sepolia `MurmurSealedVerdicts` deployment for chain
   `84532`. The script aborts with a clear error if not.

## Required env vars

| Var | Used for |
|---|---|
| `BASE_RPC_URL` | viem public + wallet client transport |
| `FHENIX_GATEWAY_RELAYER_PRIVATE_KEY` | the EOA that signs all four lifecycle txs |
| `DAEMON_URL` | base URL of the running local daemon (no trailing slash) |
| `DASHBOARD_URL` | base URL of the running local dashboard (no trailing slash) |

Optional:

- `AGENT_ADDRESS` — override the on-chain "agent" address used in
  `submitSealedFor`. Defaults to the relayer's own EOA address.

Loaded via `dotenv/config` (the repo's existing convention). Pre-flight aborts
loudly if any of the four required vars are missing.

## How to run

```sh
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
[operator-blind] PASS runId=ob-1715812345-7531 callId=0xabc… elapsed=412s
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
