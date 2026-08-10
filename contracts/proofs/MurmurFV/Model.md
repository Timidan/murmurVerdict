# Model — abstract state machines

> **⚠️ STALE for `MurmurSealedVerdicts`.** The sealed-verdict half of this
> model describes a previous contract revision: it still has a single
> `revealOpenAt` derived from `horizonSeconds` / `fixedRevealAfter`, and
> references constructors that no longer exist. It has never modelled the
> grantor / decrypt-ACL surface. See `README.md` for the full delta. The
> escrow half is unaffected.


The Lean project is a hand-translation of two Solidity contracts
(`contracts/src/MurmurEscrow.sol`, `contracts/src/MurmurSealedVerdicts.sol`)
into abstract state machines. Each contract becomes
`<Name>State` (record) + `Transition` (inductive) + `step :
<Name>State → Transition → Option <Name>State`. Invariants are
theorems quantified over the reachable closure of `step`.

## Common layer (`MurmurFV/Common/`)

### `Bytes32.lean`

```
structure Bytes32 where
  raw : Nat
deriving DecidableEq, Repr
```

Opaque value type for Solidity `bytes32`. Nothing in the proofs ever
inspects `raw`; `DecidableEq` is enough.

### `Address.lean`

Same shape as `Bytes32`. Distinct nominal type so the type-checker
catches address/hash mix-ups.

### `Token.lean`

```
structure TokenState where
  balanceOf : Address → Nat

def TokenState.transfer     (s : TokenState) (from_ to_ : Address) (amount : Nat) : Option TokenState
def TokenState.transferFrom (s : TokenState) (from_ to_ : Address) (amount : Nat) : Option TokenState

axiom NoDonation : True
```

Abstract ERC-20. `transfer` returns `none` (revert) when the source
balance is insufficient; otherwise updates exactly two balances by the
amount. `transferFrom` is identical at the state-machine level: the
allowance mapping is not modelled (Solidity enforces it on-chain;
removing it from the Lean model just shrinks the spec). No hooks /
callbacks — matches USDC reality.

`NoDonation` is declared but currently unused. The `Transition`
inductive in `Escrow/Transitions.lean` has no constructor that lets an
external party transfer USDC into the escrow outside `RequestInference`,
so `fundsConservation` proves `liveSumList = balanceOf` directly from
the closed `ReachableWF` vocabulary without invoking the axiom. See
`MurmurFV/Common/Token.lean` for the Codex review verdict that made this
an honest placeholder rather than a claimed proof dependency.

### `Time.lean`

```
abbrev BlockTime : Type := Nat
axiom BlockTimeMonotone : ∀ (t₁ t₂ : BlockTime), t₁ ≤ t₂ ∨ t₂ ≤ t₁
```

`block.timestamp` modelled as a free `Nat` per transition. Each
`step`-arm that takes a `now` argument writes `s.blockTime := now` on
success; nothing forces consecutive transitions to use a monotone
`now`. `BlockTimeMonotone` is declared but currently unused: the V2 and
V2Feed reveal-gating corollaries discharge the successful-open ordering
from the rejected `now < reveal...` guard via `Nat.not_lt.mp`. See
`MurmurFV/Common/Time.lean` for the Codex review verdict that made this
an audit hook rather than a load-bearing axiom.

## Escrow layer (`MurmurFV/Escrow/`)

### State (`State.lean`)

#### `Pipeline` — `MurmurEscrow.sol:73-79`

| Solidity field        | Lean field            |
|-----------------------|-----------------------|
| `address agentOwner`  | `agentOwner : Address`|
| `uint96 priceUsdc`    | `priceUsdc : Nat`     |
| `uint32 slaSeconds`   | `slaSeconds : Nat`    |
| `uint32 horizonHours` | `horizonHours : Nat`  |
| `bool active`         | `active : Bool`       |

#### `RequestState` — `MurmurEscrow.sol:55-62`

