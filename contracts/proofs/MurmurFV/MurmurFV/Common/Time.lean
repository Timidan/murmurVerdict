namespace MurmurFV.Common

/-- `block.timestamp` modeled as a free Nat per transition. -/
abbrev BlockTime : Type := Nat

/-- Monotonicity axiom. Invoked by proofs over traces (currently only
    E2). `Nat ≤ Nat ∨ Nat ≤ Nat` is trivially true; this exists as a
    named invocation site for auditability. -/
axiom BlockTimeMonotone : ∀ (t₁ t₂ : BlockTime), t₁ ≤ t₂ ∨ t₂ ≤ t₁

end MurmurFV.Common
