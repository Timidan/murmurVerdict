import MurmurFV.SealedVerdicts.State

namespace MurmurFV.SealedVerdicts

open MurmurFV.Common

/-- Local `Inhabited` witnesses so any future `opaque` declarations in
    this module type-check. Lean's `opaque` requires a `Nonempty`/
    `Inhabited` instance and `Bytes32` / `Address` ship without one.
    We avoid mutating `State.lean` (Task 3.1 deliverable) by giving
    these instances locally — mirrors `Escrow/Transitions.lean`. -/
instance : Inhabited Bytes32 := ⟨Bytes32.zero⟩
instance : Inhabited Address := ⟨Address.zero⟩

/-- Point-update for total functions `Bytes32 → α`. Standalone helper
    because Lean core 4.29.1 doesn't ship `Function.update`. The generic
    `α` parameter lets us reuse this for `markets`, `calls`, and
    `feedPackets` (all `Bytes32 → Option _`) without specializing. -/
def updateMap {α : Type} (f : Bytes32 → α) (k : Bytes32) (v : α) :
    Bytes32 → α :=
  fun x => if x = k then v else f x

/-- Compute the reveal-open snapshot from a market and a submit
    timestamp. Mirrors the private pure helper `_revealOpenAt` in
    `MurmurSealedVerdicts.sol:569-572`. Note Solidity discriminates by
    `fixedRevealAfter != 0`; we discriminate by the Lean-side `kind`
    field which captures the same invariant explicitly. -/
def computeRevealOpenAt (m : Market) (acceptedAt : Nat) : Nat :=
  match m.kind with
  | .Rolling     => acceptedAt + m.horizonSeconds
  | .FixedReveal => m.fixedRevealAfter

/-- Lean-side mirror of the Solidity `InvalidRevealReason` enum
    (`MurmurSealedVerdicts.sol:37-42`). Used internally by the
    `publishReveal` / `publishFeedPacketReveal` arms to fork between
    the `.Revealed` and `.Invalid` terminal states. -/
inductive InvalidRevealReason where
  | None
  | BinaryIndex
  | Confidence
  | SignalBps
deriving DecidableEq, Repr

/-- Externally-callable state-mutating entry points of
    `MurmurSealedVerdicts`. One constructor per external function.
    Enumeration cross-checked against
    `grep "function " contracts/src/MurmurSealedVerdicts.sol` —
    view-only externals (`getCall`, `getFeedPacket`, `*Handle`,
    `callRevealOpenAt`) and `private` helpers are excluded.

    The relayer-authority is encoded literally on `submitSealedFor` /
    `submitFeedPacketFor` (per Solidity `relayers[msg.sender]` check
    at `sol:216, 353`); the owner is NOT auto-promoted to relayer in
    the contract, so we don't grant it here either. -/
inductive Transition where
  | TransferOwnership          (caller : Address) (newOwner : Address)
  | AcceptOwnership            (caller : Address)
  | SetRelayer                 (caller : Address) (relayer : Address) (active : Bool)
  | RegisterMarket             (caller : Address) (marketId : Bytes32) (horizonSeconds : Nat) (active : Bool)
  | RegisterFixedRevealMarket  (caller : Address) (marketId : Bytes32) (revealAfter : Nat) (active : Bool) (now : BlockTime)
  | SetMarketActive            (caller : Address) (marketId : Bytes32) (active : Bool)
  | SubmitSealedFor            (caller : Address) (agent : Address) (callId : Bytes32) (marketId : Bytes32) (binaryIndex : Bytes32) (confidenceBps : Bytes32) (now : BlockTime)
  | OpenReveal                 (caller : Address) (callId : Bytes32) (now : BlockTime)
  | PublishReveal              (caller : Address) (callId : Bytes32) (revealedBin : Nat) (revealedConf : Nat) (now : BlockTime)
  | SubmitFeedPacketFor        (caller : Address) (agent : Address) (packetId : Bytes32) (feedId : Bytes32) (marketId : Bytes32) (revealAfter : Nat) (action : Bytes32) (signalBps : Bytes32) (now : BlockTime)
  | OpenFeedPacketReveal       (caller : Address) (packetId : Bytes32) (now : BlockTime)
  | PublishFeedPacketReveal    (caller : Address) (packetId : Bytes32) (revealedAction : Nat) (revealedSignal : Nat) (now : BlockTime)

/-- Atomic transition semantics. `none` ≡ revert; `some s'` ≡ committed
    new state. Each arm cites the Solidity source line range it mirrors. -/
