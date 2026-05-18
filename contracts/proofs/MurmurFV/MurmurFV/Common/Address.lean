namespace MurmurFV.Common

structure Address where
  raw : Nat
deriving DecidableEq, Repr

namespace Address

def zero : Address := ⟨0⟩

end Address

end MurmurFV.Common
