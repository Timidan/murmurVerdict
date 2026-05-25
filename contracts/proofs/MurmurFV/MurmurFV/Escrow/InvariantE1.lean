import MurmurFV.Escrow.InvariantE2

namespace MurmurFV.Escrow

open MurmurFV.Common

/-! ## E1 — Funds conservation

For every reachable state `s`, the sum of `paidAmount` across requests
in state `{Pending, Committed}` equals the escrow's USDC balance,
provided:

* the starting state `s₀` is in equilibrium (`liveSumList s₀ rids =
  s₀.token.balanceOf s₀.escrowAddr` — trivially `0 = 0` at deploy);
* `rids` covers every active request in `s₀` and every rid mentioned
  by any transition in the trace (so the `liveSumList` window catches
  all bookkeeping along the run);
* `WellFormed s₀` holds: the escrow address differs from every protocol-
  fee sink / pipeline agent owner / request buyer that the state ever
  exposes (so token transfers actually move balance rather than
  degenerating to self-transfer no-ops).

The proof is by induction on `Reachable`. The inductive step case-splits
on the next transition and shows that the delta on LHS (`liveSumList`)
matches the delta on RHS (`balanceOf escrowAddr`). All 13 arms close.

### Approach choice — parametric over an external rid list (Approach B)

The spec offered two std-only paths:
- A. add `activeRequests : List Bytes32` to `EscrowState` and update it
  per-arm;
- B. quantify externally over a rid list with a coverage hypothesis.

Approach A would refactor `Escrow/State.lean` (committed at 06f5fe8)
and `Escrow/Transitions.lean` (committed at d735741). Approach B leaves
prior commits untouched and keeps E1 self-contained at the cost of a
slightly weaker headline statement (callers must supply a coverage
witness). This file uses **Approach B**.

### Equality vs inequality

Both are proven here. The inductive step delivers equality
(LHS_delta = RHS_delta), so `liveSumList = balanceOf` is the natural
form on `Reachable`. The inequality `liveSumList ≤ balanceOf` falls out
as a corollary. The `NoDonation` axiom isn't strictly needed: the
`Reachable` relation already forbids external transfers because the
transition vocabulary is closed under `step`. -/

/-- Predicate: a request slot at `rid` is "active" — Pending or Committed.
    Inactive states (None, Finalized, Refunded, Canceled) don't contribute
    to `liveSumList`. -/
def isActive (s : EscrowState) (rid : Bytes32) : Prop :=
  match s.requests rid with
  | some r => r.state = RequestState.Pending ∨ r.state = RequestState.Committed
  | none   => False

/-- Extract a request's `paidAmount` if it's active; otherwise 0. -/
def paidAmountOf (s : EscrowState) (rid : Bytes32) : Nat :=
  match s.requests rid with
  | some r =>
      if r.state = RequestState.Pending ∨ r.state = RequestState.Committed
      then r.paidAmount else 0
  | none => 0

/-- Sum `paidAmountOf` over a list of rids. -/
def liveSumList (s : EscrowState) (rids : List Bytes32) : Nat :=
  (rids.map (paidAmountOf s)).foldr (· + ·) 0

/-- The (optional) rid mentioned by a transition. `none` for transitions
    that don't touch any request slot. Used to express coverage. -/
def touchedRid : Transition → Option Bytes32
  | .RequestInference caller pid nonce _ => some (computeRequestId caller pid nonce)
  | .RequestInferenceFor _caller buyer pid nonce _ _ _ => some (computeRequestId buyer pid nonce)
  | .CommitSignal _ rid _ _ _ => some rid
  | .Finalize _ rid _ _ _ => some rid
  | .Refund _ rid _ => some rid
  | .Cancel _ rid _ => some rid
  | .ForceRefundCommitted _ rid _ => some rid
  | _ => none

/-- Every transition's touched rid (if any) is in `rids`. -/
def traceCovered (rids : List Bytes32) : List Transition → Prop
  | [] => True
  | tx :: rest =>
      (∀ rid, touchedRid tx = some rid → rid ∈ rids) ∧ traceCovered rids rest

/-- Well-formedness predicate over `s`. Captures the closed-world
    assumption that token transfers in transitions actually move
    balance (no self-transfers), and that live + snapshotted
    `protocolFeeBps` values stay within the contract cap. -/
def WellFormed (s : EscrowState) : Prop :=
  s.escrowAddr ≠ s.protocolFeeSink ∧
  (∀ pid p, s.pipelines pid = some p → s.escrowAddr ≠ p.agentOwner) ∧
  (∀ rid r, s.requests rid = some r → s.escrowAddr ≠ r.buyer) ∧
  s.protocolFeeBps ≤ MAX_PROTOCOL_FEE_BPS ∧
  (∀ rid r, s.requests rid = some r → r.protocolFeeBps ≤ MAX_PROTOCOL_FEE_BPS)

/-- A transition is *well-formed* when its inputs preserve `WellFormed`.

    * `RequestInference caller …` — the caller (who becomes the request's
      `buyer`) is not the escrow itself.
    * `CreatePipeline _ _ p` — the pipeline's `agentOwner` is not the
      escrow itself.
    * `SetProtocolFeeSink _ newSink` — the new fee sink is not the escrow
      itself.

    All other constructors don't introduce new "escrow-collides-with-X"
    relationships. -/
def WellFormedTx (s : EscrowState) (tx : Transition) : Prop :=
  match tx with
  | .RequestInference caller _ _ _ => s.escrowAddr ≠ caller
  | .RequestInferenceFor caller buyer _ _ auth _ _ =>
      s.escrowAddr ≠ buyer ∧
      (match auth with
       | .Hooked _   => s.escrowAddr ≠ caller
       | .Sig _ _ _  => True)
  | .CreatePipeline _ _ p          => s.escrowAddr ≠ p.agentOwner
  | .SetProtocolFeeSink _ newSink  => s.escrowAddr ≠ newSink
  | _ => True

/-- Trace-level well-formedness. -/
inductive ReachableWF :
    EscrowState → List Transition → EscrowState → Prop where
  | nil : ∀ s, ReachableWF s [] s
  | cons :
      ∀ s s_mid s_final tx rest,
        step s tx = some s_mid →
        WellFormedTx s tx →
        ReachableWF s_mid rest s_final →
        ReachableWF s (tx :: rest) s_final

