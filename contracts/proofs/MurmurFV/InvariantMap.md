# Invariant map — theorem ↔ Solidity coverage

Each row maps a Lean theorem to the Solidity functions whose `step`
arm is closed by its case-bash, plus the single most critical Solidity
line that the proof rests on. Functions cover the externally-callable
state-mutating surface only — view-only externals (`getCall`,
`getFeedPacket`, `callRevealOpenAt`, `*Handle`) and `private` helpers
are not entry points and are excluded.

## Mapping

| Theorem | Lean file | Solidity functions whose `step` arm is closed | Critical Solidity line |
|---------|-----------|------------------------------------------------|------------------------|
| `MurmurFV.Escrow.fundsConservation` (E1) | `MurmurFV/Escrow/InvariantE1.lean:1050-1063` | All 12 `MurmurEscrow` externals: `createPipeline`, `setPipelineActive`, `requestInference`, `commitSignal`, `finalize`, `refund`, `cancel`, `submitMerkleRoot`, `setProtocolFeeBps`, `setProtocolFeeSink`, `setPaused`, `transferOwnership` | `MurmurEscrow.sol:294` — `if (!USDC.transfer(p.agentOwner, agentPayout)) revert UsdcReturnFailed();` — the second leg of `finalize` is the only place where escrow→agent payout occurs; combined with `fee + agentPayout = r.paidAmount` (sol:287-288) this gives the closed-form balance delta. |
| `MurmurFV.Escrow.singleCommit` (E2) | `MurmurFV/Escrow/InvariantE2.lean:348-383` | All 12 `MurmurEscrow` externals (same set; the propagation lemma `nonPending_propagates_with_no_commits` rules out a second commit) | `MurmurEscrow.sol:260` — `if (r.state != RequestState.Pending) revert WrongState();` — the only state-based gate ensuring a `commitSignal` cannot fire twice on the same `requestId`. |
| `MurmurFV.SealedVerdicts.handleImmutability` (V1) | `MurmurFV/SealedVerdicts/InvariantV1.lean:43-219` | All 12 `MurmurSealedVerdicts` externals: `transferOwnership`, `acceptOwnership`, `setRelayer`, `registerMarket`, `registerFixedRevealMarket`, `setMarketActive`, `submitSealedFor`, `openReveal`, `publishReveal`, `submitFeedPacketFor`, `openFeedPacketReveal`, `publishFeedPacketReveal` | `MurmurSealedVerdicts.sol:235` — `if (calls[callId].state != CallState.None) revert CallAlreadyExists();` — the one-shot guard ensuring `submitSealedFor` only writes the handle slot when it was previously empty. |
| `MurmurFV.SealedVerdicts.feedPacketHandleImmutability` (V1Feed) | `MurmurFV/SealedVerdicts/InvariantV1Feed.lean:41-217` | All 12 `MurmurSealedVerdicts` externals (same set) | `MurmurSealedVerdicts.sol:378` — `if (feedPackets[packetId].state != CallState.None) revert PacketAlreadyExists();` — the one-shot guard ensuring `submitFeedPacketFor` only writes the handle slot once. |
| `MurmurFV.SealedVerdicts.revealTimeGating` + `revealOpenAtImmutable` (V2) | `MurmurFV/SealedVerdicts/InvariantV2.lean:48-237` | Snapshot lemma covers all 12 externals; gating corollary peels the `openReveal` arm specifically | `MurmurSealedVerdicts.sol:275` — `if (block.timestamp < sealedCall.revealOpenAt) revert RevealWindowNotOpen();` — the single line that, combined with `revealOpenAt`'s write-once snapshot at sol:238-250, gates every successful `openReveal`. |
| `MurmurFV.SealedVerdicts.feedRevealTimeGating` + `feedRevealAfterImmutable` (V2Feed) | `MurmurFV/SealedVerdicts/InvariantV2Feed.lean:51-239` | Snapshot lemma covers all 12 externals; gating corollary peels the `openFeedPacketReveal` arm specifically | `MurmurSealedVerdicts.sol:416` — `if (block.timestamp < packet.revealAfter) revert RevealWindowNotOpen();` — the single line that, combined with `revealAfter`'s write-once snapshot at sol:386-396, gates every successful `openFeedPacketReveal`. |

E1 has an additional proof precondition: `fundsConservation` takes
`h_wf : WellFormed s₀` at
`MurmurFV/Escrow/InvariantE1.lean:1058`, and the predicate itself is
defined at `MurmurFV/Escrow/InvariantE1.lean:89-93`. See `Model.md` §
"Off-chain invariants assumed by the proofs" before treating the E1 row
as a deploy-time assurance claim.

## How a future auditor should use this map

For each invariant claim, the verification workflow is:

1. **Confirm the model matches the contract.** Open `Model.md` and
   cross-check the Lean state record + transition list against the
   Solidity source. The translation tables there enumerate every
   field and every external function with line ranges.
2. **Confirm the proof covers every entry point.** Open the Lean file
   listed above. Each invariant either:
   - case-bashes on all 12 `Transition` constructors directly (V1,
     V1Feed, V2's snapshot lemma, V2Feed's snapshot lemma), so a
     compile pass guarantees every external function's `step` arm is
     handled; or
   - is a single-step `step ... = some s'` extraction (V2's gating
     corollary, V2Feed's gating corollary), which only constrains the
     one arm that fires; or
   - is an induction over `Reachable` / `ReachableWF` that calls a
     per-step preservation lemma which itself case-bashes all 12
     (E1, E2).
3. **Confirm the critical-line citation is load-bearing.** Mutate
   exactly that line in the contract (e.g. change `!=` to `==`, drop
   the revert) and re-run `lake build`. The proof should break. If it
   compiles unchanged, the citation is mis-attributed and the proof
   covers a different invariant than claimed.
4. **Cross-reference axioms.** Run `grep -rn "^axiom "
   contracts/proofs/MurmurFV/MurmurFV/` — exactly 2 results
   (`NoDonation`, `BlockTimeMonotone`). Then run `#print axioms` on
   each headline theorem. `fundsConservation` consumes `NoDonation`;
   `revealTimeGating` and `feedRevealTimeGating` consume
   `BlockTimeMonotone`; the remaining headline theorems should not
   consume project-local axioms.
5. **Confirm scope.** This map covers the 6 invariants in scope per
   spec §4. Properties such as EVM-level reentrancy, FHE crypto
   soundness, gas/calldata bounds, MEV / front-running, and the
   `marketDataCutoff` field are explicitly NOT proven — see
   `README.md` § "What this does NOT prove".
