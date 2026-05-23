import MurmurFV.Escrow.State

namespace MurmurFV.Escrow

open MurmurFV.Common

/-- Local `Inhabited` witnesses so the `opaque` declarations below
    type-check. Lean's `opaque` requires a `Nonempty`/`Inhabited`
    instance for the type, and `Bytes32` / `Address` ship without one.
    We avoid mutating `State.lean` (Task 2.1 deliverable) by giving
    these instances locally. -/
instance : Inhabited Bytes32 := ⟨Bytes32.zero⟩
instance : Inhabited Address := ⟨Address.zero⟩

/-- Solidity's keccak256(signal ‖ nonce). Modelled as an opaque
    deterministic function. We never unfold it — proofs only need
    that equal inputs produce equal outputs (trivially true since
    it's a function). -/
opaque keccakBytes : Bytes32 → Bytes32 → Bytes32

/-- Compute a request id (mirrors `computeRequestId` in MurmurEscrow.sol:433-439).
    Modelled as another opaque deterministic function for the proof.
    Args order matches the Solidity helper after re-arrangement:
    (buyer, pipelineId, nonce) → requestId. The Solidity contract also
    folds in a per-pipeline counter; for the abstract model we treat the
    triple (buyer, pid, nonce) as collision-free per the no-replay
    precondition (`s.requests rid = none`) checked at the call site. -/
opaque computeRequestId : Address → Bytes32 → Bytes32 → Bytes32

/-- Solidity constants. Encoded as `def`s so they appear by name in
    the transition guards; reviewers `grep` for them to confirm.
    Source: `MurmurEscrow.sol:45-47`. -/
def MAX_PROTOCOL_FEE_BPS : Nat := 1000
def CANCEL_WINDOW_SECONDS : Nat := 60
def BPS_DENOMINATOR : Nat := 10000
/-- Wave K M-1: stuck-commit recovery grace. After `committedAt +
    horizon + COMMITTED_REFUND_GRACE_HOURS*3600` the owner may
    `forceRefundCommitted`. Mirrors `MurmurEscrow.sol:51`. -/
def COMMITTED_REFUND_GRACE_HOURS : Nat := 168

/-- Point-update for total functions `Bytes32 → Option α`. Standalone
    helper because Lean core 4.29.1 doesn't ship `Function.update`. -/
def updateMap {α : Type} (f : Bytes32 → Option α) (k : Bytes32) (v : Option α) :
    Bytes32 → Option α :=
  fun x => if x = k then v else f x

/-- Externally-callable state-mutating entry points of `MurmurEscrow`.
    One constructor per external function. Note `CommitSignal` carries
    `marketDataCutoff` because the Solidity entry point takes it as an
    argument; we drop it on the floor in `step` because the field is
    intentionally not modelled in `InferenceRequest` (per spec §4). -/
inductive Transition where
  | CreatePipeline        (caller : Address) (pipelineId : Bytes32) (p : Pipeline)
  | SetPipelineActive     (caller : Address) (pipelineId : Bytes32) (active : Bool)
  | RequestInference      (caller : Address) (pipelineId : Bytes32) (nonce : Bytes32) (now : BlockTime)
  | CommitSignal          (caller : Address) (requestId : Bytes32) (commitHash : Bytes32) (marketDataCutoff : Bytes32) (now : BlockTime)
  | Finalize              (caller : Address) (requestId : Bytes32) (signal : Bytes32) (nonce : Bytes32) (now : BlockTime)
  | Refund                (caller : Address) (requestId : Bytes32) (now : BlockTime)
  | Cancel                (caller : Address) (requestId : Bytes32) (now : BlockTime)
  | ForceRefundCommitted  (caller : Address) (requestId : Bytes32) (now : BlockTime)  -- Wave K M-1
  | SubmitMerkleRoot      (caller : Address) (batchId : Nat) (root : Bytes32)
  | SetProtocolFeeBps     (caller : Address) (newBps : Nat)
  | SetProtocolFeeSink    (caller : Address) (newSink : Address)
  | SetPaused             (caller : Address) (paused : Bool)
  | TransferOwnership     (caller : Address) (newOwner : Address)

/-- Atomic transition semantics. `none` ≡ revert; `some s'` ≡ committed
    new state. Each arm cites the Solidity source line range it mirrors. -/
def step (s : EscrowState) (t : Transition) : Option EscrowState :=
  match t with
  -- ── CreatePipeline (MurmurEscrow.sol:192-218) ──────────────────────
  -- Wave K H-1: now `onlyOwner` (was open to any caller with agentOwner
  -- = msg.sender, which let a squatter redirect buyer payouts).
  -- Wave K L-2: SLA floor — `slaSeconds > CANCEL_WINDOW_SECONDS`.
  -- Wave K L-5: reject zero `agentOwner` and `agentOwner == escrow`
  -- (E1 precondition: payout target must differ from escrow).
  | .CreatePipeline caller pid p =>
      if s.paused then none
      else if caller ≠ s.owner then none
      else match s.pipelines pid with
        | some _ => none
        | none =>
          if p.agentOwner = Address.zero then none
          else if p.agentOwner = s.escrowAddr then none
          else if p.priceUsdc = 0 then none
          else if p.horizonHours = 0 then none
          else if p.slaSeconds = 0 then none
          else if ¬ (p.slaSeconds > CANCEL_WINDOW_SECONDS) then none
          else some { s with pipelines := updateMap s.pipelines pid (some p) }

  -- ── SetPipelineActive (MurmurEscrow.sol:223-228) ────────────────────
  -- Wave K H-1: now strictly `onlyOwner`. Previously the contract allowed
  -- `agentOwner` to re-activate, which let a squatter override owner-set
  -- deactivation. The Lean model previously also narrowed to agentOwner;
  -- post-Wave-K we widen to owner-only to match the contract.
  | .SetPipelineActive caller pid active =>
      if caller ≠ s.owner then none
      else match s.pipelines pid with
        | none => none
        | some p =>
          some { s with pipelines := updateMap s.pipelines pid (some { p with active := active }) }

  -- ── RequestInference (MurmurEscrow.sol:233-281) ─────────────────────
  -- Preconditions: not paused; pipeline exists and active; no replay
  -- (requestId slot empty); USDC transferFrom caller → escrow succeeds.
  | .RequestInference caller pid nonce now =>
      if s.paused then none
      else match s.pipelines pid with
        | none => none
        | some p =>
          if ¬ p.active then none
          else
            let rid := computeRequestId caller pid nonce
            match s.requests rid with
            | some _ => none
            | none =>
              match s.token.transferFrom caller s.escrowAddr p.priceUsdc with
              | none => none
              | some tok' =>
                -- Wave K M-2: snapshot `s.protocolFeeBps` into the request.
                let r' : InferenceRequest := {
                  pipelineId      := pid,
                  buyer           := caller,
                  paidAmount      := p.priceUsdc,
                  paidAt          := now,
                  slaDeadline     := now + p.slaSeconds,
                  commitHash      := Bytes32.zero,
                  committedAt     := 0,
                  state           := RequestState.Pending,
                  protocolFeeBps  := s.protocolFeeBps
                }
                some { s with
                  requests  := updateMap s.requests rid (some r'),
                  token     := tok',
                  blockTime := now
                }

  -- ── CommitSignal (MurmurEscrow.sol:289-304) ─────────────────────────
  -- Preconditions: request Pending; pipeline exists; caller = agentOwner;
  -- now ≤ slaDeadline. `marketDataCutoff` arg is intentionally discarded
  -- (field not modelled per spec §4).
  | .CommitSignal caller requestId commitHash _marketDataCutoff now =>
      match s.requests requestId with
      | none => none
      | some r =>
        if r.state ≠ RequestState.Pending then none
        else match s.pipelines r.pipelineId with
          | none => none
          | some p =>
            if caller ≠ p.agentOwner then none
            else if now > r.slaDeadline then none
            else
              let r' := { r with
                state       := RequestState.Committed,
                commitHash  := commitHash,
                committedAt := now
              }
              some { s with
                requests  := updateMap s.requests requestId (some r'),
                blockTime := now
              }

  -- ── Finalize (MurmurEscrow.sol:309-333) ─────────────────────────────
  -- Preconditions: request Committed; pipeline exists; finalize window
  -- open (now ≥ committedAt + horizonHours*3600); commit reveal matches.
  -- Token: fee→sink (if fee>0) then payout→agentOwner; both must succeed.
  | .Finalize _caller requestId signal nonce now =>
      match s.requests requestId with
      | none => none
      | some r =>
        if r.state ≠ RequestState.Committed then none
        else match s.pipelines r.pipelineId with
          | none => none
          | some p =>
            if now < r.committedAt + p.horizonHours * 3600 then none
            else if keccakBytes signal nonce ≠ r.commitHash then none
            else
              -- Wave K M-2: fee comes from per-request snapshot, NOT
              -- live `s.protocolFeeBps`. A mid-flight `setProtocolFeeBps`
              -- doesn't change this request's payout.
              let fee := r.paidAmount * r.protocolFeeBps / BPS_DENOMINATOR
              let agentPayout := r.paidAmount - fee
              let feeStep : Option TokenState :=
                if fee > 0 then s.token.transfer s.escrowAddr s.protocolFeeSink fee
                else some s.token
              match feeStep with
              | none => none
              | some tok'' =>
                match tok''.transfer s.escrowAddr p.agentOwner agentPayout with
                | none => none
                | some tokFinal =>
                  let r' := { r with state := RequestState.Finalized }
                  some { s with
                    requests  := updateMap s.requests requestId (some r'),
                    token     := tokFinal,
                    blockTime := now
                  }

  -- ── Refund (MurmurEscrow.sol:336-343) ───────────────────────────────
  -- Preconditions: request Pending; SLA elapsed (now > slaDeadline).
  -- Token: paidAmount → buyer must succeed.
  | .Refund _caller requestId now =>
      match s.requests requestId with
      | none => none
      | some r =>
        if r.state ≠ RequestState.Pending then none
        else if now ≤ r.slaDeadline then none
        else
          match s.token.transfer s.escrowAddr r.buyer r.paidAmount with
          | none => none
          | some tok' =>
            let r' := { r with state := RequestState.Refunded }
            some { s with
              requests  := updateMap s.requests requestId (some r'),
              token     := tok',
              blockTime := now
            }

  -- ── Cancel (MurmurEscrow.sol:368-376) ───────────────────────────────
  -- Preconditions: request Pending; caller = buyer; within 60s cancel
  -- window (now ≤ paidAt + CANCEL_WINDOW_SECONDS).
  -- Token: paidAmount → buyer must succeed.
  | .Cancel caller requestId now =>
      match s.requests requestId with
      | none => none
      | some r =>
        if r.state ≠ RequestState.Pending then none
        else if caller ≠ r.buyer then none
        else if now > r.paidAt + CANCEL_WINDOW_SECONDS then none
        else
          match s.token.transfer s.escrowAddr r.buyer r.paidAmount with
          | none => none
          | some tok' =>
            let r' := { r with state := RequestState.Canceled }
            some { s with
              requests  := updateMap s.requests requestId (some r'),
              token     := tok',
              blockTime := now
            }

  -- ── SubmitMerkleRoot (MurmurEscrow.sol:380-385) ─────────────────────
  -- Preconditions: caller = owner. Contract only emits an event; in the
  -- abstract model this is a no-op over (requests, pipelines, token).
  | .SubmitMerkleRoot caller _batchId _root =>
      if caller ≠ s.owner then none
      else some s

  -- ── SetProtocolFeeBps (MurmurEscrow.sol:400-404) ────────────────────
  -- Preconditions: caller = owner; newBps ≤ MAX_PROTOCOL_FEE_BPS.
  | .SetProtocolFeeBps caller newBps =>
      if caller ≠ s.owner then none
      else if newBps > MAX_PROTOCOL_FEE_BPS then none
      else some { s with protocolFeeBps := newBps }

  -- ── SetProtocolFeeSink (MurmurEscrow.sol:408-412) ───────────────────
  -- Wave K L-5: rejects zero and self (escrow) as new sink. Both break
  -- E1's `protocolFeeSink ≠ escrow` precondition or burn fees.
  | .SetProtocolFeeSink caller newSink =>
      if caller ≠ s.owner then none
      else if newSink = Address.zero then none
      else if newSink = s.escrowAddr then none
      else some { s with protocolFeeSink := newSink }

  -- ── SetPaused (MurmurEscrow.sol:415-417) ────────────────────────────
  -- Preconditions: caller = owner.
  | .SetPaused caller paused =>
      if caller ≠ s.owner then none
      else some { s with paused := paused }

  -- ── TransferOwnership (MurmurEscrow.sol:393-398) ────────────────────
  -- One-step ownership transfer in this contract (no acceptOwnership).
  -- Spec deviation note: the spec hypothesised a two-step transfer via
  -- pendingOwner, but Solidity writes `owner = newOwner` directly. We
  -- mirror the actual contract: write `owner` immediately and clear
  -- `pendingOwner` (the state field exists in our model but the contract
  -- never reads it, so we keep it pinned at zero).
  -- Wave K L-5: rejects zero and self (escrow) as new owner. Owner is NOT
  -- part of `WellFormed`, so this arm's invariant impact is just extra
  -- guards + a no-mutation carry for everything else.
  | .TransferOwnership caller newOwner =>
      if caller ≠ s.owner then none
      else if newOwner = Address.zero then none
      else if newOwner = s.escrowAddr then none
      else some { s with owner := newOwner, pendingOwner := Address.zero }

  -- ── ForceRefundCommitted (MurmurEscrow.sol:354-365) ─────────────────
  -- Wave K M-1: stuck-commit recovery. Owner-gated path that returns the
  -- buyer's funds when a Committed request can't be finalized (e.g. agent
  -- key loss). Guarded by horizon + 168h grace so an owner can't race a
  -- slow but legitimate finalize. Same balance-delta shape as `Refund`
  -- (Committed → Refunded, paidAmount → buyer) but with extra guards.
  | .ForceRefundCommitted caller requestId now =>
      if caller ≠ s.owner then none
      else match s.requests requestId with
        | none => none
        | some r =>
          if r.state ≠ RequestState.Committed then none
          else match s.pipelines r.pipelineId with
            | none => none
            | some p =>
              -- Solidity reverts only when `block.timestamp < graceOpenAt`,
              -- i.e. success requires `now ≥ graceOpenAt`.
              if now < r.committedAt + p.horizonHours * 3600
                  + COMMITTED_REFUND_GRACE_HOURS * 3600 then none
              else
                match s.token.transfer s.escrowAddr r.buyer r.paidAmount with
                | none => none
                | some tok' =>
                  let r' := { r with state := RequestState.Refunded }
                  some { s with
                    requests  := updateMap s.requests requestId (some r'),
                    token     := tok',
                    blockTime := now
                  }

end MurmurFV.Escrow
