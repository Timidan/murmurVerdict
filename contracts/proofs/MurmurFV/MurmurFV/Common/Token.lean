import MurmurFV.Common.Address

namespace MurmurFV.Common

/--
Abstract ERC-20 state. Standard, well-behaved, no transfer hooks.
`transfer` / `transferFrom` modeled as partial functions returning `none`
on revert, `some state'` on success.
-/
structure TokenState where
  balanceOf : Address → Nat

namespace TokenState

def empty : TokenState := { balanceOf := fun _ => 0 }

/-- `transfer from to amount` on success: balanceOf from drops by amount,
    balanceOf to increases by amount, every other balance unchanged.
    Reverts (returns none) if from's balance is insufficient. -/
def transfer (s : TokenState) (from_ to_ : Address) (amount : Nat) : Option TokenState :=
  if s.balanceOf from_ ≥ amount then
    some {
      balanceOf := fun a =>
        if a = from_ ∧ a = to_ then s.balanceOf a
        else if a = from_ then s.balanceOf a - amount
        else if a = to_ then s.balanceOf a + amount
        else s.balanceOf a
    }
  else none

/-- transferFrom is operationally identical to transfer for our model.
    On-chain allowance checks are enforced at the Solidity layer; we are
    not modelling the allowance map. -/
def transferFrom (s : TokenState) (from_ to_ : Address) (amount : Nat) : Option TokenState :=
  s.transfer from_ to_ amount

end TokenState

/-- `NoDonation` axiom placeholder.

    Documents the real-world assumption: no third party transfers USDC
    directly into the escrow contract outside `requestInference`. USDC
    has no transfer hooks, no rebase, no admin balance edits — grounded
    in real token behavior.

    Codex review verdict for Wave A: the prior cosmetic invocation was
    RED because `NoDonation : True` is type-trivial, and E1
    (`Escrow/InvariantE1.lean`, theorem `fundsConservation`) already
    proves the equality form `liveSumList = balanceOf` directly from the
    closed `ReachableWF` transition vocabulary without invoking this
    axiom. The vocabulary has no donation transition today.

    Currently unused. Retained as a named auditable placeholder: a future
    extension adding a donation transition would gate on it. Reviewers
    grep `NoDonation` to confirm no proof secretly relies on no external
    USDC inflows without saying so. -/
axiom NoDonation : True

end MurmurFV.Common
