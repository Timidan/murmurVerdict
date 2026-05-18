import MurmurFV.Common.Bytes32
import MurmurFV.Common.Address
import MurmurFV.Common.Token
import MurmurFV.Common.Time

namespace MurmurFV.Escrow

open MurmurFV.Common

/-- Pipeline: a registered agent's pricing + horizon. Mirrors
    `MurmurEscrow.sol:46-58`. -/
structure Pipeline where
  agentOwner   : Address
  priceUsdc    : Nat       -- uint96 in Solidity; modelled as Nat
  horizonHours : Nat       -- uint32
  slaSeconds   : Nat       -- uint32
  active       : Bool
deriving Repr

/-- Request lifecycle states. Mirror of `MurmurEscrow.sol:60-67`. -/
inductive RequestState where
  | None
  | Pending
  | Committed
  | Finalized
  | Refunded
  | Canceled
deriving DecidableEq, Repr

/-- InferenceRequest. Mirrors `MurmurEscrow.sol:76-85`. The Solidity
    `marketDataCutoff` field is intentionally omitted — it's
    operator-declared input-freshness metadata that doesn't participate
    in the E1 / E2 invariants (per spec §4). -/
structure InferenceRequest where
  pipelineId  : Bytes32
  buyer       : Address
  paidAmount  : Nat        -- uint96
  paidAt      : Nat        -- uint64
  slaDeadline : Nat        -- uint64; paidAt + slaSeconds at create time
  commitHash  : Bytes32
  committedAt : Nat        -- uint64
  state       : RequestState
deriving Repr

/-- Aggregate Escrow state. `pipelines` and `requests` are total functions
    Bytes32 → Option _. The `_locked` reentrancy guard from Solidity is
    `locked` here; in our atomic-transition model it's informational only. -/
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
