import MurmurFV.SealedVerdicts.Transitions

namespace MurmurFV.SealedVerdicts

open MurmurFV.Common

/-! ## V1Feed — Feed-packet handle immutability

Once `SubmitFeedPacketFor` writes a SealedFeedPacket into
`feedPackets[packetId]`, the FHE handle fields `action` and `signalBps`
are never re-written by any subsequent transition.

Symmetric to V1 — only `SubmitFeedPacketFor` writes the handle slots,
and only when `s.feedPackets pid = none`. All other transitions either
write a different field, a different pid, or don't touch feedPackets. -/

/-- Local map-update helpers, mirrored from V1 since each invariant file
    is self-contained per directory convention. -/
@[simp] theorem updateMap_same_feedPackets {α : Type}
    (f : Bytes32 → Option α) (k : Bytes32) (v : Option α) :
    updateMap f k v k = v := by
  unfold updateMap
  simp

@[simp] theorem updateMap_other_feedPackets {α : Type}
    (f : Bytes32 → Option α) (k k' : Bytes32) (v : Option α) (hne : k' ≠ k) :
    updateMap f k v k' = f k' := by
  unfold updateMap
  rw [if_neg hne]

/-- V1Feed headline theorem. Single-step formulation: any transition that
    successfully fires preserves the (action, signalBps) handles on an
    existing feed packet.

    Strategy: per-constructor case-bash on `tx`. The 9 "doesn't touch
    feedPackets" constructors trivially give `s'.feedPackets = s.feedPackets`,
    so `p = p'`. `OpenFeedPacketReveal` / `PublishFeedPacketReveal` write a
    SealedFeedPacket that shares the same handle fields with the original.
    `SubmitFeedPacketFor` requires `s.feedPackets pid' = none`, which
    contradicts `h_pre` when `pid' = pid`. -/
theorem feedPacketHandleImmutability
    (s s' : SealedVerdictsState) (tx : Transition) (pid : Bytes32)
    (p : SealedFeedPacket) (h_pre : s.feedPackets pid = some p)
    (h_step : step s tx = some s')
    (p' : SealedFeedPacket) (h_post : s'.feedPackets pid = some p') :
    p.action = p'.action ∧ p.signalBps = p'.signalBps := by
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
      exact ⟨rfl, rfl⟩
  | AcceptOwnership caller =>
      simp only [step] at h_step
      split at h_step <;> try (simp at h_step; done)
      injection h_step with heq
      subst heq
      simp at h_post
      rw [h_pre] at h_post
      injection h_post with h_pp
      rw [h_pp]
      exact ⟨rfl, rfl⟩
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
      exact ⟨rfl, rfl⟩
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
      exact ⟨rfl, rfl⟩
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
      exact ⟨rfl, rfl⟩
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
      exact ⟨rfl, rfl⟩
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
      exact ⟨rfl, rfl⟩
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
      exact ⟨rfl, rfl⟩
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
      exact ⟨rfl, rfl⟩
  -- ── Group B: writes a different field of the same feed packet ───────
  | OpenFeedPacketReveal _caller packetId' now =>
      simp only [step] at h_step
      split at h_step <;> try (simp at h_step; done)
      rename_i p0 hpreq0
      split at h_step <;> try (simp at h_step; done)
      split at h_step <;> try (simp at h_step; done)
      injection h_step with heq
      subst heq
      -- h_post : (the new state).feedPackets pid = some p'
      simp at h_post
      by_cases h_eq : pid = packetId'
      · subst h_eq
        simp [updateMap_same_feedPackets] at h_post
        rw [hpreq0] at h_pre
        injection h_pre with h_pp0
        subst h_pp0
        rw [← h_post]
        exact ⟨rfl, rfl⟩
      · rw [updateMap_other_feedPackets _ _ _ _ h_eq] at h_post
        rw [h_pre] at h_post
        injection h_post with h_pp
        rw [h_pp]
        exact ⟨rfl, rfl⟩
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
        simp [updateMap_same_feedPackets] at h_post
        rw [hpreq0] at h_pre
        injection h_pre with h_pp0
        subst h_pp0
        rw [← h_post]
        exact ⟨rfl, rfl⟩
      · rw [updateMap_other_feedPackets _ _ _ _ h_eq] at h_post
        rw [h_pre] at h_post
        injection h_post with h_pp
        rw [h_pp]
        exact ⟨rfl, rfl⟩
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
      · rw [updateMap_other_feedPackets _ _ _ _ h_eq] at h_post
        rw [h_pre] at h_post
        injection h_post with h_pp
        rw [h_pp]
        exact ⟨rfl, rfl⟩

end MurmurFV.SealedVerdicts