Identical 6-variant enum (`None`, `Pending`, `Committed`, `Finalized`,
`Refunded`, `Canceled`). `DecidableEq` lets proofs split on equality;
`noConfusion` rules out the case where two distinct constructors are
equal (used in E1 and E2 to discharge `state = Pending` contradictions
in arms that wrote a non-`Pending` state).

#### `InferenceRequest` — `MurmurEscrow.sol:81-94`

| Solidity field        | Lean field             |
|-----------------------|------------------------|
| `bytes32 pipelineId`  | `pipelineId : Bytes32` |
| `address buyer`       | `buyer : Address`      |
| `uint96 paidAmount`   | `paidAmount : Nat`     |
| `uint64 paidAt`       | `paidAt : Nat`         |
| `uint64 slaDeadline`  | `slaDeadline : Nat`    |
| `bytes32 commitHash`  | `commitHash : Bytes32` |
| `bytes32 marketDataCutoff` | (omitted)         |
| `uint64 committedAt`  | `committedAt : Nat`    |
| `RequestState state`  | `state : RequestState` |
| `uint16 protocolFeeBps` | `protocolFeeBps : Nat` |

The Solidity field `marketDataCutoff` is intentionally omitted. It's
operator-declared input-freshness metadata; no E1/E2 reasoning depends
on it. `commitSignal` takes it as an argument and the abstract model
discards it (`_marketDataCutoff` in the `CommitSignal` arm).

The model uses `paidAt + slaSeconds` to compute `slaDeadline` at
`RequestInference` time; this matches the Solidity body at
`MurmurEscrow.sol:264` (`slaDeadline: nowTs + p.slaSeconds`). The
project initially stored `acceptedAt` instead of `slaDeadline` and was
realigned in commit `93564eb` to match Solidity layout.

Wave K added the per-request `protocolFeeBps` snapshot. `RequestInference`
copies the storage fee bps into the request, and `Finalize` reads that
snapshot rather than the live storage value.

#### `EscrowState` — aggregate

```
structure EscrowState where
  owner             : Address
  pendingOwner      : Address    -- present in Lean; contract has 1-step ownership (see TransferOwnership)
  protocolFeeBps    : Nat
  protocolFeeSink   : Address
  paused            : Bool
  locked            : Bool       -- abstract no-op; reentrancy is informational
  pipelines         : Bytes32 → Option Pipeline
  requests          : Bytes32 → Option InferenceRequest
  token             : TokenState
  escrowAddr        : Address
  blockTime         : BlockTime
  usedAuthDigest    : Bytes32 → Bool                       -- Wave L.B
  allowlist         : Address → Option AllowlistEntry      -- Wave L.B
  allowlistProposed : Address → Option AllowlistProposal   -- Wave L.B
```

Wave L.B added three function fields:

- `usedAuthDigest : Bytes32 → Bool` — EIP-712 replay-protection register
  mirroring `MurmurEscrow.sol:153`. Mutated only by a successful Sig-path
  `RequestInferenceFor` (flips one digest to `true`); read by the same
  arm as a precondition. Not part of `WellFormed` — `liveSumList` and
  `balanceOf escrowAddr` are unaffected by its value.
- `allowlist : Address → Option AllowlistEntry` — strict integration
  allowlist storage mirroring `MurmurEscrow.sol:169`. `none` abstracts
  "deleted/default storage slot." Active-allowlisted is the stricter
  predicate `s.allowlist a = some entry ∧ entry.committedAt ≠ 0`; the
  five consuming arms (`RequestInferenceFor.Hooked`,
  `ProposeAllowlistRemove`, `PauseAllowlistEntry`,
  `ProposeAllowlistUnpause`, `CommitAllowlistUnpause`) all enforce it.
- `allowlistProposed : Address → Option AllowlistProposal` — pending
  two-step propose/commit state mirroring `MurmurEscrow.sol:181`. Each
  proposal carries a `kind ∈ {Add, Remove, Unpause}` discriminator
  matching Solidity's `PROPOSAL_KIND_*` constants.