def step (s : SealedVerdictsState) (t : Transition) : Option SealedVerdictsState :=
  match t with
  -- ── TransferOwnership (MurmurSealedVerdicts.sol:162-166) ───────────
  -- Preconditions: caller = owner; newOwner ≠ 0.
  -- Two-step pattern: writes `pendingOwner`, NOT `owner`.
  | .TransferOwnership caller newOwner =>
      if caller ≠ s.owner then none
      else if newOwner = Address.zero then none
      else some { s with pendingOwner := newOwner }

  -- ── AcceptOwnership (MurmurSealedVerdicts.sol:168-174) ─────────────
  -- Preconditions: caller = pendingOwner.
  -- Promotes pendingOwner → owner and clears pendingOwner.
  | .AcceptOwnership caller =>
      if caller ≠ s.pendingOwner then none
      else some { s with owner := caller, pendingOwner := Address.zero }

  -- ── SetRelayer (MurmurSealedVerdicts.sol:176-180) ──────────────────
  -- Preconditions: caller = owner; relayer ≠ 0.
  | .SetRelayer caller relayer active =>
      if caller ≠ s.owner then none
      else if relayer = Address.zero then none
      else some { s with
        relayers := fun a => if a = relayer then active else s.relayers a
      }

  -- ── RegisterMarket / Rolling (MurmurSealedVerdicts.sol:182-190) ────
  -- Preconditions: caller = owner; horizonSeconds > 0.
  -- Writes a Market with kind=Rolling, fixedRevealAfter=0.
  | .RegisterMarket caller marketId horizonSeconds active =>
      if caller ≠ s.owner then none
      else if horizonSeconds = 0 then none
      else
        let m : Market := {
          kind             := .Rolling,
          horizonSeconds   := horizonSeconds,
          fixedRevealAfter := 0,
          active           := active
        }
        some { s with markets := updateMap s.markets marketId (some m) }

  -- ── RegisterFixedRevealMarket (MurmurSealedVerdicts.sol:192-200) ───
  -- Preconditions: caller = owner; revealAfter > block.timestamp
  -- (the contract checks `revealAfter <= block.timestamp` revert at sol:196).
  -- Writes a Market with kind=FixedReveal, horizonSeconds=0.
  | .RegisterFixedRevealMarket caller marketId revealAfter active now =>
      if caller ≠ s.owner then none
      else if revealAfter ≤ now then none
      else
        let m : Market := {
          kind             := .FixedReveal,
          horizonSeconds   := 0,
          fixedRevealAfter := revealAfter,
          active           := active
        }
        some { s with markets := updateMap s.markets marketId (some m) }

  -- ── SetMarketActive (MurmurSealedVerdicts.sol:202-207) ─────────────
  -- Preconditions: caller = owner; market exists.
  -- The Solidity `MarketNotFound` check uses the
  -- (horizonSeconds == 0 && fixedRevealAfter == 0) zero-row detection;
  -- in our model that's just `s.markets marketId = none`.
  | .SetMarketActive caller marketId active =>
      if caller ≠ s.owner then none
      else match s.markets marketId with
        | none => none
        | some m =>
          some { s with
            markets := updateMap s.markets marketId (some { m with active := active })
          }

  -- ── SubmitSealedFor (MurmurSealedVerdicts.sol:209-268) ─────────────
  -- Preconditions:
  --   - relayers[caller] = true (sol:216 — owner is NOT auto-promoted)
  --   - agent ≠ 0 (sol:217)
  --   - market exists (sol:229)
  --   - market.active (sol:230)
  --   - calls[callId].state = .None (sol:235; one-shot per callId — the
  --     precondition V1 + V2 lean on)
  --   - revealOpenAt > acceptedAt (sol:239 — strictly positive wait)
  -- Effect: store a fresh SealedCall and bump blockTime.
  | .SubmitSealedFor caller agent callId marketId binaryIndex confidenceBps now =>
      if s.relayers caller ≠ true then none
      else if agent = Address.zero then none
      else match s.markets marketId with
        | none => none
        | some m =>
          if ¬ m.active then none
          else match s.calls callId with
            | some _ => none
            | none =>
              let revealOpenAt := computeRevealOpenAt m now
              if revealOpenAt ≤ now then none
              else
                let c : SealedCall := {
                  agent                 := agent,
                  marketId              := marketId,
                  acceptedAt            := now,
                  revealOpenAt          := revealOpenAt,
                  binaryIndex           := binaryIndex,
                  confidenceBps         := confidenceBps,
                  revealedBinaryIndex   := 0,
                  revealedConfidenceBps := 0,
                  state                 := .Sealed
                }
                some { s with
                  calls     := updateMap s.calls callId (some c),
                  blockTime := now
                }

  -- ── OpenReveal (MurmurSealedVerdicts.sol:270-287) ──────────────────
  -- Preconditions:
  --   - calls[callId] exists and state = .Sealed (sol:272-273)
  --   - now ≥ revealOpenAt (sol:275)
  -- Effect: writes ONLY `state := .Opened`. CRITICAL — does NOT touch
  -- `binaryIndex`, `confidenceBps`, `revealOpenAt`, `acceptedAt`,
  -- `marketId`, or `agent`. This is the "no other writer" invariant
  -- V1 and V2 depend on.
  | .OpenReveal _caller callId now =>
      match s.calls callId with
      | none => none
      | some c =>
        if c.state ≠ .Sealed then none
        else if now < c.revealOpenAt then none
        else some { s with
          calls     := updateMap s.calls callId (some { c with state := .Opened }),
          blockTime := now
        }

  -- ── PublishReveal (MurmurSealedVerdicts.sol:289-342) ───────────────
  -- Preconditions:
  --   - calls[callId] exists and state = .Opened (sol:297-298)
  --   - FHE.verifyDecryptResult succeeds for both handles
  --     (sol:299-305 — modelled as black-box success at the
  --     state-machine level; V1/V2 don't require the proof-validity
  --     nuance).
  -- Invalid-reason check (sol:307-312):
  --   - revealedBin > 1                      → .BinaryIndex
  --   - revealedConf < 5100 ∨ > 9500          → .Confidence
  -- On any reason ≠ .None: write state = .Invalid + plaintext mirrors.
  -- Otherwise: write state = .Revealed + plaintext mirrors.
  -- CRITICAL — handles (`binaryIndex`, `confidenceBps`) and metadata
  -- (`revealOpenAt`, `acceptedAt`, `marketId`, `agent`) are NEVER
  -- touched. V1 depends on this.
  | .PublishReveal _caller callId revealedBin revealedConf now =>
      match s.calls callId with
      | none => none
      | some c =>
        if c.state ≠ .Opened then none
        else
          let reason : InvalidRevealReason :=
            if revealedBin > 1 then .BinaryIndex
            else if revealedConf < 5100 ∨ revealedConf > 9500 then .Confidence
            else .None
          let nextState : CallState :=
            match reason with
            | .None => .Revealed
            | _     => .Invalid
          let c' : SealedCall := { c with
            state                 := nextState,
            revealedBinaryIndex   := revealedBin,
            revealedConfidenceBps := revealedConf
          }
          some { s with
            calls     := updateMap s.calls callId (some c'),
            blockTime := now
          }

  -- ── SubmitFeedPacketFor (MurmurSealedVerdicts.sol:344-410) ─────────
  -- Preconditions:
  --   - relayers[caller] = true (sol:353)
  --   - agent ≠ 0 (sol:354)
  --   - revealAfter > now (sol:369 — strictly positive wait, applied
  --     to the caller-supplied revealAfter directly; the contract does
  --     NOT derive revealAfter from a market record)
  --   - feedPackets[packetId].state = .None (sol:378)
  -- NOTE: unlike submitSealedFor, the feed-packet path does NOT consult
  -- the markets mapping at all — revealAfter is a per-call argument.
  -- The `marketId` is stored as bytes32 metadata for indexing only.
  | .SubmitFeedPacketFor caller agent packetId feedId marketId revealAfter action signalBps now =>
      if s.relayers caller ≠ true then none
      else if agent = Address.zero then none
      else if revealAfter ≤ now then none
      else match s.feedPackets packetId with
        | some _ => none
        | none =>
          let p : SealedFeedPacket := {
            agent             := agent,
            feedId            := feedId,
            marketId          := marketId,
            acceptedAt        := now,
            revealAfter       := revealAfter,
            action            := action,
            signalBps         := signalBps,
            revealedAction    := 0,
            revealedSignalBps := 0,
            state             := .Sealed
          }
          some { s with
            feedPackets := updateMap s.feedPackets packetId (some p),
            blockTime   := now
          }

  -- ── OpenFeedPacketReveal (MurmurSealedVerdicts.sol:412-428) ────────
  -- Preconditions:
  --   - feedPackets[packetId] exists and state = .Sealed (sol:414-415)
  --   - now ≥ revealAfter (sol:416)
  -- Effect: writes ONLY `state := .Opened`. Same no-other-writer rule
  -- as OpenReveal.
  | .OpenFeedPacketReveal _caller packetId now =>
      match s.feedPackets packetId with
      | none => none
      | some p =>
        if p.state ≠ .Sealed then none
        else if now < p.revealAfter then none
        else some { s with
          feedPackets := updateMap s.feedPackets packetId (some { p with state := .Opened }),
          blockTime   := now
        }

  -- ── PublishFeedPacketReveal (MurmurSealedVerdicts.sol:430-477) ─────
  -- Preconditions:
  --   - feedPackets[packetId] exists and state = .Opened (sol:438-439)
  --   - FHE.verifyDecryptResult succeeds for both handles
  --     (sol:440-445; modelled as black-box success).
  -- Invalid-reason check (sol:447):
  --   - signalBps > 10000  → .SignalBps
  --   - (no action validation — Solidity does not bound the action
  --     plaintext beyond what the euint8 type permits)
  -- On invalid: state = .Invalid + plaintext mirrors.
  -- Otherwise: state = .Revealed + plaintext mirrors.
  -- Handles + metadata NEVER touched.
  | .PublishFeedPacketReveal _caller packetId revealedAction revealedSignal now =>
      match s.feedPackets packetId with
      | none => none
      | some p =>
        if p.state ≠ .Opened then none
        else
          let nextState : CallState :=
            if revealedSignal > 10000 then .Invalid else .Revealed
          let p' : SealedFeedPacket := { p with
            state             := nextState,
            revealedAction    := revealedAction,
            revealedSignalBps := revealedSignal
          }
          some { s with
            feedPackets := updateMap s.feedPackets packetId (some p'),
            blockTime   := now
          }

end MurmurFV.SealedVerdicts
