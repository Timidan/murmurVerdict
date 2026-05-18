import MurmurFV.SealedVerdicts.Transitions

namespace MurmurFV.SealedVerdicts

open MurmurFV.Common

/-! ## V1 — Sealed-call handle immutability

Once `SubmitSealedFor` writes a SealedCall into `calls[callId]`, the FHE
handle fields `binaryIndex` and `confidenceBps` are never re-written by
any subsequent transition.

The proof is a 12-arm case-bash. Only `SubmitSealedFor` writes
`calls[cid].binaryIndex` / `.confidenceBps`, and only when `s.calls cid =
none` (which contradicts the precondition that `s.calls cid = some c`).
All other transitions either write to a different field or a different
cid or don't touch `calls` at all. -/

/-- Local map-update helpers, mirrored from `Escrow/InvariantE2.lean`
    because each invariant file is self-contained per directory
    convention. -/
@[simp] theorem updateMap_same_calls {α : Type}
    (f : Bytes32 → Option α) (k : Bytes32) (v : Option α) :
    updateMap f k v k = v := by
  unfold updateMap
  simp

@[simp] theorem updateMap_other_calls {α : Type}
    (f : Bytes32 → Option α) (k k' : Bytes32) (v : Option α) (hne : k' ≠ k) :
    updateMap f k v k' = f k' := by
  unfold updateMap
  rw [if_neg hne]

/-- V1 headline theorem. Single-step formulation: any transition that
    successfully fires preserves the (binaryIndex, confidenceBps) handles
    on an existing call.

    Strategy: per-constructor case-bash on `tx`. The 9 "doesn't touch
    calls" constructors trivially give `s'.calls = s.calls`, so `c = c'`.
    `OpenReveal` / `PublishReveal` write a SealedCall that shares the
    same handle fields with the original. `SubmitSealedFor` requires
    `s.calls cid' = none`, which contradicts `h_pre` when `cid' = cid`. -/
