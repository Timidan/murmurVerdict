-- Abstract bytes32 type for Solidity slot values (call ids, market ids,
-- handle bytes, hashes). We treat them as opaque values with decidable
-- equality; nothing in the proofs ever inspects internal structure.

namespace MurmurFV.Common

structure Bytes32 where
  raw : Nat
deriving DecidableEq, Repr

namespace Bytes32

def zero : Bytes32 := ⟨0⟩

end Bytes32

end MurmurFV.Common
