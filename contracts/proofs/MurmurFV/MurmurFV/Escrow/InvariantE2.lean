import MurmurFV.Escrow.Transitions

namespace MurmurFV.Escrow

open MurmurFV.Common

/-! ## E2 — single commit per request

For every `requestId`, at most one successful `commitSignal(requestId, …)`
ever fires across any reachable trace. Enforced by the state-based check
`r.state = Pending` at line 260 of MurmurEscrow.sol. -/

/-- A trace is a list of transitions plus a starting state, such that
    every prefix step succeeds. Inductively defined. -/
inductive Reachable : EscrowState → List Transition → EscrowState → Prop where
  | nil : ∀ s, Reachable s [] s
  | cons :
      ∀ s s_mid s_final tx rest,
        step s tx = some s_mid →
        Reachable s_mid rest s_final →
        Reachable s (tx :: rest) s_final

/-- Syntactic count of `CommitSignal` transitions matching `rid` in a
    list. Counts the constructor occurrences regardless of pre-state.

    The headline theorem `singleCommit` shows that along any *reachable*
    trace (where every transition's `step` returned `some _`), this
    syntactic count is at most one — i.e. even attempts at a second
    commit cannot appear in the trace, because the second `step` would
    return `none` and `Reachable.cons` would not type-check. -/
def syntacticCommitCount (rid : Bytes32) : List Transition → Nat
  | [] => 0
  | tx :: rest =>
    (match tx with
      | .CommitSignal _ rid' _ _ _ => if rid' = rid then 1 else 0
      | _ => 0) + syntacticCommitCount rid rest

/-! ### Point-update lemmas for `updateMap`. -/

@[simp] theorem updateMap_same {α : Type}
    (f : Bytes32 → Option α) (k : Bytes32) (v : Option α) :
    updateMap f k v k = v := by
  unfold updateMap
  simp

@[simp] theorem updateMap_other {α : Type}
    (f : Bytes32 → Option α) (k k' : Bytes32) (v : Option α) (hne : k' ≠ k) :
    updateMap f k v k' = f k' := by
  unfold updateMap
  rw [if_neg hne]

/-- Lemma 1 — `commitSignal` succeeds only if the request was `Pending`. -/
theorem commitSignal_requires_pending
    (s s' : EscrowState) (caller : Address) (rid : Bytes32)
    (h : Bytes32) (mdc : Bytes32) (now : BlockTime) :
    step s (.CommitSignal caller rid h mdc now) = some s' →
    ∃ r, s.requests rid = some r ∧ r.state = RequestState.Pending := by
  intro hstep
  simp only [step] at hstep
  -- `cases hreq : s.requests rid` rewrites the goal too, so in the
  -- `some r` branch the existential's `s.requests rid` slot becomes
  -- `some r` and the witness is `rfl`.
  cases hreq : s.requests rid with
  | none =>
      rw [hreq] at hstep
      simp at hstep
  | some r =>
      rw [hreq] at hstep
      simp only at hstep
      refine ⟨r, rfl, ?_⟩
      -- Decide on the state guard. If `r.state ≠ .Pending`, the `if` arm
      -- forces `none = some s'`, contradiction. Otherwise we conclude.
      by_cases hne : r.state ≠ RequestState.Pending
      · rw [if_pos hne] at hstep
        simp at hstep
      · exact Classical.not_not.mp hne

/-- Lemma 2 — `commitSignal` moves the target request to `Committed`. -/
theorem commitSignal_transitions_to_committed
    (s s' : EscrowState) (caller : Address) (rid : Bytes32)
    (h : Bytes32) (mdc : Bytes32) (now : BlockTime) :
    step s (.CommitSignal caller rid h mdc now) = some s' →
    ∃ r', s'.requests rid = some r' ∧ r'.state = RequestState.Committed := by
  intro hstep
  simp only [step] at hstep
  cases hreq : s.requests rid with
  | none =>
      rw [hreq] at hstep
      simp at hstep
  | some r =>
      rw [hreq] at hstep
      simp only at hstep
      -- Walk the remaining guard chain. Each `none` arm contradicts hstep.
      by_cases h_state : r.state ≠ RequestState.Pending
      · rw [if_pos h_state] at hstep; simp at hstep
      · rw [if_neg h_state] at hstep
        cases hpipe : s.pipelines r.pipelineId with
        | none =>
            rw [hpipe] at hstep
            simp at hstep
        | some p =>
            rw [hpipe] at hstep
            simp only at hstep
            by_cases h_caller : caller ≠ p.agentOwner
            · rw [if_pos h_caller] at hstep; simp at hstep
            · rw [if_neg h_caller] at hstep
              by_cases h_sla : now > r.slaDeadline
              · rw [if_pos h_sla] at hstep; simp at hstep
              · rw [if_neg h_sla] at hstep
                -- Now hstep has the form `some { … } = some s'`. Extract s'.
                injection hstep with hstep_eq
                -- The new request is `{ r with state := .Committed, … }`.
                refine ⟨{ r with state := RequestState.Committed,
                                 commitHash := h, committedAt := now },
                        ?_, rfl⟩
                rw [← hstep_eq]
                simp [updateMap_same]

/-- Lemma 3 — no transition restores a request to `Pending`.

    The precondition is **strengthened** beyond what the prompt suggested:
    we require `∃ r, s.requests rid = some r ∧ r.state ≠ Pending` rather
    than the vacuous-when-empty version. The reason: `RequestInference`
    can legitimately write `Pending` at a *previously empty* slot, so the
    weaker form (vacuous on `none`) does NOT inductively preserve.

    The stronger form is preserved because `RequestInference` only fires
    when the slot is `none`; if the slot is already `some r`, the rid
    cannot collide with the new request's rid (the contract's no-replay
    guard at `MurmurEscrow.sol:223` reverts on collision). -/
theorem no_transition_restores_pending
    (s s' : EscrowState) (tx : Transition) (rid : Bytes32) :
    step s tx = some s' →
    (∃ r, s.requests rid = some r ∧ r.state ≠ RequestState.Pending) →
    (∃ r', s'.requests rid = some r' ∧ r'.state ≠ RequestState.Pending) := by
  intro hstep ⟨r, hreq, hne⟩
  -- Strategy: for each `tx` constructor, peel off `step` and `split` the
  -- conditional chain. The failure branches contradict `hstep`; in the
  -- success branch, derive `s'.requests rid` from `updateMap` or note
  -- that `s.requests` is unchanged.
  cases tx with
  | CreatePipeline caller pid p =>
      -- Touches `pipelines` only.
      simp only [step] at hstep
      split at hstep <;> try (simp at hstep; done)
      split at hstep <;> try (simp at hstep; done)
      split at hstep <;> try (simp at hstep; done)
      split at hstep <;> try (simp at hstep; done)
      split at hstep <;> try (simp at hstep; done)
      split at hstep <;> try (simp at hstep; done)
      injection hstep with heq
      exact ⟨r, by rw [← heq]; exact hreq, hne⟩
  | SetPipelineActive caller pid active =>
      simp only [step] at hstep
      split at hstep <;> try (simp at hstep; done)
      split at hstep <;> try (simp at hstep; done)
      injection hstep with heq
      exact ⟨r, by rw [← heq]; exact hreq, hne⟩
  | RequestInference caller pid nonce now =>
      simp only [step] at hstep
      split at hstep <;> try (simp at hstep; done)
      split at hstep <;> try (simp at hstep; done)
      split at hstep <;> try (simp at hstep; done)
      rename_i h_paused h_pipe p h_active
      -- Now `step` reduces to the `match s.requests (computeRequestId …)` arm.
      split at hstep <;> try (simp at hstep; done)
      rename_i h_new_rid
      -- Token transfer branch.
      split at hstep <;> try (simp at hstep; done)
      rename_i h_tok tok'
      injection hstep with heq
      -- The newly-written rid is `computeRequestId caller pid nonce`. It
      -- differs from our `rid` because our rid is `some r` while the
      -- newly-written one was `none`.
      have hne_rid : rid ≠ computeRequestId caller pid nonce := by
        intro heq_rid
        rw [heq_rid] at hreq
        rw [hreq] at h_new_rid
        nomatch h_new_rid
      refine ⟨r, ?_, hne⟩
      rw [← heq]
      simp [updateMap_other _ _ _ _ hne_rid, hreq]
  | CommitSignal caller requestId commitHash _mdc now =>
      simp only [step] at hstep
      split at hstep <;> try (simp at hstep; done)
      rename_i r2 hreq2
      split at hstep <;> try (simp at hstep; done)
      rename_i h_state
      split at hstep <;> try (simp at hstep; done)
      rename_i p h_pipe
      split at hstep <;> try (simp at hstep; done)
      split at hstep <;> try (simp at hstep; done)
      injection hstep with heq
      -- Either `rid = requestId` (new state = Committed) or different (unchanged).
      by_cases h_eq : rid = requestId
      · -- Same rid: the new state is `.Committed`, which is ≠ Pending.
        refine ⟨{ r2 with state := RequestState.Committed,
                          commitHash := commitHash,
                          committedAt := now }, ?_, ?_⟩
        · rw [← heq]; simp [h_eq, updateMap_same]
        · intro hcontra; exact RequestState.noConfusion hcontra
      · -- Different rid: slot at `rid` is unchanged.
        refine ⟨r, ?_, hne⟩
        rw [← heq]
        simp [updateMap_other _ _ _ _ h_eq, hreq]
  | Finalize _caller requestId signal nonce now =>
      simp only [step] at hstep
      split at hstep <;> try (simp at hstep; done)
      rename_i r2 hreq2
      split at hstep <;> try (simp at hstep; done)
      rename_i h_state
      split at hstep <;> try (simp at hstep; done)
      rename_i p h_pipe
      split at hstep <;> try (simp at hstep; done)
      split at hstep <;> try (simp at hstep; done)
      split at hstep <;> try (simp at hstep; done)
      split at hstep <;> try (simp at hstep; done)
      injection hstep with heq
      by_cases h_eq : rid = requestId
      · refine ⟨{ r2 with state := RequestState.Finalized }, ?_, ?_⟩
        · rw [← heq]; simp [h_eq, updateMap_same]
        · intro hcontra; exact RequestState.noConfusion hcontra
      · refine ⟨r, ?_, hne⟩
        rw [← heq]
        simp [updateMap_other _ _ _ _ h_eq, hreq]
  | Refund _caller requestId now =>
      simp only [step] at hstep
      split at hstep <;> try (simp at hstep; done)
      rename_i r2 hreq2
      split at hstep <;> try (simp at hstep; done)
      rename_i h_state
      split at hstep <;> try (simp at hstep; done)
      rename_i h_sla
      split at hstep <;> try (simp at hstep; done)
      injection hstep with heq
      by_cases h_eq : rid = requestId
      · refine ⟨{ r2 with state := RequestState.Refunded }, ?_, ?_⟩
        · rw [← heq]; simp [h_eq, updateMap_same]
        · intro hcontra; exact RequestState.noConfusion hcontra
      · refine ⟨r, ?_, hne⟩
        rw [← heq]
        simp [updateMap_other _ _ _ _ h_eq, hreq]
  | Cancel caller requestId now =>
      simp only [step] at hstep
      split at hstep <;> try (simp at hstep; done)
      rename_i r2 hreq2
      split at hstep <;> try (simp at hstep; done)
      rename_i h_state
      split at hstep <;> try (simp at hstep; done)
      rename_i h_buyer
      split at hstep <;> try (simp at hstep; done)
      rename_i h_win
      split at hstep <;> try (simp at hstep; done)
      injection hstep with heq
      by_cases h_eq : rid = requestId
      · refine ⟨{ r2 with state := RequestState.Canceled }, ?_, ?_⟩
        · rw [← heq]; simp [h_eq, updateMap_same]
        · intro hcontra; exact RequestState.noConfusion hcontra
      · refine ⟨r, ?_, hne⟩
        rw [← heq]
        simp [updateMap_other _ _ _ _ h_eq, hreq]
  | SubmitMerkleRoot caller _batchId _root =>
      simp only [step] at hstep
      split at hstep <;> try (simp at hstep; done)
      injection hstep with heq
      exact ⟨r, by rw [← heq]; exact hreq, hne⟩
  | SetProtocolFeeBps caller newBps =>
      simp only [step] at hstep
      split at hstep <;> try (simp at hstep; done)
      split at hstep <;> try (simp at hstep; done)
      injection hstep with heq
      exact ⟨r, by rw [← heq]; exact hreq, hne⟩
  | SetProtocolFeeSink caller newSink =>
      simp only [step] at hstep
      split at hstep <;> try (simp at hstep; done)
      injection hstep with heq
      exact ⟨r, by rw [← heq]; exact hreq, hne⟩
  | SetPaused caller paused =>
      simp only [step] at hstep
      split at hstep <;> try (simp at hstep; done)
      injection hstep with heq
      exact ⟨r, by rw [← heq]; exact hreq, hne⟩
  | TransferOwnership caller newOwner =>
      simp only [step] at hstep
      split at hstep <;> try (simp at hstep; done)
      injection hstep with heq
      exact ⟨r, by rw [← heq]; exact hreq, hne⟩

/-- Helper — once a request `rid` has settled into a non-`Pending` state,
    no transition in any subsequent reachable suffix can move it back to
    `Pending`. Iterates `no_transition_restores_pending` along `Reachable`.

    Also notes: in such a suffix, no `CommitSignal` for `rid` can fire.
    A `CommitSignal` would require (by `commitSignal_requires_pending`)
    the state to be `Pending`, which contradicts the propagated invariant.
    We package this as `syntacticCommitCount rid suffix = 0`. -/
theorem nonPending_propagates_with_no_commits
    (rid : Bytes32) (trace : List Transition) (s s' : EscrowState)
    (reach : Reachable s trace s')
    (hpre : ∃ r, s.requests rid = some r ∧ r.state ≠ RequestState.Pending) :
    (∃ r', s'.requests rid = some r' ∧ r'.state ≠ RequestState.Pending) ∧
    syntacticCommitCount rid trace = 0 := by
  induction reach with
  | nil s =>
      exact ⟨hpre, by simp [syntacticCommitCount]⟩
  | cons s s_mid s_final tx rest hstep _hrest ih =>
      -- 1. Show the invariant carries to `s_mid`.
      have h_mid := no_transition_restores_pending s s_mid tx rid hstep hpre
      -- 2. Recursive call on the suffix.
      have ⟨h_final, h_rest_zero⟩ := ih h_mid
      refine ⟨h_final, ?_⟩
      -- 3. The current `tx` cannot be a `CommitSignal` for `rid`, because
      --    `commitSignal_requires_pending` would force `s.requests rid =
      --    some r ∧ r.state = Pending`, contradicting `hpre`.
      simp only [syntacticCommitCount]
      cases tx with
      | CommitSignal caller requestId commitHash mdc now =>
          by_cases h_eq : requestId = rid
          · -- Contradiction with hpre.
            subst h_eq
            have ⟨r0, hreq0, hpend⟩ :=
              commitSignal_requires_pending s s_mid caller requestId commitHash mdc now hstep
            obtain ⟨r_pre, hreq_pre, hne_pre⟩ := hpre
            rw [hreq_pre] at hreq0
            injection hreq0 with hreq0_eq
            -- `hreq0_eq : r_pre = r0`, so `r0.state = r_pre.state`.
            rw [← hreq0_eq] at hpend
            exact absurd hpend hne_pre
          · simp [h_eq, h_rest_zero]
      | CreatePipeline _ _ _ => simp [h_rest_zero]
      | SetPipelineActive _ _ _ => simp [h_rest_zero]
      | RequestInference _ _ _ _ => simp [h_rest_zero]
      | Finalize _ _ _ _ _ => simp [h_rest_zero]
      | Refund _ _ _ => simp [h_rest_zero]
      | Cancel _ _ _ => simp [h_rest_zero]
      | SubmitMerkleRoot _ _ _ => simp [h_rest_zero]
      | SetProtocolFeeBps _ _ => simp [h_rest_zero]
      | SetProtocolFeeSink _ _ => simp [h_rest_zero]
      | SetPaused _ _ => simp [h_rest_zero]
      | TransferOwnership _ _ => simp [h_rest_zero]

/-- E2 headline — along any reachable trace, the syntactic count of
    `CommitSignal` transitions for `rid` is at most one.

    Stronger than "at most one *successful* commit": `Reachable` rules
    out failing transitions in the trace by construction, so even
    *attempts* at a second commit on the same `rid` cannot appear. -/
theorem singleCommit
    (rid : Bytes32) (trace : List Transition) (s₀ s : EscrowState)
    (reach : Reachable s₀ trace s) :
    syntacticCommitCount rid trace ≤ 1 := by
  induction reach with
  | nil s =>
      simp [syntacticCommitCount]
  | cons s s_mid s_final tx rest hstep hrest ih =>
      simp only [syntacticCommitCount]
      cases tx with
      | CommitSignal caller requestId commitHash mdc now =>
          by_cases h_eq : requestId = rid
          · -- This is the (only) commit for `rid`. Lemma 2 gives evidence
            -- that `s_mid.requests rid` is now `≠ Pending`; helper then
            -- gives `syntacticCommitCount rid rest = 0`.
            subst h_eq
            have ⟨r', hreq', hcomm⟩ :=
              commitSignal_transitions_to_committed s s_mid caller requestId commitHash mdc now hstep
            have hne' : r'.state ≠ RequestState.Pending := by
              rw [hcomm]; intro hc; exact RequestState.noConfusion hc
            have ⟨_, h_rest_zero⟩ :=
              nonPending_propagates_with_no_commits requestId rest s_mid s_final hrest
                ⟨r', hreq', hne'⟩
            simp [h_rest_zero]
          · simp [h_eq]; exact ih
      | CreatePipeline _ _ _ => simp; exact ih
      | SetPipelineActive _ _ _ => simp; exact ih
      | RequestInference _ _ _ _ => simp; exact ih
      | Finalize _ _ _ _ _ => simp; exact ih
      | Refund _ _ _ => simp; exact ih
      | Cancel _ _ _ => simp; exact ih
      | SubmitMerkleRoot _ _ _ => simp; exact ih
      | SetProtocolFeeBps _ _ => simp; exact ih
      | SetProtocolFeeSink _ _ => simp; exact ih
      | SetPaused _ _ => simp; exact ih
      | TransferOwnership _ _ => simp; exact ih

end MurmurFV.Escrow
