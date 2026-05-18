import MurmurFV.Common.Bytes32
import MurmurFV.Common.Address
import MurmurFV.Common.Time

namespace MurmurFV.SealedVerdicts

open MurmurFV.Common

/-- Distinguishes rolling-horizon markets (reveal opens `horizonSeconds`
    after submit) from fixed-reveal markets (reveal opens at a hardcoded
    timestamp `fixedRevealAfter` regardless of submit time).

    NOTE: Solidity has no explicit `MarketKind` enum. The contract uses
    the convention `fixedRevealAfter != 0 ↔ FixedReveal`; both fields
    live in `Market` and the two registration entry-points
    (`registerMarket` / `registerFixedRevealMarket`) zero out the other.
    `MarketKind` is a Lean-side modeling helper that captures this
    invariant explicitly so later transition proofs can case-split. -/
inductive MarketKind where
  | Rolling
  | FixedReveal
deriving DecidableEq, Repr

/-- Market record. Mirrors `MurmurSealedVerdicts.sol:44-48`.

    `kind` is a Lean-only abstraction over the Solidity field-value
    discriminator (see `MarketKind`). Both `horizonSeconds` and
    `fixedRevealAfter` are stored to match the Solidity layout; only
    one is meaningful at a time, determined by `kind`. -/
structure Market where
  kind             : MarketKind
  horizonSeconds   : Nat   -- uint64; meaningful only when kind = Rolling
  fixedRevealAfter : Nat   -- uint64; meaningful only when kind = FixedReveal
  active           : Bool
deriving Repr

/-- Call lifecycle. Mirrors `MurmurSealedVerdicts.sol:29-35`.
    Solidity reuses this same enum for `SealedFeedPacket.state`. -/
inductive CallState where
  | None
  | Sealed
  | Opened
  | Revealed
  | Invalid
deriving DecidableEq, Repr

/-- SealedCall. Mirrors `MurmurSealedVerdicts.sol:50-60`.

    Critical distinction:
    - `binaryIndex`, `confidenceBps` are the FHE handle bytes32 values
      (FHE.unwrap of the euint8/euint16 storage). These are write-once
      at submitSealedFor — V1 invariant proves this.
    - `revealedBinaryIndex`, `revealedConfidenceBps` are the plaintext
      mirrors, populated by publishReveal. These are NOT covered by V1.

    Field order matches Solidity: address / id / timestamps / handles /
    plaintext mirrors / state. -/
structure SealedCall where
  agent                 : Address
  marketId              : Bytes32
  acceptedAt            : Nat       -- uint64
  revealOpenAt          : Nat       -- uint64; snapshot computed at submit
  binaryIndex           : Bytes32   -- FHE handle (bytes32 from FHE.unwrap of euint8)
  confidenceBps         : Bytes32   -- FHE handle (bytes32 from FHE.unwrap of euint16)
  revealedBinaryIndex   : Nat       -- uint8 plaintext mirror
  revealedConfidenceBps : Nat       -- uint16 plaintext mirror
  state                 : CallState
deriving Repr

/-- SealedFeedPacket. Mirrors `MurmurSealedVerdicts.sol:62-73`.

    Differs from the prompt spec in three ways (all driven by Solidity):
    - Includes a `marketId` field (Solidity stores both `feedId` and
      `marketId` for feed packets).
    - Uses `revealAfter` (matching Solidity), not `revealOpenAt`.
    - Reuses `CallState` (matching Solidity); there is no separate
      `FeedPacketState` enum in the contract. -/
structure SealedFeedPacket where
  agent             : Address
  feedId            : Bytes32
  marketId          : Bytes32
  acceptedAt        : Nat       -- uint64
  revealAfter       : Nat       -- uint64
  action            : Bytes32   -- FHE handle (bytes32 from FHE.unwrap of euint8)
  signalBps         : Bytes32   -- FHE handle (bytes32 from FHE.unwrap of euint16)
  revealedAction    : Nat       -- uint8 plaintext mirror
  revealedSignalBps : Nat       -- uint16 plaintext mirror
  state             : CallState
deriving Repr

/-- Aggregate SealedVerdicts state. Mirrors the storage layout in
    `MurmurSealedVerdicts.sol:75-80`. The contract uses the two-step
    ownership pattern (`pendingOwner` + `acceptOwnership`, lines 76 /
    168-173), so we carry `pendingOwner` here.

    Function-field maps (`relayers`, `markets`, `calls`, `feedPackets`)
    prevent `deriving Repr`. -/
structure SealedVerdictsState where
  owner        : Address
  pendingOwner : Address
  relayers     : Address → Bool
  markets      : Bytes32 → Option Market
  calls        : Bytes32 → Option SealedCall
  feedPackets  : Bytes32 → Option SealedFeedPacket
  blockTime    : BlockTime
  -- No `deriving Repr` due to function fields.

end MurmurFV.SealedVerdicts
