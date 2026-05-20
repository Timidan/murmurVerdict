import MurmurFV.SealedVerdicts.Transitions

namespace MurmurFV.SealedVerdicts

open MurmurFV.Common

/-! ## V2 — Reveal time gating

Two-part theorem on sealed calls:

1. **Snapshot lemma (`revealOpenAtImmutable`):** For every `callId`, the
   stored `calls[callId].revealOpenAt` is set exactly once at submit time
   (in `SubmitSealedFor`'s step) and is never re-mutated by any
   subsequent transition.

2. **Gating corollary (`revealTimeGating`):** Every successful invocation
   of `OpenReveal(callId, now)` satisfies `now ≥ calls[callId].revealOpenAt`.

The snapshot lemma is a mechanical mirror of V1's `handleImmutability`:
case-bash on the 12 `Transition` constructors. Only `SubmitSealedFor`
writes a fresh `revealOpenAt`, and only when `s.calls cid = none` —
contradicting `h_pre` whenever the cids collide. All other arms either
preserve `s.calls` outright or write a call whose `revealOpenAt` field
literally `= c.revealOpenAt` (the contracts' `OpenReveal` and
`PublishReveal` arms only mutate `state` / plaintext-mirror fields).

The gating corollary is a single-arm extraction: the `OpenReveal` arm of
`step` (`Transitions.lean:189-198`) explicitly returns `none` when
`now < c.revealOpenAt`, so any committed successor witnesses the negated
strict inequality, i.e. `now ≥ c.revealOpenAt`. -/

/-- Local map-update helpers, named with a `_v2` suffix to coexist with
    V1's identically-shaped lemmas inside the same namespace. -/
@[simp] theorem updateMap_same_calls_v2 {α : Type}
    (f : Bytes32 → Option α) (k : Bytes32) (v : Option α) :
    updateMap f k v k = v := by
  unfold updateMap
  simp

@[simp] theorem updateMap_other_calls_v2 {α : Type}
    (f : Bytes32 → Option α) (k k' : Bytes32) (v : Option α) (hne : k' ≠ k) :
    updateMap f k v k' = f k' := by
  unfold updateMap
  rw [if_neg hne]

/-- Snapshot lemma. The stored `revealOpenAt` of an existing call is
    never mutated by any reachable transition. -/
theorem revealOpenAtImmutable
    (s s' : SealedVerdictsState) (tx : Transition) (cid : Bytes32)
    (c : SealedCall) (h_pre : s.calls cid = some c)
    (h_step : step s tx = some s')
    (c' : SealedCall) (h_post : s'.calls cid = some c') :
    c.revealOpenAt = c'.revealOpenAt := by
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
  | AcceptOwnership caller =>
      simp only [step] at h_step
      split at h_step <;> try (simp at h_step; done)
      injection h_step with heq
      subst heq
      simp at h_post
      rw [h_pre] at h_post
      injection h_post with h_cc
      rw [h_cc]
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
  -- ── Group B: writes only `state` (revealOpenAt preserved) ───────────
  | OpenReveal _caller callId' now =>
      simp only [step] at h_step
      split at h_step <;> try (simp at h_step; done)
      rename_i c0 hreq0
      split at h_step <;> try (simp at h_step; done)
      split at h_step <;> try (simp at h_step; done)
      injection h_step with heq
      subst heq
      simp at h_post
      by_cases h_eq : cid = callId'
      · subst h_eq
        simp [updateMap_same_calls_v2] at h_post
        rw [hreq0] at h_pre
        injection h_pre with h_cc0
        subst h_cc0
        rw [← h_post]
      · rw [updateMap_other_calls_v2 _ _ _ _ h_eq] at h_post
        rw [h_pre] at h_post
        injection h_post with h_cc
        rw [h_cc]
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
        simp [updateMap_same_calls_v2] at h_post
        rw [hreq0] at h_pre
        injection h_pre with h_cc0
        subst h_cc0
        rw [← h_post]
      · rw [updateMap_other_calls_v2 _ _ _ _ h_eq] at h_post
        rw [h_pre] at h_post
        injection h_post with h_cc
        rw [h_cc]
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
      · rw [updateMap_other_calls_v2 _ _ _ _ h_eq] at h_post
        rw [h_pre] at h_post
        injection h_post with h_cc
        rw [h_cc]

/-- Gating corollary. A successful `OpenReveal(callId, now)` requires
    `now ≥ calls[callId].revealOpenAt`.

    Single-arm extraction: `step` on the `OpenReveal` constructor reverts
    (`= none`) when `now < c.revealOpenAt`. So `step ... = some s'`
    witnesses the negated strict inequality, which on `Nat` is exactly
    `now ≥ c.revealOpenAt`. -/
theorem revealTimeGating
    (s s' : SealedVerdictsState) (caller : Address) (cid : Bytes32) (now : BlockTime)
    (h_step : step s (.OpenReveal caller cid now) = some s')
    (c : SealedCall) (h_pre : s.calls cid = some c) :
    now ≥ c.revealOpenAt := by
  simp only [step, h_pre] at h_step
  -- Peel off the `c.state ≠ .Sealed → none` guard.
  split at h_step <;> try (simp at h_step; done)
  -- Survivor: `if now < c.revealOpenAt then none else some _`.
  split at h_step
  · -- `now < c.revealOpenAt` branch ⇒ `step = none`, contradicting h_step.
    simp at h_step
  · -- `¬ now < c.revealOpenAt` branch ⇒ `now ≥ c.revealOpenAt`.
    rename_i h_nlt
    cases BlockTimeMonotone c.revealOpenAt now with
    | inl h_order => exact h_order
    | inr h_order =>
        have h_le : c.revealOpenAt ≤ now := Nat.not_lt.mp h_nlt
        have h_eq : now = c.revealOpenAt := Nat.le_antisymm h_order h_le
        exact Nat.le_of_eq h_eq.symm

end MurmurFV.SealedVerdicts
