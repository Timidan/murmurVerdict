# Murmur Verdict — Lean 4 formal-verification slice

> ## ⚠️ STALE — DOES NOT MODEL THE CURRENT CONTRACT
>
> This slice models a **previous revision** of `MurmurSealedVerdicts.sol` and
> its results **must not be cited** for the deployed contract.
>
> Since these proofs were written the contract gained:
>
> - a six-instant `Market` schedule (`armCloseAt`, `submissionOpenAt`,
>   `earlyAccessCutoffAt`, `submissionCloseAt`, `resolutionAt`,
>   `publicRevealAt`), replacing the `horizonSeconds` / `fixedRevealAfter`
>   pair the model still describes;
> - one-shot `registerMarket` (re-registration reverts) in place of the
>   overwriting `registerMarket` / `registerFixedRevealMarket` constructors
>   the model references — those functions no longer exist;
> - a half-open submission window enforced on-chain;
> - `SubmissionClass` (EarlyAccess / LateUnsellable) stamped per call;
> - feed packets taking their reveal time from the market embargo instead of
>   a caller-supplied `revealAfter`.
>
> It **also predates** `grantors`, `decryptAccessGranted`, `setGrantor` and
> `grantDecryptAccess` — the paid decrypt-grant surface has never been
> modelled at all, so the state and transition set were already incomplete
> before this migration.
>
> The escrow invariants (E1–E3) are unaffected by these changes; the
> sealed-verdict invariants (V1, V2, and the feed variant) are not.
>
> **Do not describe murmur's current contracts as formally verified until this
> is remodelled and re-proved.**


Proves 6 invariants on the on-chain contracts (`MurmurEscrow.sol`,
`MurmurSealedVerdicts.sol`). Lean 4.29.1, no mathlib, no `sorry`, two
declared axioms.

## What this proves

- **E1 — `MurmurFV.Escrow.fundsConservation`** — at every reachable
  state, the sum of `paidAmount` across requests in `{Pending,
  Committed}` equals `USDC.balanceOf(escrow)`.
- **E2 — `MurmurFV.Escrow.singleCommit`** — for any `requestId`, at most
  one `commitSignal` ever appears in a reachable trace.
- **V1 — `MurmurFV.SealedVerdicts.handleImmutability`** — once
  `submitSealedFor` writes a call's FHE handle bytes (`binaryIndex`,
  `confidenceBps`), those bytes never change.
- **V1Feed — `MurmurFV.SealedVerdicts.feedPacketHandleImmutability`** —
  same for feed packets (`action`, `signalBps`).
- **V2 — `MurmurFV.SealedVerdicts.revealTimeGating`** —
  `openReveal(callId, now)` only succeeds when `now ≥ revealOpenAt`;
  `revealOpenAt` is set once at submit and never re-mutated
  (`MurmurFV.SealedVerdicts.revealOpenAtImmutable`).
- **V2Feed — `MurmurFV.SealedVerdicts.feedRevealTimeGating`** — same for
  feed packets, with `revealAfter` in place of `revealOpenAt`
  (`MurmurFV.SealedVerdicts.feedRevealAfterImmutable`).

## What this does NOT prove

Out of scope per spec §4 / §10:

- EVM-level reentrancy (the model is atomic per `step`; reentrancy
  guards are informational fields).
- FHE crypto soundness (`FHE.verifyDecryptResult` is treated as a
  black-box success predicate).
- Gas, calldata bounds, or stack-depth limits.
- Front-running / MEV / commit-front-running.
- Token donations / hooks beyond standard ERC-20 (USDC has none; see
  `NoDonation` axiom).
- The other ~14 entry points beyond what V1/V2's 12-arm case-bash
  covers (already covered: all 12 `SealedVerdicts` externals; for E1/E2,
  all 12 `Escrow` externals).
- `marketDataCutoff`: stored by `commitSignal` in Solidity but not
  modelled in `InferenceRequest` — it's input-freshness metadata and
  doesn't participate in any of E1/E2.
- `requestCount` and request-ID derivation: the model receives an abstract
  fresh request ID instead of reproducing Solidity's per-pipeline counter.
  See `InvariantMap.md` for the resulting trace under-approximation.
- Mechanical correspondence to Solidity: this is a reviewed hand-translation;
  Solidity changes do not automatically invalidate or rebuild the Lean model.

## Install + build (Lean 4.29.1 via elan)