The new `AllowlistEntry`, `AllowlistProposal`, and `ProposalKind`
types are defined in `State.lean` alongside the existing `Pipeline`
and `InferenceRequest`. The `BuyerAuth` inductive (carried as an
argument by `RequestInferenceFor`) is defined in `Transitions.lean`
and is NOT a state field — it's a per-call witness of the trust mode
plus the post-recovery facts (Sig: `deadline`, `signer`, `digest`;
Hooked: `callerCodehash`). The Lean model does not derive the EIP-712
digest cryptographically — it carries the digest as an argument and
proves replay protection state-based via `usedAuthDigest`.

`pipelines` and `requests` are total functions `Bytes32 → Option _`
(not Lean `Std.HashMap`). The function-field encoding eliminates a
shape mismatch between Solidity's "default-valued mapping" and Lean's
"option-typed lookup" — `s.pipelines pid = none` exactly captures
Solidity's `pipelines[pid].agentOwner == address(0)` zero-row check.

### Transitions (`Transitions.lean`)

21 constructors, one per externally-callable state-mutating function
in `MurmurEscrow.sol` (Wave K added `forceRefundCommitted`; Wave L.B
added `requestInferenceFor` + 7 allowlist admin externals):

| Constructor                  | Solidity function   | Source range        |
|------------------------------|---------------------|---------------------|
| `CreatePipeline`             | `createPipeline`    | sol:192-218         |
| `SetPipelineActive`          | `setPipelineActive` | sol:223-228         |
| `RequestInference`           | `requestInference`  | sol:233-281         |
| `CommitSignal`               | `commitSignal`      | sol:289-304         |
| `Finalize`                   | `finalize`          | sol:309-333         |
| `Refund`                     | `refund`            | sol:336-343         |
| `Cancel`                     | `cancel`            | sol:368-376         |
| `ForceRefundCommitted`       | `forceRefundCommitted` | sol:354-365     |
| `SubmitMerkleRoot`           | `submitMerkleRoot`  | sol:380-385         |
| `SetProtocolFeeBps`          | `setProtocolFeeBps` | sol:400-404         |
| `SetProtocolFeeSink`         | `setProtocolFeeSink`| sol:408-412         |
| `SetPaused`                  | `setPaused`         | sol:415-417         |
| `TransferOwnership`          | `transferOwnership` | sol:393-398         |
| `RequestInferenceFor`        | `requestInferenceFor` | sol:511-560       |
| `ProposeAllowlistAdd`        | `proposeAllowlistAdd` | sol:675-710       |
| `CommitAllowlistAdd`         | `commitAllowlistAdd` | sol:712-735        |
| `ProposeAllowlistRemove`     | `proposeAllowlistRemove` | sol:737-749    |
| `CommitAllowlistRemove`      | `commitAllowlistRemove` | sol:751-758     |
| `PauseAllowlistEntry`        | `pauseAllowlistEntry` | sol:763-768       |
| `ProposeAllowlistUnpause`    | `proposeAllowlistUnpause` | sol:770-784   |
| `CommitAllowlistUnpause`     | `commitAllowlistUnpause` | sol:786-795    |

Each arm enforces the Solidity guards as `if … then none else …`
chains. Critical guard summary:

- **`CreatePipeline`** — `!paused`; caller is owner; slot at `pid`
  empty; `agentOwner` is neither zero nor escrow; price / horizon / sla
  all positive; `slaSeconds > CANCEL_WINDOW_SECONDS`.
- **`SetPipelineActive`** — caller is owner; pipeline exists.
- **`RequestInference`** — `!paused`; pipeline exists and active;
  `requests[rid] = none` (no replay); USDC `transferFrom` succeeds;
  stores `protocolFeeBps := s.protocolFeeBps`.
- **`CommitSignal`** — `r.state = Pending`; pipeline exists; caller is
  `agentOwner`; `now ≤ r.slaDeadline`.
