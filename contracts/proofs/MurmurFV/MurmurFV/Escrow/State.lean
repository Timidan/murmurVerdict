import MurmurFV.Common.Bytes32
import MurmurFV.Common.Address
import MurmurFV.Common.Token
import MurmurFV.Common.Time

namespace MurmurFV.Escrow

open MurmurFV.Common

/-- Pipeline: a registered agent's pricing + horizon. Mirrors
    `MurmurEscrow.sol:73-79`. -/
structure Pipeline where
  agentOwner   : Address
  priceUsdc    : Nat       -- uint96 in Solidity; modelled as Nat
  horizonHours : Nat       -- uint32
  slaSeconds   : Nat       -- uint32
  active       : Bool
deriving Repr

/-- Request lifecycle states. Mirror of `MurmurEscrow.sol:55-62`. -/
inductive RequestState where
  | None
  | Pending
  | Committed
  | Finalized
  | Refunded
  | Canceled
deriving DecidableEq, Repr

/-- InferenceRequest. Mirrors `MurmurEscrow.sol:81-94`. The Solidity
    `marketDataCutoff` field is intentionally omitted — it's
    operator-declared input-freshness metadata that doesn't participate
    in the E1 / E2 invariants (per spec §4).

    Wave K M-2: added `protocolFeeBps` as a per-request snapshot of the
    fee rate at request time. `Finalize` reads from this field (not from
    `EscrowState.protocolFeeBps`) so a mid-flight `SetProtocolFeeBps`
    cannot retroactively change an in-flight buyer's payout. -/
structure InferenceRequest where
  pipelineId      : Bytes32
  buyer           : Address
  paidAmount      : Nat        -- uint96
  paidAt          : Nat        -- uint64
  slaDeadline     : Nat        -- uint64; paidAt + slaSeconds at create time
  commitHash      : Bytes32
  committedAt     : Nat        -- uint64
  state           : RequestState
  protocolFeeBps  : Nat        -- uint16; snapshot at request time (Wave K M-2)
deriving Repr

/-! ## Wave L.B additions

`requestInferenceFor` (per attested buyer) and the strict integration
allowlist machinery. None of these new fields affect E1 / E2 directly
— the balance equation reads `requests` and `token`, the single-commit
guarantee reads `requests.state`. The new state is included so the
contract surface that mutates it (8 new transitions) round-trips in
the model. -/

/-- One row of the strict integration allowlist. Mirrors
    `MurmurEscrow.sol:157-168`. The `committedAt == 0` sentinel doubles
    as "not active" — see `isAllowlistActive` notion documented in the
    Phase 2 design note. -/
structure AllowlistEntry where
  codehashPin       : Bytes32
  perCallCapUsdc    : Nat       -- uint96
  perBlockCapUsdc   : Nat       -- uint96
  perDayCapUsdc     : Nat       -- uint96
  spentThisBlock    : Nat       -- uint96
  spentToday        : Nat       -- uint96
  spentBlockNumber  : Nat       -- uint64
  spentTodayDayUtc  : Nat       -- uint64
  paused            : Bool
  committedAt       : Nat       -- uint64; 0 ≡ not committed/active
deriving Repr

/-- Kind discriminator for `AllowlistProposal`. Mirrors Solidity's
    `PROPOSAL_KIND_*` constants at `MurmurEscrow.sol:89-92`. -/
inductive ProposalKind where
  | Add
  | Remove
  | Unpause
deriving DecidableEq, Repr

/-- Pending allowlist change. Mirrors `MurmurEscrow.sol:173-180`.
    `effectiveAt = 0` (per Solidity convention) means no pending
    proposal; in the Lean model we represent absence with `none` on
    the `allowlistProposed` mapping rather than the sentinel. -/
structure AllowlistProposal where
  codehashPin     : Bytes32
  perCallCapUsdc  : Nat       -- uint96
  perBlockCapUsdc : Nat       -- uint96
  perDayCapUsdc   : Nat       -- uint96
  effectiveAt     : Nat       -- uint64
  kind            : ProposalKind
deriving Repr

/-- Aggregate Escrow state. `pipelines` and `requests` are total functions
    Bytes32 → Option _. The `_locked` reentrancy guard from Solidity is
    `locked` here; in our atomic-transition model it's informational only.

    `pendingOwner` is vestigial: the Solidity contract uses one-step
    `transferOwnership` (no two-step accept), so this field is never
    read or written by the modelled transitions. We pin it to `Address.zero`
    via `TransferOwnership` (`Transitions.lean:280-284`, mirroring
    `MurmurEscrow.sol:393-398`) and keep it in the
    struct to avoid mutating the type for downstream proofs. Removal
    deferred (Wave K alignment leaves it in place).

    Wave L.B adds three function fields:
    - `usedAuthDigest : Bytes32 → Bool` — EIP-712 replay-protection
      register; flipped to `true` by a successful Sig-path
      `RequestInferenceFor`. Mirrors `MurmurEscrow.sol:153`.
    - `allowlist : Address → Option AllowlistEntry` — integration
      allowlist storage. `none` = deleted/default; `some entry` with
      `entry.committedAt = 0` is also treated as not-active by all
      consuming guards. Mirrors `MurmurEscrow.sol:169`.
    - `allowlistProposed : Address → Option AllowlistProposal` —
      pending two-step propose/commit state. Mirrors
      `MurmurEscrow.sol:181`. -/
structure EscrowState where
  owner             : Address
  pendingOwner      : Address
  protocolFeeBps    : Nat
  protocolFeeSink   : Address
  paused            : Bool
  locked            : Bool
  pipelines         : Bytes32 → Option Pipeline
  requests          : Bytes32 → Option InferenceRequest
  token             : TokenState
  escrowAddr        : Address
  blockTime         : BlockTime
  usedAuthDigest    : Bytes32 → Bool                        -- Wave L.B
  allowlist         : Address → Option AllowlistEntry       -- Wave L.B
  allowlistProposed : Address → Option AllowlistProposal    -- Wave L.B
  -- No `deriving Repr` — function fields are not Repr.

end MurmurFV.Escrow
