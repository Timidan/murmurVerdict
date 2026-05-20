namespace MurmurFV.Common

/-- `block.timestamp` modeled as a free Nat per transition. -/
abbrev BlockTime : Type := Nat

/-- `BlockTimeMonotone` axiom placeholder.

    Codex review verdict for Wave A: the prior cosmetic invocation was
    RED because the V2/V2Feed reveal-gating corollaries compile without
    this axiom. The ordering corollary is dischargeable from
    `Nat.not_lt.mp` today, so the axiom is cosmetic.

    Currently unused. Retained as an audit hook: a future extension
    threading a global clock across transitions would need to encode
    monotonicity explicitly. -/
axiom BlockTimeMonotone : ∀ (t₁ t₂ : BlockTime), t₁ ≤ t₂ ∨ t₂ ≤ t₁

end MurmurFV.Common