/-- A `ReachableWF` trace is a fortiori a `Reachable` trace. -/
theorem ReachableWF.toReachable
    {s s' : EscrowState} {trace : List Transition}
    (h : ReachableWF s trace s') : Reachable s trace s' := by
  induction h with
  | nil s => exact Reachable.nil s
  | cons s s_mid s_final tx rest hstep _hwf _hrest ih =>
      exact Reachable.cons s s_mid s_final tx rest hstep ih

/-! ### Token transfer behavior at the escrow address. -/

/-- After `transfer from to amount` succeeds with `from ≠ to`, the
    balance of `from` drops by `amount`. -/
theorem transfer_balance_from
    (s : TokenState) (from_ to_ : Address) (amount : Nat) (s' : TokenState)
    (h : s.transfer from_ to_ amount = some s') (hne : from_ ≠ to_) :
    s'.balanceOf from_ = s.balanceOf from_ - amount := by
  unfold TokenState.transfer at h
  split at h
  · injection h with heq
    rw [← heq]
    simp [hne]
  · exact absurd h (by simp)

/-- After `transfer from to amount` succeeds with `from ≠ to`, the
    balance of `to` rises by `amount`. -/
theorem transfer_balance_to
    (s : TokenState) (from_ to_ : Address) (amount : Nat) (s' : TokenState)
    (h : s.transfer from_ to_ amount = some s') (hne : from_ ≠ to_) :
    s'.balanceOf to_ = s.balanceOf to_ + amount := by
  unfold TokenState.transfer at h
  split at h
  · injection h with heq
    rw [← heq]
    simp [Ne.symm hne]
  · exact absurd h (by simp)

/-! ### Helper lemmas about `liveSumList` -/

/-- If `s` and `s'` agree on every rid in `rids` (with respect to
    `paidAmountOf`), the sums are equal. -/
theorem liveSumList_congr (s s' : EscrowState) (rids : List Bytes32)
    (h : ∀ rid ∈ rids, paidAmountOf s rid = paidAmountOf s' rid) :
    liveSumList s rids = liveSumList s' rids := by
  unfold liveSumList
  induction rids with
  | nil => simp
  | cons r rest ih =>
      simp only [List.map_cons, List.foldr_cons]
      have hr : paidAmountOf s r = paidAmountOf s' r := h r (List.mem_cons_self)
      have hrest : ∀ rid ∈ rest, paidAmountOf s rid = paidAmountOf s' rid := by
        intro rid hmem
        exact h rid (List.mem_cons_of_mem r hmem)
      rw [hr, ih hrest]

/-- If every rid in `rids` is unchanged in `s.requests`, then
    `liveSumList` is preserved. -/
theorem liveSumList_unchanged (s s' : EscrowState) (rids : List Bytes32)
    (h : ∀ rid ∈ rids, s.requests rid = s'.requests rid) :
    liveSumList s rids = liveSumList s' rids := by
  apply liveSumList_congr
  intro rid hmem
  unfold paidAmountOf
  rw [h rid hmem]

/-- Specialise: if `requests` agrees pointwise, sums agree. -/
theorem liveSumList_requests_eq (s s' : EscrowState) (rids : List Bytes32)
    (h : s.requests = s'.requests) :
    liveSumList s rids = liveSumList s' rids := by
  apply liveSumList_unchanged
  intro rid _
  rw [h]

/-- Lemma: if `rid₀ ∈ rids` (Nodup), and `s'` matches `s` everywhere
    except at `rid₀`, then the sum decomposes:

      liveSumList s' rids + paidAmountOf s rid₀
        = liveSumList s rids + paidAmountOf s' rid₀

    Equivalently, the sum changed by exactly the delta at `rid₀`.
    `Nodup` is required because duplicate occurrences of `rid₀` in
    `rids` would multiply the delta. -/
theorem liveSumList_update_single
    (s s' : EscrowState) (rids : List Bytes32) (rid₀ : Bytes32)
    (h_mem : rid₀ ∈ rids) (h_nodup : rids.Nodup)
    (h_other : ∀ rid ∈ rids, rid ≠ rid₀ → paidAmountOf s rid = paidAmountOf s' rid) :
    liveSumList s' rids + paidAmountOf s rid₀
      = liveSumList s rids + paidAmountOf s' rid₀ := by
  unfold liveSumList
  induction rids with
  | nil => exact absurd h_mem (List.not_mem_nil)
  | cons r rest ih =>
      simp only [List.map_cons, List.foldr_cons]
      by_cases h_eq : r = rid₀
      · -- This is THE distinguished entry. By Nodup, `r ∉ rest`.
        subst h_eq
        have h_r_notin_rest : r ∉ rest := by
          cases h_nodup with
          | cons h _ => intro hmem; exact h _ hmem rfl
        -- The rest is unchanged.
        have h_rest_unchanged :
            List.foldr (· + ·) 0 (List.map (paidAmountOf s) rest)
            = List.foldr (· + ·) 0 (List.map (paidAmountOf s') rest) := by
          have h_each : ∀ rid ∈ rest, paidAmountOf s rid = paidAmountOf s' rid := by
            intro rid hmem
            have hne_r : rid ≠ r := by
              intro h_eq_r
              rw [h_eq_r] at hmem
              exact h_r_notin_rest hmem
            exact h_other rid (List.mem_cons_of_mem r hmem) hne_r
          clear h_other h_r_notin_rest h_mem ih h_nodup
          induction rest with
          | nil => simp
          | cons x xs ih2 =>
              simp only [List.map_cons, List.foldr_cons]
              have hx := h_each x (List.mem_cons_self)
              have hxs : ∀ rid ∈ xs, paidAmountOf s rid = paidAmountOf s' rid := by
                intro rid hmem
                exact h_each rid (List.mem_cons_of_mem x hmem)
              rw [hx, ih2 hxs]
        rw [h_rest_unchanged]
        omega
      · -- r ≠ rid₀. The contribution at r is unchanged. Recurse.
        have h_r_eq : paidAmountOf s r = paidAmountOf s' r :=
          h_other r (List.mem_cons_self) h_eq
        rw [h_r_eq]
        have h_rid_in_rest : rid₀ ∈ rest := by
          cases h_mem with
          | head => exact absurd rfl h_eq
          | tail _ h => exact h
        have h_rest_nodup : rest.Nodup := by
          cases h_nodup with
          | cons _ h => exact h
        have h_rest_other : ∀ rid ∈ rest, rid ≠ rid₀ → paidAmountOf s rid = paidAmountOf s' rid := by
          intro rid hmem hne
          exact h_other rid (List.mem_cons_of_mem r hmem) hne
        have h_ih := ih h_rid_in_rest h_rest_nodup h_rest_other
        unfold liveSumList at h_ih
        omega

/-! ### Step-preservation lemmas. -/

/-- The inductive invariant carried through `ReachableWF`. -/
structure E1Inv (s : EscrowState) (rids : List Bytes32) : Prop where
  eq          : liveSumList s rids = s.token.balanceOf s.escrowAddr
  wf          : WellFormed s
  coverActive : ∀ rid, isActive s rid → rid ∈ rids
  nodup       : rids.Nodup

/-- Helper: when `s'` only differs from `s` in non-`requests`,
    non-`token`, non-`escrowAddr`, non-`protocolFeeSink`, non-`pipelines`
    fields, the invariant carries over. This applies to `SetPaused`,
    `TransferOwnership`, `SubmitMerkleRoot`. -/
theorem E1Inv_carry_no_mutation
    (s s' : EscrowState) (rids : List Bytes32)
    (h_req : s.requests = s'.requests)
    (h_tok : s.token = s'.token)
    (h_addr : s.escrowAddr = s'.escrowAddr)
    (h_sink : s.protocolFeeSink = s'.protocolFeeSink)
    (h_bps : s.protocolFeeBps = s'.protocolFeeBps)
    (h_pipe : s.pipelines = s'.pipelines)
    (h_inv : E1Inv s rids) :
    E1Inv s' rids := by
  refine ⟨?_, ⟨?_, ?_, ?_, ?_, ?_⟩, ?_, ?_⟩
  · -- liveSumList s' rids = s'.token.balanceOf s'.escrowAddr
    have h_sum_eq : liveSumList s' rids = liveSumList s rids :=
      (liveSumList_requests_eq s s' rids h_req).symm
    rw [h_sum_eq, h_inv.eq, h_tok, h_addr]
  · rw [← h_addr, ← h_sink]; exact h_inv.wf.1
  · intro pid p hp
    rw [← h_pipe] at hp
    rw [← h_addr]
    exact h_inv.wf.2.1 pid p hp
  · intro rid r hr
    rw [← h_req] at hr
    rw [← h_addr]
    exact h_inv.wf.2.2.1 rid r hr
  · rw [← h_bps]; exact h_inv.wf.2.2.2.1
  · intro rid r hr
    rw [← h_req] at hr
    exact h_inv.wf.2.2.2.2 rid r hr
  · intro rid hactive
    apply h_inv.coverActive
    unfold isActive at hactive ⊢
    rw [h_req]
    exact hactive
  · exact h_inv.nodup

/-- Helper for request-creation arms: a fresh Pending request is written
    and `priceUsdc` is transferred into escrow. -/
theorem E1Inv_request_create
    (s s' : EscrowState) (rids : List Bytes32)
    (rid pid : Bytes32) (buyer payer : Address) (p : Pipeline)
    (now : BlockTime) (tok' : TokenState)
    (h_req_none : s.requests rid = none)
    (h_requests : s'.requests =
      updateMap s.requests rid
        (some { pipelineId := pid, buyer := buyer, paidAmount := p.priceUsdc,
                paidAt := now, slaDeadline := now + p.slaSeconds,
                commitHash := Bytes32.zero, committedAt := 0,
                state := RequestState.Pending,
                protocolFeeBps := s.protocolFeeBps }))
    (h_tok : s'.token = tok')
    (h_addr : s.escrowAddr = s'.escrowAddr)
    (h_sink : s.protocolFeeSink = s'.protocolFeeSink)
    (h_bps : s.protocolFeeBps = s'.protocolFeeBps)
    (h_pipe : s.pipelines = s'.pipelines)
    (h_tok_some : s.token.transferFrom payer s.escrowAddr p.priceUsdc = some tok')
    (h_payer_ne : payer ≠ s.escrowAddr)
    (h_buyer_ne : s.escrowAddr ≠ buyer)
    (h_rid_in_rids : rid ∈ rids)
    (h_inv : E1Inv s rids) :
    E1Inv s' rids := by
  have h_bal : s'.token.balanceOf s'.escrowAddr =
      s.token.balanceOf s.escrowAddr + p.priceUsdc := by
    unfold TokenState.transferFrom at h_tok_some
    have hbalto :=
      transfer_balance_to s.token payer s.escrowAddr p.priceUsdc tok'
        h_tok_some h_payer_ne
    rw [← h_addr, h_tok]
    exact hbalto
  have h_paid_s_rid : paidAmountOf s rid = 0 := by
    unfold paidAmountOf
    rw [h_req_none]
  have h_paid_s'_rid : paidAmountOf s' rid = p.priceUsdc := by
    unfold paidAmountOf
    rw [h_requests]
    simp [updateMap_same]
  have h_paid_other : ∀ other, other ≠ rid →
      paidAmountOf s other = paidAmountOf s' other := by
    intro other hne
    unfold paidAmountOf
    have h_req' : s'.requests other = s.requests other := by
      rw [h_requests]
      exact updateMap_other _ _ _ _ hne
    rw [h_req']
  have h_sum_delta :
      liveSumList s' rids = liveSumList s rids + p.priceUsdc := by
    have h_update := liveSumList_update_single s s' rids rid h_rid_in_rids h_inv.nodup
      (fun rid' _ hne => h_paid_other rid' hne)
    rw [h_paid_s_rid, h_paid_s'_rid] at h_update
    omega
  refine ⟨?_, ⟨?_, ?_, ?_, ?_, ?_⟩, ?_, ?_⟩
  · rw [h_sum_delta, h_bal, h_inv.eq]
  · rw [← h_addr, ← h_sink]; exact h_inv.wf.1
  · intro pid' p' hp'
    rw [← h_pipe] at hp'
    rw [← h_addr]
    exact h_inv.wf.2.1 pid' p' hp'
  · intro rid' r hr'
    rw [← h_addr]
    by_cases h_eq : rid' = rid
    · subst h_eq
      rw [h_requests] at hr'
      simp [updateMap_same] at hr'
      rw [← hr']
      exact h_buyer_ne
    · rw [h_requests] at hr'
      simp [updateMap_other _ _ _ _ h_eq] at hr'
      exact h_inv.wf.2.2.1 rid' r hr'
  · rw [← h_bps]; exact h_inv.wf.2.2.2.1
  · intro rid' r hr'
    by_cases h_eq : rid' = rid
    · subst h_eq
      rw [h_requests] at hr'
      simp [updateMap_same] at hr'
      rw [← hr']
      exact h_inv.wf.2.2.2.1
    · rw [h_requests] at hr'
      simp [updateMap_other _ _ _ _ h_eq] at hr'
      exact h_inv.wf.2.2.2.2 rid' r hr'
  · intro rid' hactive
    unfold isActive at hactive
    by_cases h_eq : rid' = rid
    · subst h_eq
      exact h_rid_in_rids
    · have h_eq_req : s'.requests rid' = s.requests rid' := by
        rw [h_requests]
        exact updateMap_other _ _ _ _ h_eq
      rw [h_eq_req] at hactive
      apply h_inv.coverActive
      unfold isActive
      exact hactive
  · exact h_inv.nodup

/-- The main inductive lemma. Each transition preserves `E1Inv`. -/
theorem step_preserves_E1Inv
    (s s' : EscrowState) (tx : Transition) (rids : List Bytes32)
    (h_step : step s tx = some s')
    (h_wf_tx : WellFormedTx s tx)
    (h_cover_tx : ∀ rid, touchedRid tx = some rid → rid ∈ rids)
    (h_inv : E1Inv s rids) :
    E1Inv s' rids := by
  cases tx with
  -- ── Group A: doesn't touch requests, token, or pipelines ─────────────
  | SubmitMerkleRoot caller _batchId _root =>
      simp only [step] at h_step
      split at h_step <;> try (simp at h_step; done)
      injection h_step with heq
      subst heq
      exact h_inv
  | SetProtocolFeeBps caller newBps =>
      simp only [step] at h_step
      split at h_step <;> try (simp at h_step; done)
      split at h_step <;> try (simp at h_step; done)
      rename_i h_bps_le
      injection h_step with heq
      -- Changes protocolFeeBps. Other fields unchanged. WellFormed needs the setter cap.
      have h_new_bps_le : newBps ≤ MAX_PROTOCOL_FEE_BPS := Nat.not_lt.mp h_bps_le
      -- s' = { s with protocolFeeBps := newBps }
      subst heq
      refine ⟨?_, ⟨?_, ?_, ?_, ?_, ?_⟩, ?_, ?_⟩
      · show liveSumList _ rids = _
        simp only []
        exact h_inv.eq
      · exact h_inv.wf.1
      · exact h_inv.wf.2.1
      · exact h_inv.wf.2.2.1
      · exact h_new_bps_le
      · exact h_inv.wf.2.2.2.2
      · intro rid hactive
        exact h_inv.coverActive rid hactive
      · exact h_inv.nodup
  | SetPaused caller paused =>
      simp only [step] at h_step
      split at h_step <;> try (simp at h_step; done)
      injection h_step with heq
      apply E1Inv_carry_no_mutation s s' rids
        (by rw [← heq]) (by rw [← heq]) (by rw [← heq]) (by rw [← heq])
        (by rw [← heq]) (by rw [← heq]) h_inv
  | TransferOwnership caller newOwner =>
      simp only [step] at h_step
      split at h_step <;> try (simp at h_step; done)
      split at h_step <;> try (simp at h_step; done)
      split at h_step <;> try (simp at h_step; done)
      injection h_step with heq
      apply E1Inv_carry_no_mutation s s' rids
        (by rw [← heq]) (by rw [← heq]) (by rw [← heq]) (by rw [← heq])
        (by rw [← heq]) (by rw [← heq]) h_inv
  | ProposeAllowlistAdd caller integrator codehashPin perCall perBlock perDay
      integratorCodehash now =>
      simp only [step] at h_step
      split at h_step <;> try (simp at h_step; done)
      split at h_step <;> try (simp at h_step; done)
      split at h_step <;> try (simp at h_step; done)
      split at h_step <;> try (simp at h_step; done)
      split at h_step <;> try (simp at h_step; done)
      split at h_step <;> try (simp at h_step; done)
      split at h_step <;> try (simp at h_step; done)
      split at h_step <;> try (simp at h_step; done)
      split at h_step <;> try (simp at h_step; done)
      injection h_step with heq
      apply E1Inv_carry_no_mutation s s' rids
        (by rw [← heq]) (by rw [← heq]) (by rw [← heq]) (by rw [← heq])
        (by rw [← heq]) (by rw [← heq]) h_inv
  | CommitAllowlistAdd caller integrator integratorCodehash now =>
      simp only [step] at h_step
      split at h_step <;> try (simp at h_step; done)
      split at h_step <;> try (simp at h_step; done)
      split at h_step <;> try (simp at h_step; done)
      split at h_step <;> try (simp at h_step; done)
      split at h_step <;> try (simp at h_step; done)
      injection h_step with heq
      apply E1Inv_carry_no_mutation s s' rids
        (by rw [← heq]) (by rw [← heq]) (by rw [← heq]) (by rw [← heq])
        (by rw [← heq]) (by rw [← heq]) h_inv
  | ProposeAllowlistRemove caller integrator now =>
      simp only [step] at h_step
      split at h_step <;> try (simp at h_step; done)
      split at h_step <;> try (simp at h_step; done)
      split at h_step <;> try (simp at h_step; done)
      injection h_step with heq
      apply E1Inv_carry_no_mutation s s' rids
        (by rw [← heq]) (by rw [← heq]) (by rw [← heq]) (by rw [← heq])
        (by rw [← heq]) (by rw [← heq]) h_inv
  | CommitAllowlistRemove caller integrator now =>
      simp only [step] at h_step
      split at h_step <;> try (simp at h_step; done)
      split at h_step <;> try (simp at h_step; done)
      split at h_step <;> try (simp at h_step; done)
      split at h_step <;> try (simp at h_step; done)
      injection h_step with heq
      apply E1Inv_carry_no_mutation s s' rids
        (by rw [← heq]) (by rw [← heq]) (by rw [← heq]) (by rw [← heq])
        (by rw [← heq]) (by rw [← heq]) h_inv
  | PauseAllowlistEntry caller integrator =>
      simp only [step] at h_step
      split at h_step <;> try (simp at h_step; done)
      split at h_step <;> try (simp at h_step; done)
      split at h_step <;> try (simp at h_step; done)
      injection h_step with heq
      apply E1Inv_carry_no_mutation s s' rids
        (by rw [← heq]) (by rw [← heq]) (by rw [← heq]) (by rw [← heq])
        (by rw [← heq]) (by rw [← heq]) h_inv
  | ProposeAllowlistUnpause caller integrator now =>
      simp only [step] at h_step
      split at h_step <;> try (simp at h_step; done)
      split at h_step <;> try (simp at h_step; done)
      split at h_step <;> try (simp at h_step; done)
      split at h_step <;> try (simp at h_step; done)
      injection h_step with heq
      apply E1Inv_carry_no_mutation s s' rids
        (by rw [← heq]) (by rw [← heq]) (by rw [← heq]) (by rw [← heq])
        (by rw [← heq]) (by rw [← heq]) h_inv
  | CommitAllowlistUnpause caller integrator now =>
      simp only [step] at h_step
      split at h_step <;> try (simp at h_step; done)
      split at h_step <;> try (simp at h_step; done)
      split at h_step <;> try (simp at h_step; done)
      split at h_step <;> try (simp at h_step; done)
      split at h_step <;> try (simp at h_step; done)
      split at h_step <;> try (simp at h_step; done)
      injection h_step with heq
      apply E1Inv_carry_no_mutation s s' rids
        (by rw [← heq]) (by rw [← heq]) (by rw [← heq]) (by rw [← heq])
        (by rw [← heq]) (by rw [← heq]) h_inv
  | SetProtocolFeeSink caller newSink =>
      -- This DOES change protocolFeeSink. Need WellFormedTx.
      simp only [step] at h_step
      split at h_step <;> try (simp at h_step; done)
      split at h_step <;> try (simp at h_step; done)
      split at h_step <;> try (simp at h_step; done)
      injection h_step with heq
      unfold WellFormedTx at h_wf_tx
      subst heq
      refine ⟨?_, ⟨?_, ?_, ?_, ?_, ?_⟩, ?_, ?_⟩
      · exact h_inv.eq
      · exact h_wf_tx
      · exact h_inv.wf.2.1
      · exact h_inv.wf.2.2.1
      · exact h_inv.wf.2.2.2.1
      · exact h_inv.wf.2.2.2.2
      · intro rid hactive
        exact h_inv.coverActive rid hactive
      · exact h_inv.nodup
  | CreatePipeline caller pid p =>
      -- Changes `pipelines`. WellFormedTx ensures new agentOwner ≠ escrow.
      simp only [step] at h_step
      split at h_step <;> try (simp at h_step; done)
      split at h_step <;> try (simp at h_step; done)
      rename_i h_pipe_none
      split at h_step <;> try (simp at h_step; done)
      split at h_step <;> try (simp at h_step; done)
      split at h_step <;> try (simp at h_step; done)
      split at h_step <;> try (simp at h_step; done)
      split at h_step <;> try (simp at h_step; done)
      split at h_step <;> try (simp at h_step; done)
      split at h_step <;> try (simp at h_step; done)
      injection h_step with heq
      unfold WellFormedTx at h_wf_tx
      subst heq
      refine ⟨?_, ⟨?_, ?_, ?_, ?_, ?_⟩, ?_, ?_⟩
      · exact h_inv.eq
      · exact h_inv.wf.1
      · intro pid' p' hp'
        show s.escrowAddr ≠ p'.agentOwner
        -- hp' : updateMap s.pipelines pid (some p) pid' = some p'
        by_cases h_eq : pid' = pid
        · subst h_eq
          simp [updateMap_same] at hp'
          rw [← hp']; exact h_wf_tx
        · simp [updateMap_other _ _ _ _ h_eq] at hp'
          exact h_inv.wf.2.1 pid' p' hp'
      · exact h_inv.wf.2.2.1
      · exact h_inv.wf.2.2.2.1
      · exact h_inv.wf.2.2.2.2
      · intro rid hactive
        exact h_inv.coverActive rid hactive
      · exact h_inv.nodup
  | SetPipelineActive caller pid active =>
      -- Changes only `pipelines`. agentOwner of edited pipeline unchanged.
      simp only [step] at h_step
      split at h_step <;> try (simp at h_step; done)
      split at h_step <;> try (simp at h_step; done)
      rename_i p h_pipe_some
      injection h_step with heq
      subst heq
      refine ⟨?_, ⟨?_, ?_, ?_, ?_, ?_⟩, ?_, ?_⟩
      · exact h_inv.eq
      · exact h_inv.wf.1
      · intro pid' p' hp'
        show s.escrowAddr ≠ p'.agentOwner
        -- hp' : updateMap s.pipelines pid (some {p with active := active}) pid' = some p'
        by_cases h_eq : pid' = pid
        · subst h_eq
          simp [updateMap_same] at hp'
          rw [← hp']
          -- agentOwner of `{p with active := active}` is `p.agentOwner`.
          exact h_inv.wf.2.1 pid' p h_pipe_some
        · simp [updateMap_other _ _ _ _ h_eq] at hp'
          exact h_inv.wf.2.1 pid' p' hp'
      · exact h_inv.wf.2.2.1
      · exact h_inv.wf.2.2.2.1
      · exact h_inv.wf.2.2.2.2
      · intro rid hactive
        exact h_inv.coverActive rid hactive
      · exact h_inv.nodup
  | CommitSignal caller requestId commitHash mdc now =>
      -- Changes state Pending → Committed (both active). paidAmountOf unchanged.
      simp only [step] at h_step
      split at h_step <;> try (simp at h_step; done)
      rename_i r h_req_some
      split at h_step <;> try (simp at h_step; done)
      rename_i h_state
      split at h_step <;> try (simp at h_step; done)
      rename_i p h_pipe_some
      split at h_step <;> try (simp at h_step; done)
      rename_i h_caller
      split at h_step <;> try (simp at h_step; done)
      rename_i h_sla
      injection h_step with heq
      -- The new request at `requestId` has the same paidAmount, in active state.
      -- Other rids unchanged.
      have h_addr : s.escrowAddr = s'.escrowAddr := by rw [← heq]
      have h_tok : s.token = s'.token := by rw [← heq]
      have h_sink : s.protocolFeeSink = s'.protocolFeeSink := by rw [← heq]
      have h_pipe : s.pipelines = s'.pipelines := by rw [← heq]
      -- The new request at `requestId` has the same paidAmount.
      have h_paid_eq : ∀ rid, paidAmountOf s rid = paidAmountOf s' rid := by
        intro rid
        unfold paidAmountOf
        by_cases h_eq : rid = requestId
        · subst h_eq
          have hreq' : s'.requests rid = some
              { r with state := RequestState.Committed,
                       commitHash := commitHash,
                       committedAt := now } := by
            rw [← heq]; simp [updateMap_same]
          rw [h_req_some, hreq']
          -- Both branches active: Pending or Committed. The new state is Committed.
          have h_old_active : r.state = RequestState.Pending ∨ r.state = RequestState.Committed :=
            Or.inl (Classical.not_not.mp h_state)
          simp [h_old_active]
        · have : s'.requests rid = s.requests rid := by
            rw [← heq]; simp [updateMap_other _ _ _ _ h_eq]
          rw [this]
      have h_sum : liveSumList s rids = liveSumList s' rids := by
        apply liveSumList_congr
        intro rid _; exact h_paid_eq rid
      have h_bps : s.protocolFeeBps = s'.protocolFeeBps := by rw [← heq]
      refine ⟨?_, ⟨?_, ?_, ?_, ?_, ?_⟩, ?_, ?_⟩
      · rw [← h_sum, ← h_addr, ← h_tok]; exact h_inv.eq
      · rw [← h_addr, ← h_sink]; exact h_inv.wf.1
      · intro pid' p' hp'
        rw [← h_pipe] at hp'
        rw [← h_addr]
        exact h_inv.wf.2.1 pid' p' hp'
      · intro rid r' hr'
        rw [← h_addr]
        by_cases h_eq : rid = requestId
        · subst h_eq
          have : s'.requests rid = some
              { r with state := RequestState.Committed,
                       commitHash := commitHash,
                       committedAt := now } := by
            rw [← heq]; simp [updateMap_same]
          rw [this] at hr'; injection hr' with hrr
          rw [← hrr]
          -- r' = { r with ... }. Its buyer = r.buyer.
          exact h_inv.wf.2.2.1 rid r h_req_some
        · have : s'.requests rid = s.requests rid := by
            rw [← heq]; simp [updateMap_other _ _ _ _ h_eq]
          rw [this] at hr'
          exact h_inv.wf.2.2.1 rid r' hr'
      · rw [← h_bps]; exact h_inv.wf.2.2.2.1
      · intro rid r' hr'
        by_cases h_eq : rid = requestId
        · subst h_eq
          have : s'.requests rid = some
              { r with state := RequestState.Committed,
                       commitHash := commitHash,
                       committedAt := now } := by
            rw [← heq]; simp [updateMap_same]
          rw [this] at hr'; injection hr' with hrr
          rw [← hrr]
          exact h_inv.wf.2.2.2.2 rid r h_req_some
        · have : s'.requests rid = s.requests rid := by
            rw [← heq]; simp [updateMap_other _ _ _ _ h_eq]
          rw [this] at hr'
          exact h_inv.wf.2.2.2.2 rid r' hr'
      · intro rid hactive
        apply h_inv.coverActive
        unfold isActive at hactive ⊢
        by_cases h_eq : rid = requestId
        · subst h_eq
          rw [h_req_some]
          left
          exact Classical.not_not.mp h_state
        · have : s'.requests rid = s.requests rid := by
            rw [← heq]; simp [updateMap_other _ _ _ _ h_eq]
          rw [this] at hactive
          exact hactive
      · exact h_inv.nodup
  | RequestInference caller pid nonce now =>
      -- Creates a new active request at `rid = computeRequestId caller pid nonce`.
      -- Transfers `p.priceUsdc` into the escrow.
      -- LHS gains paidAmount = p.priceUsdc at rid.
      -- RHS gains p.priceUsdc.
      simp only [step] at h_step
      split at h_step <;> try (simp at h_step; done)
      rename_i h_paused
      split at h_step <;> try (simp at h_step; done)
      rename_i p h_pipe_some
      split at h_step <;> try (simp at h_step; done)
      rename_i h_active
      -- Use `let` to give `rid` a name local to this block.
      let rid := computeRequestId caller pid nonce
      have h_rid_def : rid = computeRequestId caller pid nonce := rfl
      split at h_step <;> try (simp at h_step; done)
      rename_i h_req_none
      split at h_step <;> try (simp at h_step; done)
      rename_i tok' h_tok_some
      injection h_step with heq
      -- Extract WellFormedTx and trace cover.
      unfold WellFormedTx at h_wf_tx
      have h_rid_in_rids : rid ∈ rids := by
        apply h_cover_tx rid
        simp [touchedRid, h_rid_def]
      -- Frame: escrowAddr, protocolFeeSink, pipelines, owner unchanged.
      have h_addr : s.escrowAddr = s'.escrowAddr := by rw [← heq]
      have h_sink : s.protocolFeeSink = s'.protocolFeeSink := by rw [← heq]
      have h_pipe : s.pipelines = s'.pipelines := by rw [← heq]
      -- Token: balanceOf escrowAddr increased by p.priceUsdc.
      have h_tok_s' : s'.token = tok' := by rw [← heq]
      have h_bal : s'.token.balanceOf s'.escrowAddr =
          s.token.balanceOf s.escrowAddr + p.priceUsdc := by
        unfold TokenState.transferFrom at h_tok_some
        have h_caller_ne : caller ≠ s.escrowAddr := Ne.symm h_wf_tx
        have hbalto :=
          transfer_balance_to s.token caller s.escrowAddr p.priceUsdc tok' h_tok_some h_caller_ne
        rw [← h_addr, h_tok_s']
        exact hbalto
      -- Request map: rid was none in s, is some r' in s'. paidAmountOf s rid = 0,
      -- paidAmountOf s' rid = p.priceUsdc.
      have h_paid_s_rid : paidAmountOf s rid = 0 := by
        unfold paidAmountOf
        rw [h_req_none]
      have h_paid_s'_rid : paidAmountOf s' rid = p.priceUsdc := by
        unfold paidAmountOf
        have h_req' : s'.requests rid = some
            { pipelineId := pid, buyer := caller, paidAmount := p.priceUsdc,
              paidAt := now, slaDeadline := now + p.slaSeconds,
              commitHash := Bytes32.zero, committedAt := 0,
              state := RequestState.Pending,
              protocolFeeBps := s.protocolFeeBps } := by
          show s'.requests (computeRequestId caller pid nonce) = _
          rw [← heq]
          show updateMap _ _ _ (computeRequestId caller pid nonce) = _
          exact updateMap_same _ _ _
        rw [h_req']; simp
      -- For other rids, paidAmountOf unchanged.
      have h_paid_other : ∀ other, other ≠ rid → paidAmountOf s other = paidAmountOf s' other := by
        intro other hne
        unfold paidAmountOf
        have h_req' : s'.requests other = s.requests other := by
          rw [← heq]
          show updateMap _ (computeRequestId caller pid nonce) _ other = _
          exact updateMap_other _ _ _ _ hne
        rw [h_req']
      -- liveSumList delta: gains p.priceUsdc at rid.
      have h_sum_delta :
          liveSumList s' rids = liveSumList s rids + p.priceUsdc := by
        have h_update := liveSumList_update_single s s' rids rid h_rid_in_rids h_inv.nodup
          (fun rid' _ hne => h_paid_other rid' hne)
        rw [h_paid_s_rid, h_paid_s'_rid] at h_update
        omega
      have h_bps : s.protocolFeeBps = s'.protocolFeeBps := by rw [← heq]
      refine ⟨?_, ⟨?_, ?_, ?_, ?_, ?_⟩, ?_, ?_⟩
      · rw [h_sum_delta, h_bal, h_inv.eq]
      · rw [← h_addr, ← h_sink]; exact h_inv.wf.1
      · intro pid' p' hp'
        rw [← h_pipe] at hp'
        rw [← h_addr]
        exact h_inv.wf.2.1 pid' p' hp'
      · intro rid' r hr'
        rw [← h_addr]
        by_cases h_eq : rid' = rid
        · subst h_eq
          have h_eq_buyer :
              s'.requests rid = some
                { pipelineId := pid, buyer := caller, paidAmount := p.priceUsdc,
                  paidAt := now, slaDeadline := now + p.slaSeconds,
                  commitHash := Bytes32.zero, committedAt := 0,
                  state := RequestState.Pending,
                  protocolFeeBps := s.protocolFeeBps } := by
            show s'.requests (computeRequestId caller pid nonce) = _
            rw [← heq]
            show updateMap _ _ _ (computeRequestId caller pid nonce) = _
            exact updateMap_same _ _ _
          rw [h_eq_buyer] at hr'
          injection hr' with hrr
          rw [← hrr]
          exact h_wf_tx
        · have h_eq_req : s'.requests rid' = s.requests rid' := by
            rw [← heq]
            show updateMap _ (computeRequestId caller pid nonce) _ rid' = _
            exact updateMap_other _ _ _ _ h_eq
          rw [h_eq_req] at hr'
          exact h_inv.wf.2.2.1 rid' r hr'
      · rw [← h_bps]; exact h_inv.wf.2.2.2.1
      · intro rid' r hr'
        by_cases h_eq : rid' = rid
        · subst h_eq
          have h_eq_req :
              s'.requests rid = some
                { pipelineId := pid, buyer := caller, paidAmount := p.priceUsdc,
                  paidAt := now, slaDeadline := now + p.slaSeconds,
                  commitHash := Bytes32.zero, committedAt := 0,
                  state := RequestState.Pending,
                  protocolFeeBps := s.protocolFeeBps } := by
            show s'.requests (computeRequestId caller pid nonce) = _
            rw [← heq]
            show updateMap _ _ _ (computeRequestId caller pid nonce) = _
            exact updateMap_same _ _ _
          rw [h_eq_req] at hr'
          injection hr' with hrr
          rw [← hrr]
          exact h_inv.wf.2.2.2.1
        · have h_eq_req : s'.requests rid' = s.requests rid' := by
            rw [← heq]
            show updateMap _ (computeRequestId caller pid nonce) _ rid' = _
            exact updateMap_other _ _ _ _ h_eq
          rw [h_eq_req] at hr'
          exact h_inv.wf.2.2.2.2 rid' r hr'
      · intro rid' hactive
        unfold isActive at hactive
        by_cases h_eq : rid' = rid
        · subst h_eq; exact h_rid_in_rids
        · have h_eq_req : s'.requests rid' = s.requests rid' := by
            rw [← heq]
            show updateMap _ (computeRequestId caller pid nonce) _ rid' = _
            exact updateMap_other _ _ _ _ h_eq
          rw [h_eq_req] at hactive
          apply h_inv.coverActive
          unfold isActive; exact hactive
      · exact h_inv.nodup
  | RequestInferenceFor caller buyer pid nonce auth now blockNumber =>
      -- Same balance shape as `RequestInference`, but the stored buyer is
      -- attested separately. Sig pays from `buyer`; Hooked pays from `caller`.
      simp only [step] at h_step
      by_cases h_paused : s.paused
      · rw [if_pos h_paused] at h_step
        nomatch h_step
      rw [if_neg h_paused] at h_step
      by_cases h_buyer_zero : buyer = Address.zero
      · rw [if_pos h_buyer_zero] at h_step
        nomatch h_step
      rw [if_neg h_buyer_zero] at h_step
      by_cases h_buyer_escrow : buyer = s.escrowAddr
      · rw [if_pos h_buyer_escrow] at h_step
        nomatch h_step
      rw [if_neg h_buyer_escrow] at h_step
      cases h_pipe_some : s.pipelines pid with
      | none =>
          rw [h_pipe_some] at h_step
          simp only at h_step
          nomatch h_step
      | some p =>
        rw [h_pipe_some] at h_step
        simp only at h_step
        by_cases h_inactive : ¬ p.active
        · rw [if_pos h_inactive] at h_step
          nomatch h_step
        rw [if_neg h_inactive] at h_step
        cases auth with
        | Sig deadline signer digest =>
          simp only at h_step
          by_cases h_deadline_zero : deadline = 0
          · rw [if_pos h_deadline_zero] at h_step
            nomatch h_step
          rw [if_neg h_deadline_zero] at h_step
          by_cases h_deadline_expired : now > deadline
          · rw [if_pos h_deadline_expired] at h_step
            nomatch h_step
          rw [if_neg h_deadline_expired] at h_step
          by_cases h_bad_signer : signer ≠ buyer
          · rw [if_pos h_bad_signer] at h_step
            nomatch h_step
          rw [if_neg h_bad_signer] at h_step
          by_cases h_digest_used : s.usedAuthDigest digest
          · rw [if_pos h_digest_used] at h_step
            nomatch h_step
          rw [if_neg h_digest_used] at h_step
          let rid := computeRequestId buyer pid nonce
          cases h_req_none : s.requests rid with
          | some _ =>
              rw [h_req_none] at h_step
              simp only at h_step
              nomatch h_step
          | none =>
              rw [h_req_none] at h_step
              simp only at h_step
              cases h_tok_some : s.token.transferFrom buyer s.escrowAddr p.priceUsdc with
              | none =>
                  rw [h_tok_some] at h_step
                  simp only at h_step
                  nomatch h_step
              | some tok' =>
                  rw [h_tok_some] at h_step
                  simp only at h_step
                  injection h_step with heq
                  unfold WellFormedTx at h_wf_tx
                  have h_buyer_ne : s.escrowAddr ≠ buyer := h_wf_tx.1
                  have h_rid_in_rids : rid ∈ rids := by
                    apply h_cover_tx rid
                    simp [touchedRid, rid]
                  exact
                    E1Inv_request_create
                      s s' rids rid pid buyer buyer p now tok'
                      h_req_none
                      (by rw [← heq])
                      (by rw [← heq])
                      (by rw [← heq])
                      (by rw [← heq])
                      (by rw [← heq])
                      (by rw [← heq])
                      h_tok_some
                      (Ne.symm h_buyer_ne)
                      h_buyer_ne
                      h_rid_in_rids
                      h_inv
        | Hooked callerCodehash =>
          simp only at h_step
          cases h_allow : s.allowlist caller with
          | none =>
              rw [h_allow] at h_step
              simp only at h_step
              nomatch h_step
          | some entry =>
              rw [h_allow] at h_step
              simp only at h_step
              by_cases h_uncommitted : entry.committedAt = 0
              · rw [if_pos h_uncommitted] at h_step
                nomatch h_step
              rw [if_neg h_uncommitted] at h_step
              by_cases h_paused_entry : entry.paused
              · rw [if_pos h_paused_entry] at h_step
                nomatch h_step
              rw [if_neg h_paused_entry] at h_step
              by_cases h_codehash : entry.codehashPin ≠ callerCodehash
              · rw [if_pos h_codehash] at h_step
                nomatch h_step
              rw [if_neg h_codehash] at h_step
              by_cases h_per_call : p.priceUsdc > entry.perCallCapUsdc
              · rw [if_pos h_per_call] at h_step
                nomatch h_step
              rw [if_neg h_per_call] at h_step
              let blockSpent :=
                if entry.spentBlockNumber = blockNumber
                  then entry.spentThisBlock + p.priceUsdc
                  else p.priceUsdc
              by_cases h_per_block : blockSpent > entry.perBlockCapUsdc
              · rw [if_pos h_per_block] at h_step
                nomatch h_step
              rw [if_neg h_per_block] at h_step
              let todayUtc := now / DAY_SECONDS
              let daySpent :=
                if entry.spentTodayDayUtc = todayUtc
                  then entry.spentToday + p.priceUsdc
                  else p.priceUsdc
              by_cases h_per_day : daySpent > entry.perDayCapUsdc
              · rw [if_pos h_per_day] at h_step
                nomatch h_step
              rw [if_neg h_per_day] at h_step
              let rid := computeRequestId buyer pid nonce
              cases h_req_none : s.requests rid with
              | some _ =>
                  rw [h_req_none] at h_step
                  simp only at h_step
                  nomatch h_step
              | none =>
                  rw [h_req_none] at h_step
                  simp only at h_step
                  cases h_tok_some : s.token.transferFrom caller s.escrowAddr p.priceUsdc with
                  | none =>
                      rw [h_tok_some] at h_step
                      simp only at h_step
                      nomatch h_step
                  | some tok' =>
                      rw [h_tok_some] at h_step
                      simp only at h_step
                      injection h_step with heq
                      unfold WellFormedTx at h_wf_tx
                      have h_buyer_ne : s.escrowAddr ≠ buyer := h_wf_tx.1
                      have h_caller_ne : s.escrowAddr ≠ caller := h_wf_tx.2
                      have h_rid_in_rids : rid ∈ rids := by
                        apply h_cover_tx rid
                        simp [touchedRid, rid]
                      exact
                        E1Inv_request_create
                          s s' rids rid pid buyer caller p now tok'
                          h_req_none
                          (by rw [← heq])
                          (by rw [← heq])
                          (by rw [← heq])
                          (by rw [← heq])
                          (by rw [← heq])
                          (by rw [← heq])
                          h_tok_some
                          (Ne.symm h_caller_ne)
                          h_buyer_ne
                          h_rid_in_rids
                          h_inv
  | Refund _caller requestId now =>
      -- Changes state Pending → Refunded. Transfers paidAmount to buyer.
      -- LHS loses paidAmount. RHS loses paidAmount.
      simp only [step] at h_step
      split at h_step <;> try (simp at h_step; done)
      rename_i r h_req_some
      split at h_step <;> try (simp at h_step; done)
      rename_i h_state_ne_pending
      split at h_step <;> try (simp at h_step; done)
      rename_i h_sla
      split at h_step <;> try (simp at h_step; done)
      rename_i tok' h_tok_some
      injection h_step with heq
      have h_rid_in_rids : requestId ∈ rids := by
        apply h_cover_tx requestId
        simp [touchedRid]
      -- Frame
      have h_addr : s.escrowAddr = s'.escrowAddr := by rw [← heq]
      have h_sink : s.protocolFeeSink = s'.protocolFeeSink := by rw [← heq]
      have h_pipe : s.pipelines = s'.pipelines := by rw [← heq]
      -- State was Pending (so active). r.paidAmount is the live value.
      have h_state_pending : r.state = RequestState.Pending :=
        Classical.not_not.mp h_state_ne_pending
      -- Buyer ≠ escrow from WellFormed.
      have h_buyer_ne : s.escrowAddr ≠ r.buyer := h_inv.wf.2.2.1 requestId r h_req_some
      -- Token: balanceOf escrowAddr drops by r.paidAmount.
      have h_tok_s' : s'.token = tok' := by rw [← heq]
      have h_bal : s'.token.balanceOf s'.escrowAddr =
          s.token.balanceOf s.escrowAddr - r.paidAmount := by
        have hbalfrom :=
          transfer_balance_from s.token s.escrowAddr r.buyer r.paidAmount tok' h_tok_some h_buyer_ne
        rw [← h_addr, h_tok_s']
        exact hbalfrom
      -- LHS: paidAmountOf changes from paidAmount to 0 at requestId.
      have h_paid_s_rid : paidAmountOf s requestId = r.paidAmount := by
        unfold paidAmountOf; rw [h_req_some]; simp [h_state_pending]
      have h_req_s' : s'.requests requestId = some { r with state := RequestState.Refunded } := by
        rw [← heq]
        show updateMap _ requestId _ requestId = _
        exact updateMap_same _ _ _
      have h_paid_s'_rid : paidAmountOf s' requestId = 0 := by
        unfold paidAmountOf
        rw [h_req_s']
        simp
      have h_paid_other : ∀ other, other ≠ requestId → paidAmountOf s other = paidAmountOf s' other := by
        intro other hne
        unfold paidAmountOf
        have h_req' : s'.requests other = s.requests other := by
          rw [← heq]
          show updateMap _ requestId _ other = _
          exact updateMap_other _ _ _ _ hne
        rw [h_req']
      -- Sum change
      have h_sum_delta : liveSumList s rids = liveSumList s' rids + r.paidAmount := by
        have h_update := liveSumList_update_single s s' rids requestId h_rid_in_rids h_inv.nodup
          (fun rid' _ hne => h_paid_other rid' hne)
        rw [h_paid_s_rid, h_paid_s'_rid] at h_update
        omega
      -- Need: r.paidAmount ≤ s.token.balanceOf s.escrowAddr (so the subtraction is exact).
      have h_paid_le_bal : r.paidAmount ≤ s.token.balanceOf s.escrowAddr := by
        have h_sum_ge : ∀ (rl : List Bytes32),
            requestId ∈ rl → paidAmountOf s requestId ≤ liveSumList s rl := by
          intro rl hmem
          unfold liveSumList
          induction rl with
          | nil => exact absurd hmem (List.not_mem_nil)
          | cons head tail ih =>
              simp only [List.map_cons, List.foldr_cons]
              by_cases h_head : head = requestId
              · subst h_head; omega
              · have h_rid_in_tail : requestId ∈ tail := by
                  cases hmem with
                  | head => exact absurd rfl h_head
                  | tail _ h => exact h
                have := ih h_rid_in_tail
                omega
        have h_le := h_sum_ge rids h_rid_in_rids
        rw [h_paid_s_rid] at h_le
        rw [← h_inv.eq]; exact h_le
      have h_bps : s.protocolFeeBps = s'.protocolFeeBps := by rw [← heq]
      have h_inv_eq := h_inv.eq
      refine ⟨?_, ⟨?_, ?_, ?_, ?_, ?_⟩, ?_, ?_⟩
      · rw [h_bal]; omega
      · rw [← h_addr, ← h_sink]; exact h_inv.wf.1
      · intro pid' p' hp'
        rw [← h_pipe] at hp'
        rw [← h_addr]
        exact h_inv.wf.2.1 pid' p' hp'
      · intro rid' r' hr'
        rw [← h_addr]
        by_cases h_eq : rid' = requestId
        · subst h_eq
          rw [h_req_s'] at hr'; injection hr' with hrr
          rw [← hrr]
          exact h_inv.wf.2.2.1 rid' r h_req_some
        · have h_req_other : s'.requests rid' = s.requests rid' := by
            rw [← heq]
            show updateMap _ requestId _ rid' = _
            exact updateMap_other _ _ _ _ h_eq
          rw [h_req_other] at hr'
          exact h_inv.wf.2.2.1 rid' r' hr'
      · rw [← h_bps]; exact h_inv.wf.2.2.2.1
      · intro rid' r' hr'
        by_cases h_eq : rid' = requestId
        · subst h_eq
          rw [h_req_s'] at hr'; injection hr' with hrr
          rw [← hrr]
          exact h_inv.wf.2.2.2.2 rid' r h_req_some
        · have h_req_other : s'.requests rid' = s.requests rid' := by
            rw [← heq]
            show updateMap _ requestId _ rid' = _
            exact updateMap_other _ _ _ _ h_eq
          rw [h_req_other] at hr'
          exact h_inv.wf.2.2.2.2 rid' r' hr'
      · intro rid' hactive
        unfold isActive at hactive
        by_cases h_eq : rid' = requestId
        · subst h_eq
          -- State at requestId in s' is Refunded, which is NOT active.
          rw [h_req_s'] at hactive
          simp only at hactive
          cases hactive with
          | inl h => exact absurd h (by intro hc; exact RequestState.noConfusion hc)
          | inr h => exact absurd h (by intro hc; exact RequestState.noConfusion hc)
        · have h_req_other : s'.requests rid' = s.requests rid' := by
            rw [← heq]
            show updateMap _ requestId _ rid' = _
            exact updateMap_other _ _ _ _ h_eq
          rw [h_req_other] at hactive
          apply h_inv.coverActive
          unfold isActive; exact hactive
      · exact h_inv.nodup
  | ForceRefundCommitted caller requestId now =>
      -- Changes state Committed → Refunded. Transfers paidAmount to buyer.
      -- LHS loses paidAmount. RHS loses paidAmount.
      simp only [step] at h_step
      split at h_step <;> try (simp at h_step; done)
      split at h_step <;> try (simp at h_step; done)
      rename_i r h_req_some
      split at h_step <;> try (simp at h_step; done)
      rename_i h_state_ne_committed
      split at h_step <;> try (simp at h_step; done)
      rename_i p h_pipe_some
      split at h_step <;> try (simp at h_step; done)
      rename_i h_grace
      split at h_step <;> try (simp at h_step; done)
      rename_i tok' h_tok_some
      injection h_step with heq
      have h_rid_in_rids : requestId ∈ rids := by
        apply h_cover_tx requestId
        simp [touchedRid]
      -- Frame
      have h_addr : s.escrowAddr = s'.escrowAddr := by rw [← heq]
      have h_sink : s.protocolFeeSink = s'.protocolFeeSink := by rw [← heq]
      have h_pipe : s.pipelines = s'.pipelines := by rw [← heq]
      -- State was Committed (so active). r.paidAmount is the live value.
      have h_state_committed : r.state = RequestState.Committed :=
        Classical.not_not.mp h_state_ne_committed
      -- Buyer ≠ escrow from WellFormed.
      have h_buyer_ne : s.escrowAddr ≠ r.buyer := h_inv.wf.2.2.1 requestId r h_req_some
      -- Token: balanceOf escrowAddr drops by r.paidAmount.
      have h_tok_s' : s'.token = tok' := by rw [← heq]
      have h_bal : s'.token.balanceOf s'.escrowAddr =
          s.token.balanceOf s.escrowAddr - r.paidAmount := by
        have hbalfrom :=
          transfer_balance_from s.token s.escrowAddr r.buyer r.paidAmount tok' h_tok_some h_buyer_ne
        rw [← h_addr, h_tok_s']
        exact hbalfrom
      -- LHS: paidAmountOf changes from paidAmount to 0 at requestId.
      have h_paid_s_rid : paidAmountOf s requestId = r.paidAmount := by
        unfold paidAmountOf; rw [h_req_some]
        have : r.state = RequestState.Pending ∨ r.state = RequestState.Committed :=
          Or.inr h_state_committed
        simp [this]
      have h_req_s' : s'.requests requestId = some { r with state := RequestState.Refunded } := by
        rw [← heq]
        show updateMap _ requestId _ requestId = _
        exact updateMap_same _ _ _
      have h_paid_s'_rid : paidAmountOf s' requestId = 0 := by
        unfold paidAmountOf
        rw [h_req_s']
        simp
      have h_paid_other : ∀ other, other ≠ requestId → paidAmountOf s other = paidAmountOf s' other := by
        intro other hne
        unfold paidAmountOf
        have h_req' : s'.requests other = s.requests other := by
          rw [← heq]
          show updateMap _ requestId _ other = _
          exact updateMap_other _ _ _ _ hne
        rw [h_req']
      -- Sum change
      have h_sum_delta : liveSumList s rids = liveSumList s' rids + r.paidAmount := by
        have h_update := liveSumList_update_single s s' rids requestId h_rid_in_rids h_inv.nodup
          (fun rid' _ hne => h_paid_other rid' hne)
        rw [h_paid_s_rid, h_paid_s'_rid] at h_update
        omega
      -- Need: r.paidAmount ≤ s.token.balanceOf s.escrowAddr (so the subtraction is exact).
      have h_paid_le_bal : r.paidAmount ≤ s.token.balanceOf s.escrowAddr := by
        have h_sum_ge : ∀ (rl : List Bytes32),
            requestId ∈ rl → paidAmountOf s requestId ≤ liveSumList s rl := by
          intro rl hmem
          unfold liveSumList
          induction rl with
          | nil => exact absurd hmem (List.not_mem_nil)
          | cons head tail ih =>
              simp only [List.map_cons, List.foldr_cons]
              by_cases h_head : head = requestId
              · subst h_head; omega
              · have h_rid_in_tail : requestId ∈ tail := by
                  cases hmem with
                  | head => exact absurd rfl h_head
                  | tail _ h => exact h
                have := ih h_rid_in_tail
                omega
        have h_le := h_sum_ge rids h_rid_in_rids
        rw [h_paid_s_rid] at h_le
        rw [← h_inv.eq]; exact h_le
      have h_bps : s.protocolFeeBps = s'.protocolFeeBps := by rw [← heq]
      have h_inv_eq := h_inv.eq
      refine ⟨?_, ⟨?_, ?_, ?_, ?_, ?_⟩, ?_, ?_⟩
      · rw [h_bal]; omega
      · rw [← h_addr, ← h_sink]; exact h_inv.wf.1
      · intro pid' p' hp'
        rw [← h_pipe] at hp'
        rw [← h_addr]
        exact h_inv.wf.2.1 pid' p' hp'
      · intro rid' r' hr'
        rw [← h_addr]
        by_cases h_eq : rid' = requestId
        · subst h_eq
          rw [h_req_s'] at hr'; injection hr' with hrr
          rw [← hrr]
          exact h_inv.wf.2.2.1 rid' r h_req_some
        · have h_req_other : s'.requests rid' = s.requests rid' := by
            rw [← heq]
            show updateMap _ requestId _ rid' = _
            exact updateMap_other _ _ _ _ h_eq
          rw [h_req_other] at hr'
          exact h_inv.wf.2.2.1 rid' r' hr'
      · rw [← h_bps]; exact h_inv.wf.2.2.2.1
      · intro rid' r' hr'
        by_cases h_eq : rid' = requestId
        · subst h_eq
          rw [h_req_s'] at hr'; injection hr' with hrr
          rw [← hrr]
          exact h_inv.wf.2.2.2.2 rid' r h_req_some
        · have h_req_other : s'.requests rid' = s.requests rid' := by
            rw [← heq]
            show updateMap _ requestId _ rid' = _
            exact updateMap_other _ _ _ _ h_eq
          rw [h_req_other] at hr'
          exact h_inv.wf.2.2.2.2 rid' r' hr'
      · intro rid' hactive
        unfold isActive at hactive
        by_cases h_eq : rid' = requestId
        · subst h_eq
          -- State at requestId in s' is Refunded, which is NOT active.
          rw [h_req_s'] at hactive
          simp only at hactive
          cases hactive with
          | inl h => exact absurd h (by intro hc; exact RequestState.noConfusion hc)
          | inr h => exact absurd h (by intro hc; exact RequestState.noConfusion hc)
        · have h_req_other : s'.requests rid' = s.requests rid' := by
            rw [← heq]
            show updateMap _ requestId _ rid' = _
            exact updateMap_other _ _ _ _ h_eq
          rw [h_req_other] at hactive
          apply h_inv.coverActive
          unfold isActive; exact hactive
      · exact h_inv.nodup
  | Cancel _caller requestId now =>
      -- Same shape as Refund: Pending → Canceled, transfer paidAmount to buyer.
      simp only [step] at h_step
      split at h_step <;> try (simp at h_step; done)
      rename_i r h_req_some
      split at h_step <;> try (simp at h_step; done)
      rename_i h_state_ne_pending
      split at h_step <;> try (simp at h_step; done)
      rename_i h_buyer
      split at h_step <;> try (simp at h_step; done)
      rename_i h_win
      split at h_step <;> try (simp at h_step; done)
      rename_i tok' h_tok_some
      injection h_step with heq
      have h_rid_in_rids : requestId ∈ rids := by
        apply h_cover_tx requestId
        simp [touchedRid]
      have h_addr : s.escrowAddr = s'.escrowAddr := by rw [← heq]
      have h_sink : s.protocolFeeSink = s'.protocolFeeSink := by rw [← heq]
      have h_pipe : s.pipelines = s'.pipelines := by rw [← heq]
      have h_state_pending : r.state = RequestState.Pending :=
        Classical.not_not.mp h_state_ne_pending
      have h_buyer_ne : s.escrowAddr ≠ r.buyer := h_inv.wf.2.2.1 requestId r h_req_some
      have h_tok_s' : s'.token = tok' := by rw [← heq]
      have h_bal : s'.token.balanceOf s'.escrowAddr =
          s.token.balanceOf s.escrowAddr - r.paidAmount := by
        have hbalfrom :=
          transfer_balance_from s.token s.escrowAddr r.buyer r.paidAmount tok' h_tok_some h_buyer_ne
        rw [← h_addr, h_tok_s']
        exact hbalfrom
      have h_paid_s_rid : paidAmountOf s requestId = r.paidAmount := by
        unfold paidAmountOf; rw [h_req_some]; simp [h_state_pending]
      have h_req_s' : s'.requests requestId = some { r with state := RequestState.Canceled } := by
        rw [← heq]
        show updateMap _ requestId _ requestId = _
        exact updateMap_same _ _ _
      have h_paid_s'_rid : paidAmountOf s' requestId = 0 := by
        unfold paidAmountOf
        rw [h_req_s']
        simp
      have h_paid_other : ∀ other, other ≠ requestId → paidAmountOf s other = paidAmountOf s' other := by
        intro other hne
        unfold paidAmountOf
        have h_req' : s'.requests other = s.requests other := by
          rw [← heq]
          show updateMap _ requestId _ other = _
          exact updateMap_other _ _ _ _ hne
        rw [h_req']
      have h_sum_delta : liveSumList s rids = liveSumList s' rids + r.paidAmount := by
        have h_update := liveSumList_update_single s s' rids requestId h_rid_in_rids h_inv.nodup
          (fun rid' _ hne => h_paid_other rid' hne)
        rw [h_paid_s_rid, h_paid_s'_rid] at h_update
        omega
      have h_paid_le_bal : r.paidAmount ≤ s.token.balanceOf s.escrowAddr := by
        have h_sum_ge : ∀ (rl : List Bytes32),
            requestId ∈ rl → paidAmountOf s requestId ≤ liveSumList s rl := by
          intro rl hmem
          unfold liveSumList
          induction rl with
          | nil => exact absurd hmem (List.not_mem_nil)
          | cons head tail ih =>
              simp only [List.map_cons, List.foldr_cons]
              by_cases h_head : head = requestId
              · subst h_head; omega
              · have h_rid_in_tail : requestId ∈ tail := by
                  cases hmem with
                  | head => exact absurd rfl h_head
                  | tail _ h => exact h
                have := ih h_rid_in_tail
                omega
        have h_le := h_sum_ge rids h_rid_in_rids
        rw [h_paid_s_rid] at h_le
        rw [← h_inv.eq]; exact h_le
      have h_bps : s.protocolFeeBps = s'.protocolFeeBps := by rw [← heq]
      have h_inv_eq := h_inv.eq
      refine ⟨?_, ⟨?_, ?_, ?_, ?_, ?_⟩, ?_, ?_⟩
      · rw [h_bal]; omega
      · rw [← h_addr, ← h_sink]; exact h_inv.wf.1
      · intro pid' p' hp'
        rw [← h_pipe] at hp'
        rw [← h_addr]
        exact h_inv.wf.2.1 pid' p' hp'
      · intro rid' r' hr'
        rw [← h_addr]
        by_cases h_eq : rid' = requestId
        · subst h_eq
          rw [h_req_s'] at hr'; injection hr' with hrr
          rw [← hrr]
          exact h_inv.wf.2.2.1 rid' r h_req_some
        · have h_req_other : s'.requests rid' = s.requests rid' := by
            rw [← heq]
            show updateMap _ requestId _ rid' = _
            exact updateMap_other _ _ _ _ h_eq
          rw [h_req_other] at hr'
          exact h_inv.wf.2.2.1 rid' r' hr'
      · rw [← h_bps]; exact h_inv.wf.2.2.2.1
      · intro rid' r' hr'
        by_cases h_eq : rid' = requestId
        · subst h_eq
          rw [h_req_s'] at hr'; injection hr' with hrr
          rw [← hrr]
          exact h_inv.wf.2.2.2.2 rid' r h_req_some
        · have h_req_other : s'.requests rid' = s.requests rid' := by
            rw [← heq]
            show updateMap _ requestId _ rid' = _
            exact updateMap_other _ _ _ _ h_eq
          rw [h_req_other] at hr'
          exact h_inv.wf.2.2.2.2 rid' r' hr'
      · intro rid' hactive
        unfold isActive at hactive
        by_cases h_eq : rid' = requestId
        · subst h_eq
          rw [h_req_s'] at hactive
          simp only at hactive
          cases hactive with
          | inl h => exact absurd h (by intro hc; exact RequestState.noConfusion hc)
          | inr h => exact absurd h (by intro hc; exact RequestState.noConfusion hc)
        · have h_req_other : s'.requests rid' = s.requests rid' := by
            rw [← heq]
            show updateMap _ requestId _ rid' = _
            exact updateMap_other _ _ _ _ h_eq
          rw [h_req_other] at hactive
          apply h_inv.coverActive
          unfold isActive; exact hactive
      · exact h_inv.nodup
  | Finalize _caller requestId signal nonce now =>
      -- The two-step transfer is the trickiest. Net effect: escrow balance
      -- drops by `fee + agentPayout = r.paidAmount`.
      simp only [step] at h_step
      split at h_step <;> try (simp at h_step; done)
      rename_i r h_req_some
      split at h_step <;> try (simp at h_step; done)
      rename_i h_state_ne_committed
      split at h_step <;> try (simp at h_step; done)
      rename_i p h_pipe_some
      split at h_step <;> try (simp at h_step; done)
      rename_i h_horizon
      split at h_step <;> try (simp at h_step; done)
      rename_i h_keccak
      -- Now: fee and agentPayout defined; feeStep branched on fee > 0.
      split at h_step <;> try (simp at h_step; done)
      rename_i tok'' h_feeStep
      split at h_step <;> try (simp at h_step; done)
      rename_i tokFinal h_payout
      injection h_step with heq
      have h_rid_in_rids : requestId ∈ rids := by
        apply h_cover_tx requestId
        simp [touchedRid]
      have h_addr : s.escrowAddr = s'.escrowAddr := by rw [← heq]
      have h_sink : s.protocolFeeSink = s'.protocolFeeSink := by rw [← heq]
      have h_pipe : s.pipelines = s'.pipelines := by rw [← heq]
      have h_state_committed : r.state = RequestState.Committed :=
        Classical.not_not.mp h_state_ne_committed
      -- WellFormed gives: escrow ≠ feeSink, escrow ≠ p.agentOwner.
      have h_sink_ne : s.escrowAddr ≠ s.protocolFeeSink := h_inv.wf.1
      have h_owner_ne : s.escrowAddr ≠ p.agentOwner := h_inv.wf.2.1 r.pipelineId p h_pipe_some
      have h_bps_max_le : r.protocolFeeBps ≤ MAX_PROTOCOL_FEE_BPS :=
        h_inv.wf.2.2.2.2 requestId r h_req_some
      have h_max_le_den : MAX_PROTOCOL_FEE_BPS ≤ BPS_DENOMINATOR := by
        show 1000 ≤ 10000
        omega
      have h_bps_le : r.protocolFeeBps ≤ BPS_DENOMINATOR :=
        Nat.le_trans h_bps_max_le h_max_le_den
      -- Compute fee and agentPayout.
      let fee : Nat := r.paidAmount * r.protocolFeeBps / BPS_DENOMINATOR
      let agentPayout : Nat := r.paidAmount - fee
      -- fee ≤ r.paidAmount
      have h_fee_le : fee ≤ r.paidAmount := by
        show r.paidAmount * r.protocolFeeBps / BPS_DENOMINATOR ≤ r.paidAmount
        have h_mul_le : r.paidAmount * r.protocolFeeBps ≤ r.paidAmount * BPS_DENOMINATOR :=
          Nat.mul_le_mul_left r.paidAmount h_bps_le
        have h_pos : 0 < BPS_DENOMINATOR := by show 0 < 10000; omega
        calc r.paidAmount * r.protocolFeeBps / BPS_DENOMINATOR
            ≤ r.paidAmount * BPS_DENOMINATOR / BPS_DENOMINATOR :=
              Nat.div_le_div_right h_mul_le
          _ = r.paidAmount := Nat.mul_div_cancel _ h_pos
      have h_fee_plus_payout : fee + agentPayout = r.paidAmount := by
        show fee + (r.paidAmount - fee) = r.paidAmount
        omega
      -- Token balance analysis. Two sub-cases on fee > 0.
      have h_tok_s' : s'.token = tokFinal := by rw [← heq]
      have h_bal_step1 : tok''.balanceOf s.escrowAddr = s.token.balanceOf s.escrowAddr - fee := by
        by_cases h_fee_pos : fee > 0
        · -- transfer escrow → sink fee
          rw [if_pos h_fee_pos] at h_feeStep
          exact transfer_balance_from s.token s.escrowAddr s.protocolFeeSink fee tok''
            h_feeStep h_sink_ne
        · -- fee = 0, tok'' = s.token
          have h_fee_zero : fee = 0 := by
            have : ¬ (0 < fee) := h_fee_pos
            exact Nat.eq_zero_of_le_zero (Nat.le_of_not_lt this)
          rw [if_neg h_fee_pos] at h_feeStep
          injection h_feeStep with h_tok''_eq
          rw [← h_tok''_eq, h_fee_zero, Nat.sub_zero]
      have h_bal_step2 : tokFinal.balanceOf s.escrowAddr = tok''.balanceOf s.escrowAddr - agentPayout :=
        transfer_balance_from tok'' s.escrowAddr p.agentOwner agentPayout tokFinal
          h_payout h_owner_ne
      have h_bal : s'.token.balanceOf s'.escrowAddr =
          s.token.balanceOf s.escrowAddr - r.paidAmount := by
        rw [← h_addr, h_tok_s', h_bal_step2, h_bal_step1]
        -- (s.bal - fee) - agentPayout = s.bal - r.paidAmount (need fee + payout ≤ s.bal)
        -- We have fee + agentPayout = r.paidAmount. Need fee ≤ s.bal AND agentPayout ≤ s.bal - fee.
        -- Better: just use h_fee_plus_payout and Nat.sub_sub.
        have h_eq_sub : s.token.balanceOf s.escrowAddr - fee - agentPayout
            = s.token.balanceOf s.escrowAddr - (fee + agentPayout) := by omega
        rw [h_eq_sub, h_fee_plus_payout]
      -- LHS: paidAmountOf at requestId drops from paidAmount to 0.
      have h_paid_s_rid : paidAmountOf s requestId = r.paidAmount := by
        unfold paidAmountOf; rw [h_req_some]
        have : r.state = RequestState.Pending ∨ r.state = RequestState.Committed :=
          Or.inr h_state_committed
        simp [this]
      have h_req_s' : s'.requests requestId = some { r with state := RequestState.Finalized } := by
        rw [← heq]
        show updateMap _ requestId _ requestId = _
        exact updateMap_same _ _ _
      have h_paid_s'_rid : paidAmountOf s' requestId = 0 := by
        unfold paidAmountOf
        rw [h_req_s']
        simp
      have h_paid_other : ∀ other, other ≠ requestId →
          paidAmountOf s other = paidAmountOf s' other := by
        intro other hne
        unfold paidAmountOf
        have h_req' : s'.requests other = s.requests other := by
          rw [← heq]
          show updateMap _ requestId _ other = _
          exact updateMap_other _ _ _ _ hne
        rw [h_req']
      have h_sum_delta : liveSumList s rids = liveSumList s' rids + r.paidAmount := by
        have h_update := liveSumList_update_single s s' rids requestId h_rid_in_rids h_inv.nodup
          (fun rid' _ hne => h_paid_other rid' hne)
        rw [h_paid_s_rid, h_paid_s'_rid] at h_update
        omega
      have h_paid_le_bal : r.paidAmount ≤ s.token.balanceOf s.escrowAddr := by
        have h_sum_ge : ∀ (rl : List Bytes32),
            requestId ∈ rl → paidAmountOf s requestId ≤ liveSumList s rl := by
          intro rl hmem
          unfold liveSumList
          induction rl with
          | nil => exact absurd hmem (List.not_mem_nil)
          | cons head tail ih =>
              simp only [List.map_cons, List.foldr_cons]
              by_cases h_head : head = requestId
              · subst h_head; omega
              · have h_rid_in_tail : requestId ∈ tail := by
                  cases hmem with
                  | head => exact absurd rfl h_head
                  | tail _ h => exact h
                have := ih h_rid_in_tail
                omega
        have h_le := h_sum_ge rids h_rid_in_rids
        rw [h_paid_s_rid] at h_le
        rw [← h_inv.eq]; exact h_le
      have h_bps : s.protocolFeeBps = s'.protocolFeeBps := by rw [← heq]
      have h_inv_eq := h_inv.eq
      refine ⟨?_, ⟨?_, ?_, ?_, ?_, ?_⟩, ?_, ?_⟩
      · rw [h_bal]; omega
      · rw [← h_addr, ← h_sink]; exact h_inv.wf.1
      · intro pid' p' hp'
        rw [← h_pipe] at hp'
        rw [← h_addr]
        exact h_inv.wf.2.1 pid' p' hp'
      · intro rid' r' hr'
        rw [← h_addr]
        by_cases h_eq : rid' = requestId
        · subst h_eq
          rw [h_req_s'] at hr'; injection hr' with hrr
          rw [← hrr]
          exact h_inv.wf.2.2.1 rid' r h_req_some
        · have h_req_other : s'.requests rid' = s.requests rid' := by
            rw [← heq]
            show updateMap _ requestId _ rid' = _
            exact updateMap_other _ _ _ _ h_eq
          rw [h_req_other] at hr'
          exact h_inv.wf.2.2.1 rid' r' hr'
      · rw [← h_bps]; exact h_inv.wf.2.2.2.1
      · intro rid' r' hr'
        by_cases h_eq : rid' = requestId
        · subst h_eq
          rw [h_req_s'] at hr'; injection hr' with hrr
          rw [← hrr]
          exact h_inv.wf.2.2.2.2 rid' r h_req_some
        · have h_req_other : s'.requests rid' = s.requests rid' := by
            rw [← heq]
            show updateMap _ requestId _ rid' = _
            exact updateMap_other _ _ _ _ h_eq
          rw [h_req_other] at hr'
          exact h_inv.wf.2.2.2.2 rid' r' hr'
      · intro rid' hactive
        unfold isActive at hactive
        by_cases h_eq : rid' = requestId
        · subst h_eq
          rw [h_req_s'] at hactive
          simp only at hactive
          cases hactive with
          | inl h => exact absurd h (by intro hc; exact RequestState.noConfusion hc)
          | inr h => exact absurd h (by intro hc; exact RequestState.noConfusion hc)
        · have h_req_other : s'.requests rid' = s.requests rid' := by
            rw [← heq]
            show updateMap _ requestId _ rid' = _
            exact updateMap_other _ _ _ _ h_eq
          rw [h_req_other] at hactive
          apply h_inv.coverActive
          unfold isActive; exact hactive
      · exact h_inv.nodup

/-- Final assembly: induction on `ReachableWF`. -/
theorem reachableWF_preserves_E1Inv
    (s₀ s : EscrowState) (trace : List Transition)
    (reach : ReachableWF s₀ trace s)
    (rids : List Bytes32)
    (h_trace_cover : traceCovered rids trace)
    (h_inv : E1Inv s₀ rids) :
    E1Inv s rids := by
  induction reach with
  | nil _ => exact h_inv
  | cons s s_mid s_final tx rest h_step h_wf_tx _ ih =>
      have ⟨h_cover_tx, h_cover_rest⟩ := h_trace_cover
      have h_mid : E1Inv s_mid rids :=
        step_preserves_E1Inv s s_mid tx rids h_step h_wf_tx h_cover_tx h_inv
      exact ih h_cover_rest h_mid

/-- E1 headline. Holds in equality form because the model is closed
    under `step` (no external donations). -/
theorem fundsConservation
    (s₀ s : EscrowState) (trace : List Transition)
    (reach : ReachableWF s₀ trace s)
    (rids : List Bytes32)
    (h_nodup : rids.Nodup)
    (h_init_cover : ∀ rid, isActive s₀ rid → rid ∈ rids)
    (h_trace_cover : traceCovered rids trace)
    (h_init_eq : liveSumList s₀ rids = s₀.token.balanceOf s₀.escrowAddr)
    (h_wf : WellFormed s₀)
    : liveSumList s rids = s.token.balanceOf s.escrowAddr :=
  (reachableWF_preserves_E1Inv s₀ s trace reach rids h_trace_cover
    ⟨h_init_eq, h_wf, h_init_cover, h_nodup⟩).eq

/-- Inequality form. -/
theorem fundsConservationLe
    (s₀ s : EscrowState) (trace : List Transition)
    (reach : ReachableWF s₀ trace s)
    (rids : List Bytes32)
    (h_nodup : rids.Nodup)
    (h_init_cover : ∀ rid, isActive s₀ rid → rid ∈ rids)
    (h_trace_cover : traceCovered rids trace)
    (h_init_eq : liveSumList s₀ rids = s₀.token.balanceOf s₀.escrowAddr)
    (h_wf : WellFormed s₀)
    : liveSumList s rids ≤ s.token.balanceOf s.escrowAddr :=
  Nat.le_of_eq
    (fundsConservation s₀ s trace reach rids h_nodup h_init_cover h_trace_cover h_init_eq h_wf)

end MurmurFV.Escrow