- **`Finalize`** — `r.state = Committed`; pipeline exists; `now ≥
  r.committedAt + p.horizonHours * 3600`; `keccakBytes(signal, nonce) =
  r.commitHash`; fee uses `r.protocolFeeBps`; both USDC transfers
  succeed.
- **`Refund`** — `r.state = Pending`; `now > r.slaDeadline`; transfer
  to buyer succeeds.
- **`Cancel`** — `r.state = Pending`; caller is `r.buyer`; `now ≤
  r.paidAt + CANCEL_WINDOW_SECONDS` (= 60); transfer to buyer succeeds.
- **`ForceRefundCommitted`** — caller is owner; `r.state = Committed`;
  pipeline exists; `now ≥ committedAt + horizonHours*3600 +
  COMMITTED_REFUND_GRACE_HOURS*3600`; transfer to buyer succeeds.
- **`RequestInferenceFor`** (Wave L.B) — `!paused`; `buyer ≠ 0` and
  `buyer ≠ escrow`; pipeline exists and active; trust-mode branch on
  the `BuyerAuth` constructor:
  - `Sig deadline signer digest`: `deadline ≠ 0`, `now ≤ deadline`,
    `s.usedAuthDigest digest = false`, `signer = buyer`; on success
    sets `usedAuthDigest digest := true`; payer = `buyer`.
  - `Hooked callerCodehash`: `s.allowlist caller = some entry`,
    `entry.committedAt ≠ 0`, `!entry.paused`, `entry.codehashPin =
    callerCodehash`, per-call / per-block / per-day caps respected
    (per-block uses `entry.spentBlockNumber == blockNumber` reset;
    per-day uses `entry.spentTodayDayUtc == now / 86400` reset); payer
    = `caller`. On success updates the `spent*` counters.
  - In both branches: `requests[rid] = none` (no replay; rid =
    `computeRequestId buyer pid nonce`); USDC `transferFrom payer
    escrow` succeeds; stores `protocolFeeBps := s.protocolFeeBps`,
    `buyer := buyer` (attested, NOT `caller`).
- **`ProposeAllowlistAdd`** (Wave L.B) — caller is owner; `integrator`
  not zero, not escrow; `integratorCodehash ≠ 0`; `codehashPin ≠ 0`;
  `codehashPin = integratorCodehash`; caps monotonic
  (`0 < perCall ≤ perBlock ≤ perDay`). Writes
  `allowlistProposed[integrator]` with `effectiveAt = now +
  ALLOWLIST_TIMELOCK_SECONDS`, `kind = Add`.
- **`CommitAllowlistAdd`** (Wave L.B) — caller is owner; matching `Add`
  proposal exists; `now ≥ prop.effectiveAt`; current
  `integratorCodehash = prop.codehashPin` (catches drift during the
  timelock window). Writes the live `allowlist[integrator]` entry and
  clears the proposal.
- **`ProposeAllowlistRemove`** (Wave L.B) — caller is owner;
  `integrator` actively allowlisted (`entry.committedAt ≠ 0`). Writes
  the proposal with `kind = Remove`.
- **`CommitAllowlistRemove`** (Wave L.B) — caller is owner; matching
  `Remove` proposal exists; timelock elapsed. Clears `allowlist`
  entry and proposal.
- **`PauseAllowlistEntry`** (Wave L.B) — caller is owner; entry
  actively allowlisted. Immediate (no timelock); flips `entry.paused
  := true`. Asymmetric with unpause (which IS timelocked).
- **`ProposeAllowlistUnpause`** (Wave L.B) — caller is owner; entry
  actively allowlisted AND currently paused. Writes proposal with
  `kind = Unpause`, `effectiveAt = now +
  ALLOWLIST_UNPAUSE_TIMELOCK_SECONDS` (24h, shorter than the add/
  remove timelock).
- **`CommitAllowlistUnpause`** (Wave L.B) — caller is owner; matching
  `Unpause` proposal; timelock elapsed; entry still active. Flips
  `entry.paused := false` and clears proposal.
- **`SubmitMerkleRoot`** — caller is owner. No state change in the
  abstract model (the Solidity `merkleRoots` mapping is not modelled).