```bash
# Install elan (Lean's toolchain manager):
curl -sSf https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh \
  | sh -s -- --default-toolchain none -y
source $HOME/.elan/env

# Pull Lean 4.29.1 (project pins this version via lean-toolchain):
elan toolchain install leanprover/lean4:v4.29.1

# Build the proofs:
cd contracts/proofs/MurmurFV
lake build
```

Expected: clean build in ~5 seconds (`Build completed successfully
(17 jobs).`). No warnings, no `sorry`, exactly 2 declared axioms.

## Project layout

```
contracts/proofs/MurmurFV/
├── lean-toolchain         pins leanprover/lean4:v4.29.1
├── lakefile.lean          one default target: lean_lib `MurmurFV`
├── lake-manifest.json     empty packages array (no external deps)
├── MurmurFV.lean          aggregate-import module (re-exports everything)
└── MurmurFV/
    ├── Common/
    │   ├── Bytes32.lean   opaque bytes32 with DecidableEq
    │   ├── Address.lean   opaque address with DecidableEq
    │   ├── Token.lean     abstract ERC-20 + NoDonation axiom
    │   └── Time.lean      BlockTime alias + BlockTimeMonotone axiom
    ├── Escrow/
    │   ├── State.lean         Pipeline, RequestState, InferenceRequest, EscrowState
    │   ├── Transitions.lean   12 Transition constructors + step function
    │   ├── InvariantE2.lean   Reachable predicate + singleCommit theorem
    │   └── InvariantE1.lean   ReachableWF + fundsConservation theorem
    └── SealedVerdicts/
        ├── State.lean             MarketKind, Market, CallState, SealedCall,
        │                          SealedFeedPacket, SealedVerdictsState
        ├── Transitions.lean       12 Transition constructors + step function
        ├── InvariantV1.lean       handleImmutability theorem
        ├── InvariantV1Feed.lean   feedPacketHandleImmutability theorem
        ├── InvariantV2.lean       revealOpenAtImmutable + revealTimeGating
        └── InvariantV2Feed.lean   feedRevealAfterImmutable + feedRevealTimeGating
```

See `Model.md` for the field-by-field translation between Solidity and
Lean, and `InvariantMap.md` for the theorem-to-Solidity-function map.

## Axioms

There are exactly 2 axioms in this project:

- **`NoDonation` (`MurmurFV/Common/Token.lean:56`)** — auditable
  invocation point for the closed-world balance assumption. The model
  treats `step` as the only mutator of token balances, so this is
  automatically true under the abstract model; declared explicitly so
  reviewers can grep for it. E1's `fundsConservation` does not invoke
  it — the `ReachableWF` relation is already closed under `step` (no
  donation vocabulary in the `Transition` inductive).
- **`BlockTimeMonotone` (`MurmurFV/Common/Time.lean:9`)** — placeholder
  for trace-level monotonicity claims (`∀ t₁ t₂, t₁ ≤ t₂ ∨ t₂ ≤ t₁`,
  trivially true on `Nat`). Currently no proof invokes it (E2's
  argument is state-based via the request-state guard, not
  time-ordering).

Run `grep -rn "^axiom " contracts/proofs/MurmurFV/MurmurFV/` to verify.

## How to add a new invariant

1. Pick a layer (`Escrow/` or `SealedVerdicts/`). Create a new file
   alongside the existing invariants, e.g.
   `MurmurFV/Escrow/InvariantE3.lean`.
2. Import `MurmurFV.Escrow.Transitions` (or for a trace-level
   invariant, `MurmurFV.Escrow.InvariantE2` to reuse the `Reachable`
   predicate; or `MurmurFV.Escrow.InvariantE1` for `ReachableWF`).
3. Write the theorem signature with `:= by sorry`, run `lake build`
   to confirm the statement type-checks.
4. Replace `sorry` with a tactic proof. The existing invariants share
   a case-bash pattern over the 12 `Transition` constructors (V1/V1Feed
   and V2/V2Feed are good templates for single-step claims; E2 is a
   template for `Reachable`-induction claims).
5. Add the import to the root `MurmurFV.lean` so the new file is part
   of the default lib target.
6. Run `lake build` again; verify exit 0 and `grep "sorry" .` returns
   nothing in the project sources.

## Verification commands

```bash
# Build (must exit 0):
cd contracts/proofs/MurmurFV && lake build

# No `sorry` (must return 0 matches):
grep -rn "sorry" contracts/proofs/MurmurFV/MurmurFV/

# Only the two declared axioms (must return exactly 2 axiom-keyword lines):
grep -rn "^axiom " contracts/proofs/MurmurFV/MurmurFV/
```
