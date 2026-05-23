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

/-- Aggregate Escrow state. `pipelines` and `requests` are total functions
    Bytes32 → Option _. The `_locked` reentrancy guard from Solidity is
    `locked` here; in our atomic-transition model it's informational only.

    `pendingOwner` is vestigial: the Solidity contract uses one-step
    `transferOwnership` (no two-step accept), so this field is never
    read or written by the modelled transitions. We pin it to `Address.zero`
    via `TransferOwnership` (`Transitions.lean:280-284`, mirroring
    `MurmurEscrow.sol:393-398`) and keep it in the
    struct to avoid mutating the type for downstream proofs. Removal
    deferred (Wave K alignment leaves it in place). -/
structure EscrowState where
  owner          : Address
  pendingOwner   : Address
  protocolFeeBps : Nat
  protocolFeeSink: Address
  paused         : Bool
  locked         : Bool
  pipelines      : Bytes32 → Option Pipeline
  requests       : Bytes32 → Option InferenceRequest
  token          : TokenState
  escrowAddr     : Address
  blockTime      : BlockTime
  -- No `deriving Repr` — `pipelines` and `requests` are function fields.

end MurmurFV.Escrow