- **`SetProtocolFeeBps`** — caller is owner; `newBps ≤
  MAX_PROTOCOL_FEE_BPS` (= 1000).
- **`SetProtocolFeeSink`** — caller is owner; new sink is neither zero
  nor escrow.
- **`SetPaused`** — caller is owner.
- **`TransferOwnership`** — caller is owner; new owner is neither zero
  nor escrow. Writes `owner = newOwner` directly (matches Solidity at
  `sol:393-398`, which does NOT use the `pendingOwner` field — this
  contract is 1-step despite the field being declared). `pendingOwner`
  stays pinned at zero in the model.

`step : EscrowState → Transition → Option EscrowState` is total and
deterministic; `none` ≡ revert; `some s'` ≡ committed new state.

### Off-chain invariants assumed by the proofs

E1 is stated with a `WellFormed s₀` precondition
(`MurmurFV/Escrow/InvariantE1.lean:1291`). The predicate is:

```lean
-- MurmurFV/Escrow/InvariantE1.lean:90-95
def WellFormed (s : EscrowState) : Prop :=
  s.escrowAddr ≠ s.protocolFeeSink ∧
  (∀ pid p, s.pipelines pid = some p → s.escrowAddr ≠ p.agentOwner) ∧
  (∀ rid r, s.requests rid = some r → s.escrowAddr ≠ r.buyer) ∧
  s.protocolFeeBps ≤ MAX_PROTOCOL_FEE_BPS ∧
  (∀ rid r, s.requests rid = some r → r.protocolFeeBps ≤ MAX_PROTOCOL_FEE_BPS)
```

`ReachableWF` also requires transition inputs that preserve those
clauses:

```lean
-- MurmurFV/Escrow/InvariantE1.lean:108-113
def WellFormedTx (s : EscrowState) (tx : Transition) : Prop :=
  match tx with
  | .RequestInference caller _ _ _ => s.escrowAddr ≠ caller
  | .CreatePipeline _ _ p          => s.escrowAddr ≠ p.agentOwner
  | .SetProtocolFeeSink _ newSink  => s.escrowAddr ≠ newSink
  | _ => True
```

These are proof preconditions. Wave K made several address-separation
facts runtime-enforced: the constructor rejects zero USDC and zero/self
fee sink, `createPipeline` rejects zero/self agent owner, and
`setProtocolFeeSink` rejects zero/self sink. `requestInference` still
records `buyer: msg.sender` (`MurmurEscrow.sol:261`). The storage bps
clause is still part of `WellFormed` and now matches Solidity's runtime
bound, `MAX_PROTOCOL_FEE_BPS = 1000` (`MurmurEscrow.sol:45`), enforced by
`if (newBps > MAX_PROTOCOL_FEE_BPS) revert FeeTooHigh();`
(`MurmurEscrow.sol:401`). New requests snapshot that contract-capped
value into `r.protocolFeeBps`.