theorem handleImmutability
    (s s' : SealedVerdictsState) (tx : Transition) (cid : Bytes32)
    (c : SealedCall) (h_pre : s.calls cid = some c)
    (h_step : step s tx = some s')
    (c' : SealedCall) (h_post : s'.calls cid = some c') :
    c.binaryIndex = c'.binaryIndex ∧ c.confidenceBps = c'.confidenceBps := by
  cases tx with
  -- ── Group A: doesn't touch `calls` ──────────────────────────────────
  | TransferOwnership caller newOwner =>
      simp only [step] at h_step
      split at h_step <;> try (simp at h_step; done)
      split at h_step <;> try (simp at h_step; done)
      injection h_step with heq
      subst heq
      simp at h_post
      rw [h_pre] at h_post
      injection h_post with h_cc
      rw [h_cc]
      exact ⟨rfl, rfl⟩
  | AcceptOwnership caller =>
      simp only [step] at h_step
      split at h_step <;> try (simp at h_step; done)
      injection h_step with heq
      subst heq
      simp at h_post
      rw [h_pre] at h_post
      injection h_post with h_cc
      rw [h_cc]
      exact ⟨rfl, rfl⟩
  | SetRelayer caller relayer active =>
      simp only [step] at h_step
      split at h_step <;> try (simp at h_step; done)
      split at h_step <;> try (simp at h_step; done)
      injection h_step with heq
      subst heq
      simp at h_post
      rw [h_pre] at h_post
      injection h_post with h_cc
      rw [h_cc]
      exact ⟨rfl, rfl⟩
  | RegisterMarket caller marketId horizonSeconds active =>
      simp only [step] at h_step
      split at h_step <;> try (simp at h_step; done)
      split at h_step <;> try (simp at h_step; done)
      injection h_step with heq
      subst heq
      simp at h_post
      rw [h_pre] at h_post
      injection h_post with h_cc
      rw [h_cc]
      exact ⟨rfl, rfl⟩
  | RegisterFixedRevealMarket caller marketId revealAfter active now =>
      simp only [step] at h_step
      split at h_step <;> try (simp at h_step; done)
      split at h_step <;> try (simp at h_step; done)
      injection h_step with heq
      subst heq
      simp at h_post
      rw [h_pre] at h_post
      injection h_post with h_cc
      rw [h_cc]
      exact ⟨rfl, rfl⟩
  | SetMarketActive caller marketId active =>
      simp only [step] at h_step
      split at h_step <;> try (simp at h_step; done)
      split at h_step <;> try (simp at h_step; done)
      injection h_step with heq
      subst heq
      simp at h_post
      rw [h_pre] at h_post
      injection h_post with h_cc
      rw [h_cc]
      exact ⟨rfl, rfl⟩
  | SubmitFeedPacketFor caller agent packetId feedId marketId revealAfter action signalBps now =>
      simp only [step] at h_step
      split at h_step <;> try (simp at h_step; done)
      split at h_step <;> try (simp at h_step; done)
      split at h_step <;> try (simp at h_step; done)
      split at h_step <;> try (simp at h_step; done)
      injection h_step with heq
      subst heq
      simp at h_post
      rw [h_pre] at h_post
      injection h_post with h_cc
      rw [h_cc]
      exact ⟨rfl, rfl⟩
  | OpenFeedPacketReveal caller packetId now =>
      simp only [step] at h_step
      split at h_step <;> try (simp at h_step; done)
      split at h_step <;> try (simp at h_step; done)
      split at h_step <;> try (simp at h_step; done)
      injection h_step with heq
      subst heq
      simp at h_post
      rw [h_pre] at h_post
      injection h_post with h_cc
      rw [h_cc]
      exact ⟨rfl, rfl⟩
  | PublishFeedPacketReveal caller packetId revealedAction revealedSignal now =>
      simp only [step] at h_step
      split at h_step <;> try (simp at h_step; done)
      split at h_step <;> try (simp at h_step; done)
      injection h_step with heq
      subst heq
      simp at h_post
      rw [h_pre] at h_post
      injection h_post with h_cc
      rw [h_cc]
      exact ⟨rfl, rfl⟩
  -- ── Group B: writes a different field of the same call ──────────────
  | OpenReveal _caller callId' now =>
      simp only [step] at h_step
      split at h_step <;> try (simp at h_step; done)
      rename_i c0 hreq0
      split at h_step <;> try (simp at h_step; done)
      split at h_step <;> try (simp at h_step; done)
      injection h_step with heq
      subst heq
      -- h_post : (the new state).calls cid = some c'
      simp at h_post
      by_cases h_eq : cid = callId'
      · subst h_eq
        simp [updateMap_same_calls] at h_post
        rw [hreq0] at h_pre
        injection h_pre with h_cc0
        subst h_cc0
        rw [← h_post]
        exact ⟨rfl, rfl⟩
      · rw [updateMap_other_calls _ _ _ _ h_eq] at h_post
        rw [h_pre] at h_post
        injection h_post with h_cc
        rw [h_cc]
        exact ⟨rfl, rfl⟩
  | PublishReveal _caller callId' revealedBin revealedConf now =>
      simp only [step] at h_step
      split at h_step <;> try (simp at h_step; done)
      rename_i c0 hreq0
      split at h_step <;> try (simp at h_step; done)
      injection h_step with heq
      subst heq
      simp at h_post
      by_cases h_eq : cid = callId'
      · subst h_eq
        simp [updateMap_same_calls] at h_post
        rw [hreq0] at h_pre
        injection h_pre with h_cc0
        subst h_cc0
        rw [← h_post]
        exact ⟨rfl, rfl⟩
      · rw [updateMap_other_calls _ _ _ _ h_eq] at h_post
        rw [h_pre] at h_post
        injection h_post with h_cc
        rw [h_cc]
        exact ⟨rfl, rfl⟩
  -- ── Group C: writes the calls map at a fresh slot ───────────────────
  | SubmitSealedFor caller agent callId' marketId binaryIndex confidenceBps now =>
      simp only [step] at h_step
      split at h_step <;> try (simp at h_step; done)
      split at h_step <;> try (simp at h_step; done)
      split at h_step <;> try (simp at h_step; done)
      rename_i m hmkt
      split at h_step <;> try (simp at h_step; done)
      split at h_step <;> try (simp at h_step; done)
      rename_i hcall
      split at h_step <;> try (simp at h_step; done)
      injection h_step with heq
      subst heq
      simp at h_post
      by_cases h_eq : cid = callId'
      · subst h_eq
        rw [hcall] at h_pre
        nomatch h_pre
      · rw [updateMap_other_calls _ _ _ _ h_eq] at h_post
        rw [h_pre] at h_post
        injection h_post with h_cc
        rw [h_cc]
        exact ⟨rfl, rfl⟩

end MurmurFV.SealedVerdicts
