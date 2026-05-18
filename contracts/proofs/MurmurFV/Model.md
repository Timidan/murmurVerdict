# Model — abstract state machines

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

The `NoDonation` axiom is a documented invocation point. The
`Transition` inductive in `Escrow/Transitions.lean` has no constructor
that lets an external party transfer USDC into the escrow outside
`RequestInference`, so the property is automatically true under the
abstract model. The axiom is retained as a named grep target.

### `Time.lean`

```
abbrev BlockTime : Type := Nat
axiom BlockTimeMonotone : ∀ (t₁ t₂ : BlockTime), t₁ ≤ t₂ ∨ t₂ ≤ t₁
```

`block.timestamp` modelled as a free `Nat` per transition. Each
`step`-arm that takes a `now` argument writes `s.blockTime := now` on
success; nothing forces consecutive transitions to use a monotone
`now`. `BlockTimeMonotone` is a placeholder for trace-level proofs that
would require it (none of the current 6 invariants do).

## Escrow layer (`MurmurFV/Escrow/`)

### State (`State.lean`)

#### `Pipeline` — `MurmurEscrow.sol:68-74`

| Solidity field        | Lean field            |
|-----------------------|-----------------------|
| `address agentOwner`  | `agentOwner : Address`|
| `uint96 priceUsdc`    | `priceUsdc : Nat`     |
| `uint32 slaSeconds`   | `slaSeconds : Nat`    |
| `uint32 horizonHours` | `horizonHours : Nat`  |
| `bool active`         | `active : Bool`       |

#### `RequestState` — `MurmurEscrow.sol:50-57`

Identical 6-variant enum (`None`, `Pending`, `Committed`, `Finalized`,
`Refunded`, `Canceled`). `DecidableEq` lets proofs split on equality;
`noConfusion` rules out the case where two distinct constructors are
equal (used in E1 and E2 to discharge `state = Pending` contradictions
in arms that wrote a non-`Pending` state).

#### `InferenceRequest` — `MurmurEscrow.sol:76-86`

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

The Solidity field `marketDataCutoff` is intentionally omitted. It's
operator-declared input-freshness metadata; no E1/E2 reasoning depends
on it. `commitSignal` takes it as an argument and the abstract model
discards it (`_marketDataCutoff` in the `CommitSignal` arm).

The model uses `paidAt + slaSeconds` to compute `slaDeadline` at
`RequestInference` time; this matches the Solidity body at
`MurmurEscrow.sol:232` (`slaDeadline: nowTs + p.slaSeconds`). The
project initially stored `acceptedAt` instead of `slaDeadline` and was
realigned in commit `93564eb` to match Solidity layout.

#### `EscrowState` — aggregate

```
structure EscrowState where
  owner          : Address
  pendingOwner   : Address    -- present in Lean; contract has 1-step ownership (see TransferOwnership)
  protocolFeeBps : Nat
  protocolFeeSink: Address
  paused         : Bool
  locked         : Bool       -- abstract no-op; reentrancy is informational
  pipelines      : Bytes32 → Option Pipeline
  requests       : Bytes32 → Option InferenceRequest
  token          : TokenState
  escrowAddr     : Address
  blockTime      : BlockTime
```

`pipelines` and `requests` are total functions `Bytes32 → Option _`
(not Lean `Std.HashMap`). The function-field encoding eliminates a
shape mismatch between Solidity's "default-valued mapping" and Lean's
"option-typed lookup" — `s.pipelines pid = none` exactly captures
Solidity's `pipelines[pid].agentOwner == address(0)` zero-row check.

### Transitions (`Transitions.lean`)

12 constructors, one per externally-callable state-mutating function
in `MurmurEscrow.sol`:

| Constructor                  | Solidity function   | Source range        |
|------------------------------|---------------------|---------------------|
| `CreatePipeline`             | `createPipeline`    | sol:170-188         |
| `SetPipelineActive`          | `setPipelineActive` | sol:190-196         |
| `RequestInference`           | `requestInference`  | sol:201-246         |
| `CommitSignal`               | `commitSignal`      | sol:254-269         |
| `Finalize`                   | `finalize`          | sol:274-297         |
| `Refund`                     | `refund`            | sol:300-307         |
| `Cancel`                     | `cancel`            | sol:310-318         |
| `SubmitMerkleRoot`           | `submitMerkleRoot`  | sol:322-327         |
| `SetProtocolFeeBps`          | `setProtocolFeeBps` | sol:336-340         |
| `SetProtocolFeeSink`         | `setProtocolFeeSink`| sol:342-345         |
| `SetPaused`                  | `setPaused`         | sol:347-350         |
| `TransferOwnership`          | `transferOwnership` | sol:331-334         |

Each arm enforces the Solidity guards as `if … then none else …`
chains. Critical guard summary:

- **`CreatePipeline`** — `!paused`; slot at `pid` empty; price /
  horizon / sla all positive; caller matches `p.agentOwner`.
- **`SetPipelineActive`** — pipeline exists; caller is its `agentOwner`
  (model narrows the Solidity OR-with-owner branch to the agent-only
  case).
- **`RequestInference`** — `!paused`; pipeline exists and active;
  `requests[rid] = none` (no replay); USDC `transferFrom` succeeds.
- **`CommitSignal`** — `r.state = Pending`; pipeline exists; caller is
  `agentOwner`; `now ≤ r.slaDeadline`.
- **`Finalize`** — `r.state = Committed`; pipeline exists; `now ≥
  r.committedAt + p.horizonHours * 3600`; `keccakBytes(signal, nonce) =
  r.commitHash`; both USDC transfers succeed.
- **`Refund`** — `r.state = Pending`; `now > r.slaDeadline`; transfer
  to buyer succeeds.
- **`Cancel`** — `r.state = Pending`; caller is `r.buyer`; `now ≤
  r.paidAt + CANCEL_WINDOW_SECONDS` (= 60); transfer to buyer succeeds.
- **`SubmitMerkleRoot`** — caller is owner. No state change in the
  abstract model (the Solidity `merkleRoots` mapping is not modelled).
- **`SetProtocolFeeBps`** — caller is owner; `newBps ≤
  MAX_PROTOCOL_FEE_BPS` (= 1000).
- **`SetProtocolFeeSink` / `SetPaused`** — caller is owner.
- **`TransferOwnership`** — caller is owner. Writes `owner = newOwner`
  directly (matches Solidity at `sol:331-334`, which does NOT use the
  `pendingOwner` field — this contract is 1-step despite the field
  being declared). `pendingOwner` stays pinned at zero in the model.

`step : EscrowState → Transition → Option EscrowState` is total and
deterministic; `none` ≡ revert; `some s'` ≡ committed new state.

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
  funds (matches USDC reality). The `NoDonation` axiom is an audit
  hook for this assumption.
- **`BlockTime = Nat`, free per transition.** Each transition that
  takes a `now` argument writes it onto `s.blockTime`. There is no
  cross-transition monotonicity enforced by the model. The
  `BlockTimeMonotone` axiom is reserved for future trace-level proofs.
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