| Clause | Why E1 needs it | Operator check | Production harm if violated |
|--------|-----------------|----------------|-----------------------------|
| `s.escrowAddr ≠ s.protocolFeeSink` (`InvariantE1.lean:91`) | `Finalize` uses it to prove the fee transfer reduces escrow balance. | Deploy script must reject a fee sink equal to the escrow address, or post-deploy set a non-escrow sink before enabling traffic. | The fee leg becomes an escrow-to-escrow transfer; the request can finalize while fee value remains trapped in escrow, so live request sum and escrow balance diverge. |
| `∀ pid p, s.pipelines pid = some p → s.escrowAddr ≠ p.agentOwner` (`InvariantE1.lean:92`) | `Finalize` uses it to prove the agent payout reduces escrow balance. | Pipeline construction must assert `agentOwner != escrowAddr` before calling `createPipeline`. | The payout leg becomes an escrow-to-escrow transfer; the request is finalized but the agent is not paid and funds remain stranded. |
| `∀ rid r, s.requests rid = some r → s.escrowAddr ≠ r.buyer` (`InvariantE1.lean:93`) | `RequestInference` uses the transition-level caller check to prove escrow balance increases; `Refund`/`Cancel` use the stored-buyer clause to prove refunds reduce escrow balance. | The x402/router path must never submit a request from the escrow address; deployment smoke tests should assert no self-call path records the escrow as buyer. | A payment or refund can degenerate to a self-transfer; request bookkeeping moves while escrow balance does not, and refunds/cancellations can leave funds stuck. |
| `s.protocolFeeBps ≤ MAX_PROTOCOL_FEE_BPS` (`InvariantE1.lean:94`) | `RequestInference` uses it to prove newly-created requests snapshot a contract-capped fee bps. | Keep `MAX_PROTOCOL_FEE_BPS <= BPS_DENOMINATOR` in contract changes and deployment checks; current Solidity caps setter input at 1000 bps (`MurmurEscrow.sol:45`, `MurmurEscrow.sol:401`). | If a future contract version allowed storage bps above the contract cap, request snapshots could diverge from the setter-enforced model; above the denominator, finalization fee arithmetic could also break. |
| `∀ rid r, s.requests rid = some r → r.protocolFeeBps ≤ MAX_PROTOCOL_FEE_BPS` (`InvariantE1.lean:95`) | `Finalize` derives `r.protocolFeeBps ≤ BPS_DENOMINATOR` from this cap and then proves `fee ≤ paidAmount` and `fee + agentPayout = paidAmount`. | `requestInference` snapshots the already-bounded storage bps (`MurmurEscrow.sol:269-271`). | If a stored request carried a bps above the contract cap, finalization could diverge from the contract-enforced snapshot invariant; above the denominator, it could overdraw pooled escrow value. |

### Pipeline authority

Wave K made pipeline administration owner-only. Both Solidity and the
Lean model now require owner authority for pipeline creation and active
flag changes.

```solidity
// MurmurEscrow.sol:223-227
function setPipelineActive(bytes32 pipelineId, bool active_) external onlyOwner {
    Pipeline storage p = pipelines[pipelineId];
    if (p.agentOwner == address(0)) revert PipelineNotFound();
    p.active = active_;
```

The Lean `step` arm mirrors that owner-only gate:

```lean
| .SetPipelineActive caller pid active =>
    if caller ≠ s.owner then none
    else
    match s.pipelines pid with
    | none => none
    | some p =>
      some { s with pipelines := updateMap s.pipelines pid (some { p with active := active }) }
```

## SealedVerdicts layer (`MurmurFV/SealedVerdicts/`)

### State (`State.lean`)

#### `MarketKind` — modelling helper

Lean-only inductive (`Rolling | FixedReveal`). Solidity discriminates
the two market kinds by the convention `fixedRevealAfter != 0 ↔
FixedReveal`; `registerMarket` and `registerFixedRevealMarket` zero out
the other field. The Lean enum captures the discriminator explicitly
so `step` can `match m.kind` instead of carrying the zero-field
convention through proofs.

#### `Market` — `MurmurSealedVerdicts.sol:44-48`

Solidity fields plus the modelling `kind`:

| Solidity field          | Lean field                |
|-------------------------|---------------------------|
| —                       | `kind : MarketKind`       |
| `uint64 horizonSeconds` | `horizonSeconds : Nat`    |
| `uint64 fixedRevealAfter`| `fixedRevealAfter : Nat` |
| `bool active`           | `active : Bool`           |

#### `CallState` — `MurmurSealedVerdicts.sol:29-35`

5-variant enum (`None | Sealed | Opened | Revealed | Invalid`). Both
`SealedCall.state` and `SealedFeedPacket.state` use this enum
(Solidity reuses it).

#### `SealedCall` — `MurmurSealedVerdicts.sol:50-60`

