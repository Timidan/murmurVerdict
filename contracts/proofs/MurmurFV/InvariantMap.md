# Invariant map — theorem ↔ Solidity coverage

Each row maps a Lean theorem to the Solidity functions whose `step`
arm is closed by its case-bash, plus the single most critical Solidity
line mirrored by the handwritten model. This is a review map, not a
mechanical Solidity-to-Lean linkage: changing Solidity alone cannot make
`lake build` fail. Functions cover the externally-callable
state-mutating surface only — view-only externals (`getCall`,
`getFeedPacket`, `callRevealOpenAt`, `*Handle`) and `private` helpers
are not entry points and are excluded.

## Mapping

| Theorem | Lean file | Solidity functions whose `step` arm is closed | Critical Solidity line |
|---------|-----------|------------------------------------------------|------------------------|
| `MurmurFV.Escrow.fundsConservation` (E1) | `MurmurFV/Escrow/InvariantE1.lean` (`reachableWF_preserves_E1Inv` + `fundsConservation` headline) | All 21 `MurmurEscrow` externals (Wave K added `forceRefundCommitted`; Wave L.B added `requestInferenceFor` + 7 allowlist admin): `createPipeline`, `setPipelineActive`, `requestInference`, `commitSignal`, `finalize`, `refund`, `cancel`, `forceRefundCommitted`, `submitMerkleRoot`, `setProtocolFeeBps`, `setProtocolFeeSink`, `setPaused`, `transferOwnership`, `requestInferenceFor`, `proposeAllowlistAdd`, `commitAllowlistAdd`, `proposeAllowlistRemove`, `commitAllowlistRemove`, `pauseAllowlistEntry`, `proposeAllowlistUnpause`, `commitAllowlistUnpause` | `MurmurEscrow.sol:330` — `if (!USDC.transfer(p.agentOwner, agentPayout)) revert UsdcReturnFailed();` — the second leg of `finalize` is the only place where escrow→agent payout occurs; combined with snapshotted fee arithmetic (`r.protocolFeeBps`) this gives the closed-form balance delta. The 7 Wave L.B allowlist admin arms don't touch `requests` or `token`, so they close via `E1Inv_carry_no_mutation`. |
| `MurmurFV.Escrow.singleCommit` (E2) | `MurmurFV/Escrow/InvariantE2.lean` (`singleCommit` headline; case-bashes 21 arms) | All 21 `MurmurEscrow` externals (same set; `forceRefundCommitted` moves `Committed → Refunded`; `requestInferenceFor` writes a fresh `Pending` rid that by `s.requests rid = none` precondition cannot collide with any existing non-`Pending` rid; allowlist admin doesn't touch `requests`) | `MurmurEscrow.sol:295` — `if (r.state != RequestState.Pending) revert WrongState();` — the only state-based gate ensuring a `commitSignal` cannot fire twice on the same `requestId`. |
| `MurmurFV.SealedVerdicts.handleImmutability` (V1) | `MurmurFV/SealedVerdicts/InvariantV1.lean:43-219` | All 12 `MurmurSealedVerdicts` externals: `transferOwnership`, `acceptOwnership`, `setRelayer`, `registerMarket`, `registerFixedRevealMarket`, `setMarketActive`, `submitSealedFor`, `openReveal`, `publishReveal`, `submitFeedPacketFor`, `openFeedPacketReveal`, `publishFeedPacketReveal` | `MurmurSealedVerdicts.sol:235` — `if (calls[callId].state != CallState.None) revert CallAlreadyExists();` — the one-shot guard ensuring `submitSealedFor` only writes the handle slot when it was previously empty. |
| `MurmurFV.SealedVerdicts.feedPacketHandleImmutability` (V1Feed) | `MurmurFV/SealedVerdicts/InvariantV1Feed.lean:41-217` | All 12 `MurmurSealedVerdicts` externals (same set) | `MurmurSealedVerdicts.sol:378` — `if (feedPackets[packetId].state != CallState.None) revert PacketAlreadyExists();` — the one-shot guard ensuring `submitFeedPacketFor` only writes the handle slot once. |
| `MurmurFV.SealedVerdicts.revealTimeGating` + `revealOpenAtImmutable` (V2) | `MurmurFV/SealedVerdicts/InvariantV2.lean:48-232` | Snapshot lemma covers all 12 externals; gating corollary peels the `openReveal` arm specifically | `MurmurSealedVerdicts.sol:275` — `if (block.timestamp < sealedCall.revealOpenAt) revert RevealWindowNotOpen();` — the single line that, combined with `revealOpenAt`'s write-once snapshot at sol:238-250, gates every successful `openReveal`. |
| `MurmurFV.SealedVerdicts.feedRevealTimeGating` + `feedRevealAfterImmutable` (V2Feed) | `MurmurFV/SealedVerdicts/InvariantV2Feed.lean:51-234` | Snapshot lemma covers all 12 externals; gating corollary peels the `openFeedPacketReveal` arm specifically | `MurmurSealedVerdicts.sol:416` — `if (block.timestamp < packet.revealAfter) revert RevealWindowNotOpen();` — the single line that, combined with `revealAfter`'s write-once snapshot at sol:386-396, gates every successful `openFeedPacketReveal`. |

E1 has an additional proof precondition: `fundsConservation` takes
`h_wf : WellFormed s₀` at
`MurmurFV/Escrow/InvariantE1.lean:1291`, and the predicate itself is
defined at `MurmurFV/Escrow/InvariantE1.lean:91-96`. See `Model.md` §
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
     per-step preservation lemma which itself case-bashes all 21
     escrow constructors (E1, E2).
3. **Confirm the critical-line citation is load-bearing in the model.**
   Compare the cited Solidity line to its corresponding `step` guard or
   update, then mutate that Lean transition (e.g. invert the guard or
   remove the state update) and re-run `lake build`. A Solidity-only
   mutation will not affect this handwritten Lean project; reviewers must
   re-check and update the translation whenever Solidity changes.
4. **Cross-reference axioms.** Run `grep -rn "^axiom "
   contracts/proofs/MurmurFV/MurmurFV/` — exactly 2 declarations
   (`NoDonation`, `BlockTimeMonotone`). They are currently unused
   placeholders; see `MurmurFV/Common/Token.lean` and
   `MurmurFV/Common/Time.lean` docstrings for the Codex review verdict.
   Then run `#print axioms` on each headline theorem. The E1, V2, and
   V2Feed headline theorems should report only Lean core axioms
   (`propext`, `Classical.choice`, `Quot.sound`), not the project-local
   placeholders.
5. **Confirm scope.** This map covers the 6 invariants in scope per
   spec §4. Properties such as EVM-level reentrancy, FHE crypto
   soundness, gas/calldata bounds, MEV / front-running, and the
   `marketDataCutoff` field are explicitly NOT proven — see
   `README.md` § "What this does NOT prove".

## Known abstraction gap

`MurmurEscrow.requestCount` and its increment are not represented in the
Lean escrow state. The model instead accepts `requestId` directly and requires
that slot to be empty. Consequently, repeated Solidity requests with the same
buyer/pipeline/client nonce but successive counters are distinct reachable
requests on-chain, while the abstraction cannot express that derivation. The
six current invariants do not depend on the counter formula, but the model
under-approximates request-creation traces and must not be cited as a proof of
request-ID derivation or counter behavior.
