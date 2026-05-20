namespace MurmurFV.Common

/-- `block.timestamp` modeled as a free Nat per transition. -/
abbrev BlockTime : Type := Nat

/-- Monotonicity axiom. Invoked by the V2/V2Feed reveal-gating
    corollaries when converting a successful `now < reveal...` guard
    rejection into the ordered `now ≥ reveal...` conclusion. -/
axiom BlockTimeMonotone : ∀ (t₁ t₂ : BlockTime), t₁ ≤ t₂ ∨ t₂ ≤ t₁

end MurmurFV.Common