| Solidity field             | Lean field                  |
|----------------------------|-----------------------------|
| `address agent`            | `agent : Address`           |
| `bytes32 marketId`         | `marketId : Bytes32`        |
| `uint64 acceptedAt`        | `acceptedAt : Nat`          |
| `uint64 revealOpenAt`      | `revealOpenAt : Nat`        |
| `euint8 binaryIndex`       | `binaryIndex : Bytes32`     |
| `euint16 confidenceBps`    | `confidenceBps : Bytes32`   |
| `uint8 revealedBinaryIndex`| `revealedBinaryIndex : Nat` |
| `uint16 revealedConfidenceBps`| `revealedConfidenceBps : Nat` |
| `CallState state`          | `state : CallState`         |

The FHE handles (`euint8` / `euint16`) become `Bytes32`. In Solidity,
`FHE.unwrap` of an `euint8` is a `bytes32` ciphertext handle; V1
proves that bytes32 value never changes after submit. The plaintext
mirrors (`revealedBinaryIndex` / `revealedConfidenceBps`) are NOT
covered by V1 — they're populated at `publishReveal`.

#### `SealedFeedPacket` — `MurmurSealedVerdicts.sol:62-73`

Same shape as `SealedCall` with two divergences forced by Solidity:

- Both `feedId` and `marketId` are stored.
- The reveal-gate field is `revealAfter`, NOT `revealOpenAt`.
- Reuses `CallState` — no separate `FeedPacketState` enum exists.

| Solidity field         | Lean field             |
|------------------------|------------------------|
| `address agent`        | `agent : Address`      |
| `bytes32 feedId`       | `feedId : Bytes32`     |
| `bytes32 marketId`     | `marketId : Bytes32`   |
| `uint64 acceptedAt`    | `acceptedAt : Nat`     |
| `uint64 revealAfter`   | `revealAfter : Nat`    |
| `euint8 action`        | `action : Bytes32`     |
| `euint16 signalBps`    | `signalBps : Bytes32`  |
| `uint8 revealedAction` | `revealedAction : Nat` |
| `uint16 revealedSignalBps`| `revealedSignalBps : Nat` |
| `CallState state`      | `state : CallState`    |

#### `SealedVerdictsState` — aggregate

```
structure SealedVerdictsState where
  owner        : Address
  pendingOwner : Address       -- two-step ownership, MATCHES Solidity (sol:76, 168-173)
  relayers     : Address → Bool
  markets      : Bytes32 → Option Market
  calls        : Bytes32 → Option SealedCall
  feedPackets  : Bytes32 → Option SealedFeedPacket
  blockTime    : BlockTime
```

Unlike `MurmurEscrow`, `MurmurSealedVerdicts` does use the two-step
ownership pattern (`transferOwnership` writes `pendingOwner`;
`acceptOwnership` promotes it).

### Transitions (`Transitions.lean`)

12 constructors, one per externally-callable state-mutating function:

| Constructor                  | Solidity function           | Source range  |
|------------------------------|-----------------------------|---------------|
| `TransferOwnership`          | `transferOwnership`         | sol:162-166   |
| `AcceptOwnership`            | `acceptOwnership`           | sol:168-174   |
| `SetRelayer`                 | `setRelayer`                | sol:176-180   |
| `RegisterMarket`             | `registerMarket`            | sol:182-190   |
| `RegisterFixedRevealMarket`  | `registerFixedRevealMarket` | sol:192-200   |
| `SetMarketActive`            | `setMarketActive`           | sol:202-207   |
| `SubmitSealedFor`            | `submitSealedFor`           | sol:209-268   |
| `OpenReveal`                 | `openReveal`                | sol:270-287   |
| `PublishReveal`              | `publishReveal`             | sol:289-342   |
| `SubmitFeedPacketFor`        | `submitFeedPacketFor`       | sol:344-410   |
| `OpenFeedPacketReveal`       | `openFeedPacketReveal`      | sol:412-428   |
| `PublishFeedPacketReveal`    | `publishFeedPacketReveal`   | sol:430-477   |

Critical guards (those V1/V2 rest on):

