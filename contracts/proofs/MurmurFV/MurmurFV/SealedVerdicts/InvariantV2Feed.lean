import MurmurFV.SealedVerdicts.Transitions

namespace MurmurFV.SealedVerdicts

open MurmurFV.Common

/-! ## V2Feed — Feed-packet reveal time gating

Symmetric to V2, for feed packets. Two-part theorem:

1. **Snapshot lemma (`feedRevealAfterImmutable`):** For every `packetId`,
   the stored `feedPackets[packetId].revealAfter` is set exactly once at
   submit time (in `SubmitFeedPacketFor`'s step) and is never re-mutated
   by any subsequent transition.

2. **Gating corollary (`feedRevealTimeGating`):** Every successful
   invocation of `OpenFeedPacketReveal(packetId, now)` satisfies
   `now ≥ feedPackets[packetId].revealAfter`.

The snapshot lemma is a mechanical mirror of V2's `revealOpenAtImmutable`:
case-bash on the 12 `Transition` constructors. Only `SubmitFeedPacketFor`
writes a fresh `revealAfter`, and only when `s.feedPackets pid = none` —
contradicting `h_pre` whenever the pids collide. All other arms either
preserve `s.feedPackets` outright or write a feed packet whose
`revealAfter` field literally `= p.revealAfter` (`OpenFeedPacketReveal`
and `PublishFeedPacketReveal` arms only mutate `state` / plaintext-mirror
fields).

The gating corollary is a single-arm extraction: the
`OpenFeedPacketReveal` arm of `step` (`Transitions.lean:280-289`)
explicitly returns `none` when `now < p.revealAfter`, so any committed
successor witnesses the negated strict inequality, i.e.
`now ≥ p.revealAfter`. -/

/-- Local map-update helpers, named with a `_v2` suffix to coexist with
    V1Feed's identically-shaped lemmas inside the same namespace. -/
@[simp] theorem updateMap_same_feedPackets_v2 {α : Type}
    (f : Bytes32 → Option α) (k : Bytes32) (v : Option α) :
    updateMap f k v k = v := by
  unfold updateMap
  simp

@[simp] theorem updateMap_other_feedPackets_v2 {α : Type}
    (f : Bytes32 → Option α) (k k' : Bytes32) (v : Option α) (hne : k' ≠ k) :
    updateMap f k v k' = f k' := by
  unfold updateMap
  rw [if_neg hne]

/-- Snapshot lemma. The stored `revealAfter` of an existing feed packet is
    never mutated by any reachable transition. -/
theorem feedRevealAfterImmutable
    (s s' : SealedVerdictsState) (tx : Transition) (pid : Bytes32)
    (p : SealedFeedPacket) (h_pre : s.feedPackets pid = some p)
    (h_step : step s tx = some s')
    (p' : SealedFeedPacket) (h_post : s'.feedPackets pid = some p') :
    p.revealAfter = p'.revealAfter := by
  cases tx with
  -- ── Group A: doesn't touch `feedPackets` ────────────────────────────
  | TransferOwnership caller newOwner =>
      simp only [step] at h_step
      split at h_step <;> try (simp at h_step; done)
      split at h_step <;> try (simp at h_step; done)
      injection h_step with heq
      subst heq
      simp at h_post
      rw [h_pre] at h_post
      injection h_post with h_pp
      rw [h_pp]
  | AcceptOwnership caller =>
      simp only [step] at h_step
      split at h_step <;> try (simp at h_step; done)
      injection h_step with heq
      subst heq
      simp at h_post
      rw [h_pre] at h_post
      injection h_post with h_pp
      rw [h_pp]
  | SetRelayer caller relayer active =>
      simp only [step] at h_step
      split at h_step <;> try (simp at h_step; done)
      split at h_step <;> try (simp at h_step; done)
      injection h_step with heq
      subst heq
      simp at h_post
      rw [h_pre] at h_post
      injection h_post with h_pp
      rw [h_pp]
  | RegisterMarket caller marketId horizonSeconds active =>
      simp only [step] at h_step
      split at h_step <;> try (simp at h_step; done)
      split at h_step <;> try (simp at h_step; done)
      injection h_step with heq
      subst heq
      simp at h_post
      rw [h_pre] at h_post
      injection h_post with h_pp
      rw [h_pp]
  | RegisterFixedRevealMarket caller marketId revealAfter active now =>
      simp only [step] at h_step
      split at h_step <;> try (simp at h_step; done)
      split at h_step <;> try (simp at h_step; done)
      injection h_step with heq
      subst heq
      simp at h_post
      rw [h_pre] at h_post
      injection h_post with h_pp
      rw [h_pp]
  | SetMarketActive caller marketId active =>
      simp only [step] at h_step
      split at h_step <;> try (simp at h_step; done)
      split at h_step <;> try (simp at h_step; done)
      injection h_step with heq
      subst heq
      simp at h_post
      rw [h_pre] at h_post
      injection h_post with h_pp
      rw [h_pp]
  | SubmitSealedFor caller agent callId marketId binaryIndex confidenceBps now =>
      simp only [step] at h_step
      split at h_step <;> try (simp at h_step; done)
      split at h_step <;> try (simp at h_step; done)
      split at h_step <;> try (simp at h_step; done)
      split at h_step <;> try (simp at h_step; done)
      split at h_step <;> try (simp at h_step; done)
      split at h_step <;> try (simp at h_step; done)
      injection h_step with heq
      subst heq
      simp at h_post
      rw [h_pre] at h_post
      injection h_post with h_pp
      rw [h_pp]
  | OpenReveal _caller callId now =>
      simp only [step] at h_step
      split at h_step <;> try (simp at h_step; done)
      split at h_step <;> try (simp at h_step; done)
      split at h_step <;> try (simp at h_step; done)
      injection h_step with heq
      subst heq
      simp at h_post
      rw [h_pre] at h_post
      injection h_post with h_pp
      rw [h_pp]
  | PublishReveal _caller callId revealedBin revealedConf now =>
      simp only [step] at h_step
      split at h_step <;> try (simp at h_step; done)
      split at h_step <;> try (simp at h_step; done)
      injection h_step with heq
      subst heq
      simp at h_post
      rw [h_pre] at h_post
      injection h_post with h_pp
      rw [h_pp]
  -- ── Group B: writes only `state` (revealAfter preserved) ────────────
  | OpenFeedPacketReveal _caller packetId' now =>
      simp only [step] at h_step
      split at h_step <;> try (simp at h_step; done)
      rename_i p0 hpreq0
      split at h_step <;> try (simp at h_step; done)
      split at h_step <;> try (simp at h_step; done)
      injection h_step with heq
      subst heq
      simp at h_post
      by_cases h_eq : pid = packetId'
      · subst h_eq
        simp [updateMap_same_feedPackets_v2] at h_post
        rw [hpreq0] at h_pre
        injection h_pre with h_pp0
        subst h_pp0
        rw [← h_post]
      · rw [updateMap_other_feedPackets_v2 _ _ _ _ h_eq] at h_post
        rw [h_pre] at h_post
        injection h_post with h_pp
        rw [h_pp]
  | PublishFeedPacketReveal _caller packetId' revealedAction revealedSignal now =>
      simp only [step] at h_step
      split at h_step <;> try (simp at h_step; done)
      rename_i p0 hpreq0
      split at h_step <;> try (simp at h_step; done)
      injection h_step with heq
      subst heq
      simp at h_post
      by_cases h_eq : pid = packetId'
      · subst h_eq
        simp [updateMap_same_feedPackets_v2] at h_post
        rw [hpreq0] at h_pre
        injection h_pre with h_pp0
        subst h_pp0
        rw [← h_post]
      · rw [updateMap_other_feedPackets_v2 _ _ _ _ h_eq] at h_post
        rw [h_pre] at h_post
        injection h_post with h_pp
        rw [h_pp]
  -- ── Group C: writes the feedPackets map at a fresh slot ─────────────
  | SubmitFeedPacketFor caller agent packetId' feedId marketId revealAfter action signalBps now =>
      simp only [step] at h_step
      split at h_step <;> try (simp at h_step; done)
      split at h_step <;> try (simp at h_step; done)
      split at h_step <;> try (simp at h_step; done)
      split at h_step <;> try (simp at h_step; done)
      rename_i hpacket
      injection h_step with heq
      subst heq
      simp at h_post
      by_cases h_eq : pid = packetId'
      · subst h_eq
        rw [hpacket] at h_pre
        nomatch h_pre
      · rw [updateMap_other_feedPackets_v2 _ _ _ _ h_eq] at h_post
        rw [h_pre] at h_post
        injection h_post with h_pp
        rw [h_pp]

/-- Gating corollary. A successful `OpenFeedPacketReveal(packetId, now)`
    requires `now ≥ feedPackets[packetId].revealAfter`.

    Single-arm extraction: `step` on the `OpenFeedPacketReveal`
    constructor reverts (`= none`) when `now < p.revealAfter`. So
    `step ... = some s'` witnesses the negated strict inequality, which
    on `Nat` is exactly `now ≥ p.revealAfter`. -/
theorem feedRevealTimeGating
    (s s' : SealedVerdictsState) (caller : Address) (pid : Bytes32) (now : BlockTime)
    (h_step : step s (.OpenFeedPacketReveal caller pid now) = some s')
    (p : SealedFeedPacket) (h_pre : s.feedPackets pid = some p) :
    now ≥ p.revealAfter := by
  simp only [step, h_pre] at h_step
  -- Peel off the `p.state ≠ .Sealed → none` guard.
  split at h_step <;> try (simp at h_step; done)
  -- Survivor: `if now < p.revealAfter then none else some _`.
  split at h_step
  · -- `now < p.revealAfter` branch ⇒ `step = none`, contradicting h_step.
    simp at h_step
  · -- `¬ now < p.revealAfter` branch ⇒ `now ≥ p.revealAfter`.
    rename_i h_nlt
    cases BlockTimeMonotone p.revealAfter now with
    | inl h_order => exact h_order
    | inr h_order =>
        have h_le : p.revealAfter ≤ now := Nat.not_lt.mp h_nlt
        have h_eq : now = p.revealAfter := Nat.le_antisymm h_order h_le
        exact Nat.le_of_eq h_eq.symm

end MurmurFV.SealedVerdicts
