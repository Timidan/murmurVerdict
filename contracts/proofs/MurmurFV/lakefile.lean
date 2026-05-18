import Lake
open Lake DSL

package «MurmurFV» where
  -- Standard library (std4) is bundled into Lean since v4.7; no external require needed.
  leanOptions := #[
    ⟨`autoImplicit, false⟩,
    ⟨`relaxedAutoImplicit, false⟩
  ]

@[default_target]
lean_lib «MurmurFV» where
  -- Top-level library aggregates everything under MurmurFV/
  roots := #[`MurmurFV]