- **`SubmitSealedFor`** — `relayers[caller]`; agent ≠ 0; market exists
  and active; `calls[cid].state = None` (one-shot per cid — the
  precondition V1 and V2 depend on); `revealOpenAt > acceptedAt`
  (strictly positive wait).
- **`OpenReveal`** — `c.state = Sealed`; `now ≥ c.revealOpenAt`. Only
  writes `state := Opened`; `binaryIndex`, `confidenceBps`,
  `revealOpenAt`, `acceptedAt`, `marketId`, `agent` are NOT touched.
- **`PublishReveal`** — `c.state = Opened`. Writes `state` (to
  `Revealed` or `Invalid` per the `InvalidRevealReason` enum) and the
  plaintext mirrors. Handles + metadata NOT touched.
- **`SubmitFeedPacketFor`** — `relayers[caller]`; agent ≠ 0;
  `revealAfter > now`; `feedPackets[pid].state = None`. Unlike
  `submitSealedFor`, this entry point does NOT consult `markets` —
  `revealAfter` is a per-call argument, NOT derived from a market
  record.
- **`OpenFeedPacketReveal`** / **`PublishFeedPacketReveal`** —
  symmetric to the call versions, with `revealAfter` in place of
  `revealOpenAt`.

`computeRevealOpenAt : Market → Nat → Nat` mirrors the private
Solidity helper at `sol:569-572`: `Rolling` markets return
`acceptedAt + horizonSeconds`; `FixedReveal` markets return
`fixedRevealAfter` directly.

## Design decisions

- **Token model = trusted ERC-20, no hooks.** `TokenState.transfer`
  takes effect only on the two named balances; nothing else can move
  funds (matches USDC reality). The `NoDonation` axiom is a currently
  unused audit hook retained for future extensions that add donation
  vocabulary; E1's `fundsConservation` theorem does not consume it.
- **`BlockTime = Nat`, free per transition.** Each transition that
  takes a `now` argument writes it onto `s.blockTime`. There is no
  cross-transition monotonicity enforced by the model. The
  `BlockTimeMonotone` axiom is a currently unused audit hook retained
  for future extensions that thread a global clock across transitions;
  V2/V2Feed reveal-gating corollaries do not consume it today.
- **`Option Pipeline` / `Option InferenceRequest` / etc., not
  sentinel-row detection.** Solidity uses zero-field detection (e.g.
  `p.agentOwner == address(0)` for `PipelineNotFound`); the Lean model
  hoists this into the `Option` type. `s.pipelines pid = none`
  semantically equals the Solidity zero-row.
- **No mathlib4.** The proofs use only Lean's stdlib. Sum reasoning
  in E1 is done with a list-fold (`List.foldr (· + ·) 0`) and a
  `Nodup`-quantified update lemma rather than a `Finset.sum`. This
  keeps build dependencies empty.
- **Approach B for E1's sum machinery.** E1 quantifies over an
  externally-supplied `rids : List Bytes32` with `coverActive` and
  `traceCovered` hypotheses rather than storing an active-rid list in
  `EscrowState`. The alternative (Approach A — adding
  `activeRequests : List Bytes32` to the state record) would have
  rewritten prior commits (`06f5fe8`, `d735741`). The trade-off:
  Approach B's headline statement requires a coverage witness, but the
  state record remains pristine.
- **Local `Inhabited` witnesses for `opaque`.** Both
  `Escrow/Transitions.lean:12-13` and `SealedVerdicts/Transitions.lean:12-13`
  give local `Inhabited Bytes32` / `Inhabited Address` instances so
  the `opaque keccakBytes` / `opaque computeRequestId` declarations
  type-check. These are kept out of `Common/Bytes32.lean` and
  `Common/Address.lean` to avoid polluting the State.lean signatures.
- **Generic `updateMap` per layer.** Each invariant file re-derives
  `updateMap_same` / `updateMap_other` as `simp`-lemmas. Lean core
  4.29.1 ships without `Function.update`; the duplication is intentional
  per the per-file self-containment convention.
