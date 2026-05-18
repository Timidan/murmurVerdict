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

/-- `NoDonation` axiom stub. Tightened in Wave 7 (E1 proof).
    Documents the real-world assumption: no third party transfers USDC
    directly into the escrow contract outside `requestInference`. USDC
    has no transfer hooks, no rebase, no admin balance edits — grounded
    in real token behavior. -/
axiom NoDonation : True

end MurmurFV.Common
