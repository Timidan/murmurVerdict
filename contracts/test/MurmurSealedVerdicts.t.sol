// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.25;

import {Test} from "forge-std/Test.sol";
import {CofheClient} from "@cofhe/foundry-plugin/contracts/CofheClient.sol";
import {
    externalEuint8,
    externalEuint16,
    TASK_MANAGER_ADDRESS
} from "@fhenixprotocol/cofhe-contracts/FHE.sol";
import {UnsignedEncryptedInput, Utils} from "@fhenixprotocol/cofhe-contracts/ICofhe.sol";
import {MockACL} from "@cofhe/mock-contracts/contracts/MockACL.sol";
import {
    ZK_VERIFIER_SIGNER_ADDRESS,
    DECRYPT_RESULT_SIGNER_ADDRESS
} from "@cofhe/mock-contracts/contracts/MockCoFHE.sol";
import {MockTaskManager} from "@cofhe/mock-contracts/contracts/MockTaskManager.sol";
import {MockThresholdNetwork} from "@cofhe/mock-contracts/contracts/MockThresholdNetwork.sol";
import {
    MockThresholdNetworkSigner
} from "@cofhe/foundry-plugin/contracts/MockThresholdNetworkSigner.sol";
import {MockZkVerifier} from "@cofhe/mock-contracts/contracts/MockZkVerifier.sol";
import {MockZkVerifierSigner} from "@cofhe/foundry-plugin/contracts/MockZkVerifierSigner.sol";
import {MurmurSealedVerdicts} from "../src/MurmurSealedVerdicts.sol";

contract MurmurSealedVerdictsTest is Test {
    MurmurSealedVerdicts internal sealedVerdicts;
    CofheClient internal agentClient;
    CofheClient internal relayerClient;
    MockTaskManager internal mockTaskManager;
    MockACL internal mockAcl;
    MockZkVerifier internal mockZkVerifier;
    MockZkVerifierSigner internal mockZkVerifierSigner;

    address internal constant ZK_VERIFIER_ADDRESS = 0x0000000000000000000000000000000000005001;
    address internal constant THRESHOLD_NETWORK_ADDRESS =
        0x0000000000000000000000000000000000005002;
    address internal constant TM_ADMIN = address(128);

    uint256 internal constant AGENT_KEY = 0xA6E47;
    uint256 internal constant RELAYER_KEY = 0xBEEF;
    uint64 internal constant SCHEDULE_BASE = 1_000_000;
    uint64 internal constant ARM_CLOSE_AT = SCHEDULE_BASE + 60;
    uint64 internal constant SUBMISSION_OPEN_AT = SCHEDULE_BASE + 120;
    uint64 internal constant EARLY_ACCESS_CUTOFF_AT = SCHEDULE_BASE + 600;
    uint64 internal constant SUBMISSION_CLOSE_AT = SCHEDULE_BASE + 900;
    uint64 internal constant RESOLUTION_AT = SCHEDULE_BASE + 1200;
    uint64 internal constant PUBLIC_REVEAL_AT = SCHEDULE_BASE + 1800;

    bytes32 internal constant MARKET_ID = keccak256("eth.1h");
    bytes32 internal constant FIXED_REVEAL_MARKET_ID = keccak256("polymarket:absolute");
    bytes32 internal constant FEED_ID = keccak256("polymarket-brazil-election");
    bytes32 internal constant CLIENT_NONCE = keccak256("order-001");
    bytes32 internal constant PACKET_NONCE = keccak256("packet-001");
    bytes32 internal constant INVALID_CONFIDENCE_NONCE = keccak256("order-invalid-confidence");
    bytes32 internal constant INVALID_BINARY_NONCE = keccak256("order-invalid-binary");
    bytes32 internal constant INVALID_PACKET_NONCE = keccak256("packet-invalid-signal");

    function setUp() public {
        _deployMocks();
        agentClient = new CofheClient();
        agentClient.connect(AGENT_KEY);
        relayerClient = new CofheClient();
        relayerClient.connect(RELAYER_KEY);
        sealedVerdicts = new MurmurSealedVerdicts();

        // Anchor the schedule to a fixed base so every instant is nameable.
        // Registration must land strictly before armCloseAt.
        vm.warp(SCHEDULE_BASE);
        sealedVerdicts.registerMarket(MARKET_ID, _schedule());

        // Most tests submit immediately, so open the submission window.
        vm.warp(SUBMISSION_OPEN_AT);
    }

    /// @dev The canonical test schedule, strictly ordered:
    ///   base  +60 armClose  +120 submissionOpen  +600 earlyAccessCutoff
    ///         +900 submissionClose  +1200 resolution  +1800 publicReveal
    function _schedule() internal pure returns (MurmurSealedVerdicts.Market memory) {
        return MurmurSealedVerdicts.Market({
            armCloseAt: ARM_CLOSE_AT,
            submissionOpenAt: SUBMISSION_OPEN_AT,
            earlyAccessCutoffAt: EARLY_ACCESS_CUTOFF_AT,
            submissionCloseAt: SUBMISSION_CLOSE_AT,
            resolutionAt: RESOLUTION_AT,
            publicRevealAt: PUBLIC_REVEAL_AT,
            active: true
        });
    }

    function test_transferOwnershipIsTwoStepAndRejectsZeroOwner() public {
        address nextOwner = address(0xBEEF);

        vm.expectRevert(MurmurSealedVerdicts.ZeroOwner.selector);
        sealedVerdicts.transferOwnership(address(0));

        sealedVerdicts.transferOwnership(nextOwner);
        assertEq(sealedVerdicts.owner(), address(this));
        assertEq(sealedVerdicts.pendingOwner(), nextOwner);

        vm.expectRevert(MurmurSealedVerdicts.NotPendingOwner.selector);
        sealedVerdicts.acceptOwnership();

        vm.prank(nextOwner);
        sealedVerdicts.acceptOwnership();
        assertEq(sealedVerdicts.owner(), nextOwner);
        assertEq(sealedVerdicts.pendingOwner(), address(0));
    }

    function test_ownerCanSetRelayer() public {
        address relayer = relayerClient.account();

        vm.prank(agentClient.account());
        vm.expectRevert(MurmurSealedVerdicts.NotOwner.selector);
        sealedVerdicts.setRelayer(relayer, true);

        vm.expectRevert(MurmurSealedVerdicts.ZeroRelayer.selector);
        sealedVerdicts.setRelayer(address(0), true);

        sealedVerdicts.setRelayer(relayer, true);
        assertTrue(sealedVerdicts.relayers(relayer));

        sealedVerdicts.setRelayer(relayer, false);
        assertFalse(sealedVerdicts.relayers(relayer));
    }

    // ─── Flow 2 — paid private decrypt-grant (grant-only v1) ────────────────

    address internal constant GRANTOR = address(0x6EA47);
    address internal constant SUBSCRIBER = address(0x50B);
    address internal constant OTHER = address(0x07E5);

    function test_setGrantorIsOwnerGatedAndRejectsZero() public {
        vm.prank(agentClient.account());
        vm.expectRevert(MurmurSealedVerdicts.NotOwner.selector);
        sealedVerdicts.setGrantor(GRANTOR, true);

        vm.expectRevert(MurmurSealedVerdicts.ZeroGrantor.selector);
        sealedVerdicts.setGrantor(address(0), true);

        sealedVerdicts.setGrantor(GRANTOR, true);
        assertTrue(sealedVerdicts.grantors(GRANTOR));
        sealedVerdicts.setGrantor(GRANTOR, false);
        assertFalse(sealedVerdicts.grantors(GRANTOR));
    }

    function test_grantDecryptAccessAllowsSubscriberAndPersistsAfterReveal() public {
        bytes32 callId = _submitBuy72();
        sealedVerdicts.setGrantor(GRANTOR, true);

        uint256 binaryHandle = uint256(sealedVerdicts.binaryIndexHandle(callId));
        uint256 confidenceHandle = uint256(sealedVerdicts.confidenceHandle(callId));

        // Pre-grant: the subscriber holds no per-address ACL entry.
        assertFalse(mockAcl.persistAllowed(binaryHandle, SUBSCRIBER));
        assertFalse(mockAcl.persistAllowed(confidenceHandle, SUBSCRIBER));

        vm.expectEmit(true, true, false, false, address(sealedVerdicts));
        emit MurmurSealedVerdicts.DecryptAccessGranted(callId, SUBSCRIBER);
        vm.prank(GRANTOR);
        sealedVerdicts.grantDecryptAccess(callId, SUBSCRIBER);

        assertTrue(sealedVerdicts.decryptAccessGranted(callId, SUBSCRIBER));
        assertTrue(mockAcl.persistAllowed(binaryHandle, SUBSCRIBER));
        assertTrue(mockAcl.persistAllowed(confidenceHandle, SUBSCRIBER));

        (
            MurmurSealedVerdicts.CallState state,
            uint64 grantCloseAt,
            bytes32 binaryCt,
            bytes32 confidenceCt,
            bool alreadyGranted
        ) = sealedVerdicts.getDecryptAccess(callId, SUBSCRIBER);
        assertEq(uint8(state), uint8(MurmurSealedVerdicts.CallState.Sealed));
        // The subscriber view returns the GRANT deadline, not the public
        // reveal time. It answers "can I still buy?", and buying closes when
        // the prediction window opens — returning publicRevealAt here let the
        // payment gate settle money for access the contract would reject.
        assertEq(grantCloseAt, SUBMISSION_CLOSE_AT);
        assertTrue(grantCloseAt < sealedVerdicts.callPublicRevealAt(callId));
        assertEq(uint256(binaryCt), binaryHandle);
        assertEq(uint256(confidenceCt), confidenceHandle);
        assertTrue(alreadyGranted);

        // The persistent grant survives the call's later public reveal — the
        // subscriber's earlier per-address permission is not revoked by the
        // global allowPublic added at openReveal.
        vm.warp(PUBLIC_REVEAL_AT);
        sealedVerdicts.openReveal(callId);
        assertTrue(mockAcl.persistAllowed(binaryHandle, SUBSCRIBER));
        assertTrue(mockAcl.persistAllowed(confidenceHandle, SUBSCRIBER));
    }

    function test_grantDecryptAccessDeniesUnrelatedHandlesAndOtherCalls() public {
        bytes32 callA = _submitVerdict(0, 7200, keccak256("grant-call-a"));
        bytes32 callB = _submitVerdict(1, 6000, keccak256("grant-call-b"));
        sealedVerdicts.setGrantor(GRANTOR, true);

        vm.prank(GRANTOR);
        sealedVerdicts.grantDecryptAccess(callA, SUBSCRIBER);

        // Granted only on call A's two handles, for the subscriber only.
        assertTrue(mockAcl.persistAllowed(uint256(sealedVerdicts.binaryIndexHandle(callA)), SUBSCRIBER));
        assertFalse(mockAcl.persistAllowed(uint256(sealedVerdicts.binaryIndexHandle(callA)), OTHER));
        // Unrelated call B's handles stay closed to the subscriber.
        assertFalse(mockAcl.persistAllowed(uint256(sealedVerdicts.binaryIndexHandle(callB)), SUBSCRIBER));
        assertFalse(mockAcl.persistAllowed(uint256(sealedVerdicts.confidenceHandle(callB)), SUBSCRIBER));

        (,,,, bool grantedOnB) = sealedVerdicts.getDecryptAccess(callB, SUBSCRIBER);
        assertFalse(grantedOnB);
    }

    function test_grantDecryptAccessRevertsAfterRevealOpenAtWhileSealed() public {
        bytes32 callId = _submitBuy72();
        sealedVerdicts.setGrantor(GRANTOR, true);

        // The sale window closes at submissionCloseAt even before anyone calls
        // openReveal; the reveal worker's grace period does not extend it.
        vm.warp(SUBMISSION_CLOSE_AT);
        vm.prank(GRANTOR);
        vm.expectRevert(MurmurSealedVerdicts.DecryptGrantWindowClosed.selector);
        sealedVerdicts.grantDecryptAccess(callId, SUBSCRIBER);
    }

    function test_grantDecryptAccessRevertsOnceRevealOpened() public {
        bytes32 callId = _submitBuy72();
        sealedVerdicts.setGrantor(GRANTOR, true);

        vm.warp(PUBLIC_REVEAL_AT);
        sealedVerdicts.openReveal(callId);

        vm.prank(GRANTOR);
        vm.expectRevert(MurmurSealedVerdicts.DecryptGrantWindowClosed.selector);
        sealedVerdicts.grantDecryptAccess(callId, SUBSCRIBER);
    }

    function test_grantDecryptAccessIsIdempotent() public {
        bytes32 callId = _submitBuy72();
        sealedVerdicts.setGrantor(GRANTOR, true);

        vm.startPrank(GRANTOR);
        sealedVerdicts.grantDecryptAccess(callId, SUBSCRIBER);
        // Second grant is a no-op that must not revert.
        sealedVerdicts.grantDecryptAccess(callId, SUBSCRIBER);
        vm.stopPrank();

        assertTrue(sealedVerdicts.decryptAccessGranted(callId, SUBSCRIBER));
    }

    function test_grantDecryptAccessOnlyGrantor() public {
        bytes32 callId = _submitBuy72();

        vm.prank(OTHER);
        vm.expectRevert(MurmurSealedVerdicts.NotGrantor.selector);
        sealedVerdicts.grantDecryptAccess(callId, SUBSCRIBER);
    }

    function test_grantDecryptAccessRejectsZeroSubscriberAndUnknownCall() public {
        bytes32 callId = _submitBuy72();
        sealedVerdicts.setGrantor(GRANTOR, true);

        vm.prank(GRANTOR);
        vm.expectRevert(MurmurSealedVerdicts.ZeroSubscriber.selector);
        sealedVerdicts.grantDecryptAccess(callId, address(0));

        vm.prank(GRANTOR);
        vm.expectRevert(MurmurSealedVerdicts.CallNotFound.selector);
        sealedVerdicts.grantDecryptAccess(keccak256("missing-call"), SUBSCRIBER);
    }

    function test_submitSealedForStoresEncryptedVerdictUntilReveal() public {
        bytes32 callId = _submitBuy72();

        (
            address agent,
            bytes32 marketId,
            uint64 acceptedAt,
            bytes32 binaryIndexCtHash,
            bytes32 confidenceCtHash,
            uint8 revealedBinaryIndex,
            uint16 revealedConfidenceBps,
            MurmurSealedVerdicts.CallState state
        ) = sealedVerdicts.getCall(callId);

        assertEq(agent, agentClient.account());
        assertEq(marketId, MARKET_ID);
        assertEq(acceptedAt, uint64(block.timestamp));
        assertEq(uint8(state), uint8(MurmurSealedVerdicts.CallState.Sealed));
        assertEq(revealedBinaryIndex, 0);
        assertEq(revealedConfidenceBps, 0);
        expectPlaintext(binaryIndexCtHash, 0);
        expectPlaintext(confidenceCtHash, 7200);
    }

    function test_submitSealedForStoresAgentWhileRelayerPaysGas() public {
        address expectedAgent = agentClient.account();
        address relayer = relayerClient.account();
        sealedVerdicts.setRelayer(relayer, true);

        (externalEuint8 binaryIndex, externalEuint16 confidence, bytes memory inputProof) =
            _sealedPair(relayer, 0, 7200);
        bytes32 nonce = keccak256("relayed-order-001");

        vm.prank(relayer);
        bytes32 callId = sealedVerdicts.submitSealedFor(
            expectedAgent, MARKET_ID, binaryIndex, confidence, inputProof, nonce
        );
        bytes32 expectedCallId = keccak256(
            abi.encodePacked(
                block.chainid, address(sealedVerdicts), expectedAgent, MARKET_ID, nonce
            )
        );
        assertEq(callId, expectedCallId);

        (
            address submittedAgent,
            bytes32 marketId,
            uint64 acceptedAt,
            bytes32 binaryIndexCtHash,
            bytes32 confidenceCtHash,
            ,
            ,
            MurmurSealedVerdicts.CallState state
        ) = sealedVerdicts.getCall(callId);

        assertEq(submittedAgent, expectedAgent);
        assertEq(marketId, MARKET_ID);
        assertEq(acceptedAt, uint64(block.timestamp));
        assertEq(uint8(state), uint8(MurmurSealedVerdicts.CallState.Sealed));
        expectPlaintext(binaryIndexCtHash, 0);
        expectPlaintext(confidenceCtHash, 7200);
    }

    function test_submitSealedForRejectsNonRelayerAndZeroAgent() public {
        address expectedAgent = agentClient.account();
        address relayer = relayerClient.account();
        (externalEuint8 binaryIndex, externalEuint16 confidence, bytes memory inputProof) =
            _sealedPair(relayer, 0, 7200);

        vm.prank(relayer);
        vm.expectRevert(MurmurSealedVerdicts.NotRelayer.selector);
        sealedVerdicts.submitSealedFor(
            expectedAgent, MARKET_ID, binaryIndex, confidence, inputProof, keccak256("non-relayer")
        );

        sealedVerdicts.setRelayer(relayer, true);
        vm.prank(relayer);
        vm.expectRevert(MurmurSealedVerdicts.ZeroAgent.selector);
        sealedVerdicts.submitSealedFor(
            address(0), MARKET_ID, binaryIndex, confidence, inputProof, keccak256("zero-agent")
        );
    }

    function test_revealRequiresHorizon() public {
        bytes32 callId = _submitBuy72();

        vm.expectRevert(MurmurSealedVerdicts.RevealWindowNotOpen.selector);
        sealedVerdicts.openReveal(callId);
    }

    /// Each market carries its own schedule, and a call snapshots the market's
    /// publicRevealAt at submit so a second market's timing never bleeds into
    /// the first's calls.
    function test_marketCarriesItsOwnScheduleAndCallSnapshotsIt() public {
        uint64 base = SCHEDULE_BASE + 10_000;
        MurmurSealedVerdicts.Market memory other = MurmurSealedVerdicts.Market({
            armCloseAt: base + 60,
            submissionOpenAt: base + 120,
            earlyAccessCutoffAt: base + 600,
            submissionCloseAt: base + 900,
            resolutionAt: base + 1200,
            publicRevealAt: base + 1800,
            active: true
        });
        sealedVerdicts.registerMarket(FIXED_REVEAL_MARKET_ID, other);

        address relayer = relayerClient.account();
        sealedVerdicts.setRelayer(relayer, true);
        (externalEuint8 binaryIndex, externalEuint16 confidence, bytes memory inputProof) =
            _sealedPair(relayer, 0, 7200);
        address agent = agentClient.account();

        vm.warp(other.submissionOpenAt);
        vm.prank(relayer);
        bytes32 callId = sealedVerdicts.submitSealedFor(
            agent,
            FIXED_REVEAL_MARKET_ID,
            binaryIndex,
            confidence,
            inputProof,
            keccak256("second-market-order")
        );

        assertEq(sealedVerdicts.callPublicRevealAt(callId), other.publicRevealAt);

        vm.warp(other.publicRevealAt - 1);
        vm.expectRevert(MurmurSealedVerdicts.RevealWindowNotOpen.selector);
        sealedVerdicts.openReveal(callId);

        vm.warp(other.publicRevealAt);
        sealedVerdicts.openReveal(callId);
    }

    /// Measures the gas of ONE grantDecryptAccess.
    ///
    /// Deliberately does NOT claim a supported "cohort size". There is no
    /// batch-grant entrypoint: each subscriber is granted in its own
    /// transaction, so dividing a block budget by this number would describe a
    /// transaction that does not exist. That derivation was wrong and is gone.
    ///
    /// What this number IS good for: sizing the grantor EOA's funding, since
    /// selling N accesses costs N transactions at roughly this gas each.
    ///
    /// Runs against the CoFHE mock; Fhenix documents that mock gas differs
    /// from production, so treat it as an order of magnitude, not a quote.
    function test_measureGrantGasPerSubscriber() public {
        bytes32 callId = _submitBuy72();
        sealedVerdicts.setGrantor(GRANTOR, true);

        uint256 total = 0;
        uint256 samples = 5;
        for (uint256 i = 0; i < samples; i++) {
            address sub = address(uint160(0x50B0 + i));
            vm.prank(GRANTOR);
            uint256 before = gasleft();
            sealedVerdicts.grantDecryptAccess(callId, sub);
            total += before - gasleft();
        }
        uint256 perSubscriber = total / samples;
        emit log_named_uint("grant gas per subscriber (one tx each)", perSubscriber);

        assertGt(perSubscriber, 0, "grant must consume gas");
        // One grant is one transaction, so it must sit comfortably inside a
        // single block regardless of how many subscribers a call has.
        assertLt(perSubscriber, 500_000, "a single grant must stay well inside one block");
    }

    /// Registration is one-shot: re-registering must revert rather than
    /// silently retime a market that consumers may already have armed against.
    function test_registerMarketIsOneShot() public {
        vm.expectRevert(MurmurSealedVerdicts.MarketAlreadyRegistered.selector);
        sealedVerdicts.registerMarket(MARKET_ID, _schedule());
    }

    /// Every adjacent pair must be strictly ordered; equality collapses a
    /// window to zero length.
    function test_registerMarketRejectsNonStrictSchedule() public {
        uint64 base = SCHEDULE_BASE + 20_000;
        MurmurSealedVerdicts.Market memory bad = MurmurSealedVerdicts.Market({
            armCloseAt: base + 60,
            submissionOpenAt: base + 120,
            // Zero-length sellable window: nothing can be submitted AND sold.
            earlyAccessCutoffAt: base + 120,
            submissionCloseAt: base + 900,
            resolutionAt: base + 1200,
            publicRevealAt: base + 1800,
            active: true
        });
        vm.expectRevert(MurmurSealedVerdicts.ScheduleNotStrictlyOrdered.selector);
        sealedVerdicts.registerMarket(keccak256("bad-schedule"), bad);
    }

    /// The submission window is half-open: [submissionOpenAt, submissionCloseAt).
    /// Rejecting at exactly submissionCloseAt matters because that instant is
    /// when the prediction window opens and the reference price may already be
    /// observable — a "prediction" made there is not one.
    function test_submissionWindowIsHalfOpen() public {
        address relayer = relayerClient.account();
        sealedVerdicts.setRelayer(relayer, true);
        address agent = agentClient.account();

        vm.warp(SUBMISSION_OPEN_AT - 1);
        (externalEuint8 b1, externalEuint16 c1, bytes memory p1) = _sealedPair(relayer, 0, 7200);
        vm.prank(relayer);
        vm.expectRevert(MurmurSealedVerdicts.SubmissionWindowNotOpen.selector);
        sealedVerdicts.submitSealedFor(agent, MARKET_ID, b1, c1, p1, keccak256("too-early"));

        vm.warp(SUBMISSION_CLOSE_AT);
        (externalEuint8 b2, externalEuint16 c2, bytes memory p2) = _sealedPair(relayer, 0, 7200);
        vm.prank(relayer);
        vm.expectRevert(MurmurSealedVerdicts.SubmissionWindowClosed.selector);
        sealedVerdicts.submitSealedFor(agent, MARKET_ID, b2, c2, p2, keccak256("too-late"));
    }

    /// Calls submitted after the early-access cutoff are refereed and scored
    /// but can never be sold — granting one must revert.
    function test_lateSubmissionIsUnsellable() public {
        address relayer = relayerClient.account();
        sealedVerdicts.setRelayer(relayer, true);
        sealedVerdicts.setGrantor(address(this), true);
        address agent = agentClient.account();

        vm.warp(EARLY_ACCESS_CUTOFF_AT);
        (externalEuint8 b, externalEuint16 c, bytes memory p) = _sealedPair(relayer, 0, 7200);
        vm.prank(relayer);
        bytes32 callId =
            sealedVerdicts.submitSealedFor(agent, MARKET_ID, b, c, p, keccak256("late-call"));

        assertEq(
            uint8(sealedVerdicts.callSubmissionClass(callId)),
            uint8(MurmurSealedVerdicts.SubmissionClass.LateUnsellable)
        );

        vm.expectRevert(MurmurSealedVerdicts.CallNotSellable.selector);
        sealedVerdicts.grantDecryptAccess(callId, SUBSCRIBER);
    }

    function test_openAndPublishReveal() public {
        bytes32 callId = _submitBuy72();
        vm.warp(PUBLIC_REVEAL_AT);

        sealedVerdicts.openReveal(callId);
        bytes32 binaryIndexHandle = sealedVerdicts.binaryIndexHandle(callId);
        bytes32 confidenceHandle = sealedVerdicts.confidenceHandle(callId);

        (, uint256 binaryIndexPlain, bytes memory binaryIndexSig) =
            agentClient.decryptForTx_withoutACP(binaryIndexHandle);
        (, uint256 confidencePlain, bytes memory confidenceSig) =
            agentClient.decryptForTx_withoutACP(confidenceHandle);

        sealedVerdicts.publishReveal(
            callId, uint8(binaryIndexPlain), uint16(confidencePlain), binaryIndexSig, confidenceSig
        );

        (
            ,,,,,
            uint8 revealedBinaryIndex,
            uint16 revealedConfidenceBps,
            MurmurSealedVerdicts.CallState state
        ) = sealedVerdicts.getCall(callId);
        assertEq(uint8(state), uint8(MurmurSealedVerdicts.CallState.Revealed));
        assertEq(revealedBinaryIndex, 0);
        assertEq(revealedConfidenceBps, 7200);
    }

    function test_publishRevealMarksInvalidOutOfBandConfidenceTerminal() public {
        bytes32 callId = _submitVerdict(0, 5000, INVALID_CONFIDENCE_NONCE);
        vm.warp(PUBLIC_REVEAL_AT);
        sealedVerdicts.openReveal(callId);

        bytes32 binaryIndexHandle = sealedVerdicts.binaryIndexHandle(callId);
        bytes32 confidenceHandle = sealedVerdicts.confidenceHandle(callId);
        (, uint256 binaryIndexPlain, bytes memory binaryIndexSig) =
            agentClient.decryptForTx_withoutACP(binaryIndexHandle);
        (, uint256 confidencePlain, bytes memory confidenceSig) =
            agentClient.decryptForTx_withoutACP(confidenceHandle);

        sealedVerdicts.publishReveal(
            callId, uint8(binaryIndexPlain), uint16(confidencePlain), binaryIndexSig, confidenceSig
        );

        (
            ,,,,,
            uint8 revealedBinaryIndex,
            uint16 revealedConfidenceBps,
            MurmurSealedVerdicts.CallState state
        ) = sealedVerdicts.getCall(callId);
        assertEq(uint8(state), uint8(MurmurSealedVerdicts.CallState.Invalid));
        assertEq(revealedBinaryIndex, 0);
        assertEq(revealedConfidenceBps, 5000);
    }

    function test_publishRevealMarksInvalidBinaryIndexTerminal() public {
        bytes32 callId = _submitVerdict(2, 7200, INVALID_BINARY_NONCE);
        vm.warp(PUBLIC_REVEAL_AT);
        sealedVerdicts.openReveal(callId);

        bytes32 binaryIndexHandle = sealedVerdicts.binaryIndexHandle(callId);
        bytes32 confidenceHandle = sealedVerdicts.confidenceHandle(callId);
        (, uint256 binaryIndexPlain, bytes memory binaryIndexSig) =
            agentClient.decryptForTx_withoutACP(binaryIndexHandle);
        (, uint256 confidencePlain, bytes memory confidenceSig) =
            agentClient.decryptForTx_withoutACP(confidenceHandle);

        sealedVerdicts.publishReveal(
            callId, uint8(binaryIndexPlain), uint16(confidencePlain), binaryIndexSig, confidenceSig
        );

        (
            ,,,,,
            uint8 revealedBinaryIndex,
            uint16 revealedConfidenceBps,
            MurmurSealedVerdicts.CallState state
        ) = sealedVerdicts.getCall(callId);
        assertEq(uint8(state), uint8(MurmurSealedVerdicts.CallState.Invalid));
        assertEq(revealedBinaryIndex, 2);
        assertEq(revealedConfidenceBps, 7200);
    }

    function test_publishRevealRejectsTamperedOutOfBandConfidence() public {
        bytes32 callId = _submitBuy72();
        vm.warp(PUBLIC_REVEAL_AT);
        sealedVerdicts.openReveal(callId);

        bytes32 binaryIndexHandle = sealedVerdicts.binaryIndexHandle(callId);
        bytes32 confidenceHandle = sealedVerdicts.confidenceHandle(callId);
        (,, bytes memory binaryIndexSig) = agentClient.decryptForTx_withoutACP(binaryIndexHandle);
        (,, bytes memory confidenceSig) = agentClient.decryptForTx_withoutACP(confidenceHandle);

        vm.expectRevert();
        sealedVerdicts.publishReveal(callId, 0, 5000, binaryIndexSig, confidenceSig);
    }

    function test_submitFeedPacketForStoresEncryptedPayloadUntilReveal() public {
        bytes32 packetId = _submitFeedPacket();

        (
            address agent,
            bytes32 feedId,
            bytes32 marketId,
            uint64 acceptedAt,
            uint64 revealAfter,
            bytes32 actionCtHash,
            bytes32 signalCtHash,
            uint8 revealedAction,
            uint16 revealedSignalBps,
            MurmurSealedVerdicts.CallState state
        ) = sealedVerdicts.getFeedPacket(packetId);

        assertEq(agent, agentClient.account());
        assertEq(feedId, FEED_ID);
        assertEq(marketId, MARKET_ID);
        assertEq(acceptedAt, uint64(block.timestamp));
        // The market's registered embargo is authoritative — a caller-supplied
        // revealAfter is ignored. Previously the caller chose it, which let the
        // feed path go public on its own schedule and quietly bypass the
        // embargo the call path enforces.
        assertEq(revealAfter, PUBLIC_REVEAL_AT);
        assertEq(uint8(state), uint8(MurmurSealedVerdicts.CallState.Sealed));
        assertEq(revealedAction, 0);
        assertEq(revealedSignalBps, 0);
        expectPlaintext(actionCtHash, 1);
        expectPlaintext(signalCtHash, 6500);
    }

    function test_submitFeedPacketForStoresAgentWhileRelayerPaysGas() public {
        address expectedAgent = agentClient.account();
        address relayer = relayerClient.account();
        sealedVerdicts.setRelayer(relayer, true);

        (externalEuint8 action, externalEuint16 signal, bytes memory inputProof) =
            _sealedPair(relayer, 1, 6500);
        bytes32 nonce = keccak256("relayed-packet-001");
        uint64 revealAfter = uint64(block.timestamp + 1 hours);

        vm.prank(relayer);
        bytes32 packetId = sealedVerdicts.submitFeedPacketFor(
            expectedAgent, FEED_ID, MARKET_ID, action, signal, inputProof, nonce
        );
        assertEq(
            packetId,
            keccak256(
                abi.encodePacked(
                    block.chainid,
                    address(sealedVerdicts),
                    expectedAgent,
                    FEED_ID,
                    MARKET_ID,
                    nonce
                )
            )
        );

        {
            (
                address submittedAgent,
                bytes32 feedId,
                bytes32 marketId,
                uint64 acceptedAt,
                uint64 storedRevealAfter,
                ,
                ,
                ,
                ,
                MurmurSealedVerdicts.CallState state
            ) = sealedVerdicts.getFeedPacket(packetId);

            assertEq(submittedAgent, expectedAgent);
            assertEq(feedId, FEED_ID);
            assertEq(marketId, MARKET_ID);
            assertEq(acceptedAt, uint64(block.timestamp));
            // Requested `revealAfter` is overridden by the market embargo.
            assertTrue(revealAfter != PUBLIC_REVEAL_AT);
            assertEq(storedRevealAfter, PUBLIC_REVEAL_AT);
            assertEq(uint8(state), uint8(MurmurSealedVerdicts.CallState.Sealed));
        }
        expectPlaintext(sealedVerdicts.feedPacketActionHandle(packetId), 1);
        expectPlaintext(sealedVerdicts.feedPacketSignalHandle(packetId), 6500);
    }

    function test_openAndPublishFeedPacketReveal() public {
        bytes32 packetId = _submitFeedPacket();
        vm.warp(PUBLIC_REVEAL_AT);

        sealedVerdicts.openFeedPacketReveal(packetId);
        bytes32 actionHandle = sealedVerdicts.feedPacketActionHandle(packetId);
        bytes32 signalHandle = sealedVerdicts.feedPacketSignalHandle(packetId);

        (, uint256 actionPlain, bytes memory actionSig) =
            agentClient.decryptForTx_withoutACP(actionHandle);
        (, uint256 signalPlain, bytes memory signalSig) =
            agentClient.decryptForTx_withoutACP(signalHandle);

        sealedVerdicts.publishFeedPacketReveal(
            packetId, uint8(actionPlain), uint16(signalPlain), actionSig, signalSig
        );

        (
            ,,,,,,,
            uint8 revealedAction,
            uint16 revealedSignalBps,
            MurmurSealedVerdicts.CallState state
        ) = sealedVerdicts.getFeedPacket(packetId);
        assertEq(uint8(state), uint8(MurmurSealedVerdicts.CallState.Revealed));
        assertEq(revealedAction, 1);
        assertEq(revealedSignalBps, 6500);
    }

    function test_publishFeedPacketRevealMarksInvalidSignalTerminal() public {
        bytes32 packetId = _submitFeedPacketWith(1, 10001, INVALID_PACKET_NONCE);
        vm.warp(PUBLIC_REVEAL_AT);

        sealedVerdicts.openFeedPacketReveal(packetId);
        bytes32 actionHandle = sealedVerdicts.feedPacketActionHandle(packetId);
        bytes32 signalHandle = sealedVerdicts.feedPacketSignalHandle(packetId);

        (, uint256 actionPlain, bytes memory actionSig) =
            agentClient.decryptForTx_withoutACP(actionHandle);
        (, uint256 signalPlain, bytes memory signalSig) =
            agentClient.decryptForTx_withoutACP(signalHandle);

        sealedVerdicts.publishFeedPacketReveal(
            packetId, uint8(actionPlain), uint16(signalPlain), actionSig, signalSig
        );

        (
            ,,,,,,,
            uint8 revealedAction,
            uint16 revealedSignalBps,
            MurmurSealedVerdicts.CallState state
        ) = sealedVerdicts.getFeedPacket(packetId);
        assertEq(uint8(state), uint8(MurmurSealedVerdicts.CallState.Invalid));
        assertEq(revealedAction, 1);
        assertEq(revealedSignalBps, 10001);
    }

    function _submitBuy72() internal returns (bytes32 callId) {
        callId = _submitVerdict(0, 7200, CLIENT_NONCE);
    }

    function _submitVerdict(uint8 binaryIndexValue, uint16 confidenceValue, bytes32 nonce)
        internal
        returns (bytes32 callId)
    {
        address relayer = relayerClient.account();
        sealedVerdicts.setRelayer(relayer, true);
        address agent = agentClient.account();
        (externalEuint8 binaryIndex, externalEuint16 confidence, bytes memory inputProof) =
            _sealedPair(relayer, binaryIndexValue, confidenceValue);

        vm.prank(relayer);
        callId = sealedVerdicts.submitSealedFor(
            agent, MARKET_ID, binaryIndex, confidence, inputProof, nonce
        );
    }

    /// Feed packets close at RESOLUTION, not at public reveal.
    ///
    /// Only `publicRevealAt` was checked, which left the whole embargo window
    /// open — the stretch after the market resolves but before the sealed
    /// values go public. A packet submitted there predicts nothing (the
    /// outcome is already known) yet still counts as delivered feed evidence.
    function test_submitFeedPacketRejectedAfterResolution() public {
        address relayer = relayerClient.account();
        sealedVerdicts.setRelayer(relayer, true);
        address agent = agentClient.account();
        (externalEuint8 action, externalEuint16 signal, bytes memory proof) =
            _sealedPair(relayer, 1, 6500);

        // One second before resolution: still open.
        vm.warp(RESOLUTION_AT - 1);
        vm.prank(relayer);
        sealedVerdicts.submitFeedPacketFor(
            agent, FEED_ID, MARKET_ID, action, signal, proof, keccak256("before-resolution")
        );

        // At resolution: closed, even though publicRevealAt is still future.
        vm.warp(RESOLUTION_AT);
        assertLt(block.timestamp, PUBLIC_REVEAL_AT, "the embargo has NOT elapsed");
        (externalEuint8 action2, externalEuint16 signal2, bytes memory proof2) =
            _sealedPair(relayer, 1, 6500);
        vm.prank(relayer);
        vm.expectRevert(MurmurSealedVerdicts.FeedWindowClosed.selector);
        sealedVerdicts.submitFeedPacketFor(
            agent, FEED_ID, MARKET_ID, action2, signal2, proof2, keccak256("at-resolution")
        );
    }

    function _submitFeedPacket() internal returns (bytes32 packetId) {
        packetId = _submitFeedPacketWith(1, 6500, PACKET_NONCE);
    }

    function _submitFeedPacketWith(uint8 actionValue, uint16 signalValue, bytes32 nonce)
        internal
        returns (bytes32 packetId)
    {
        address relayer = relayerClient.account();
        sealedVerdicts.setRelayer(relayer, true);
        address agent = agentClient.account();
        (externalEuint8 action, externalEuint16 signal, bytes memory inputProof) =
            _sealedPair(relayer, actionValue, signalValue);

        vm.prank(relayer);
        packetId = sealedVerdicts.submitFeedPacketFor(
            agent,
            FEED_ID,
            MARKET_ID,
            action,
            signal,
            inputProof,
            nonce
        );
    }

    function _deployMocks() internal {
        deployCodeTo(
            "../node_modules/@cofhe/mock-contracts/contracts/MockTaskManager.sol:MockTaskManager",
            TASK_MANAGER_ADDRESS
        );
        mockTaskManager = MockTaskManager(TASK_MANAGER_ADDRESS);
        mockTaskManager.initialize(TM_ADMIN);
        mockTaskManager.setLogOps(false);

        mockAcl = new MockACL();

        vm.startPrank(TM_ADMIN);
        mockTaskManager.setACLContract(address(mockAcl));
        mockTaskManager.setSecurityZoneMin(0);
        mockTaskManager.setSecurityZoneMax(1);
        mockTaskManager.setVerifierSigner(ZK_VERIFIER_SIGNER_ADDRESS);
        mockTaskManager.setDecryptResultSigner(DECRYPT_RESULT_SIGNER_ADDRESS);
        vm.stopPrank();

        vm.deal(ZK_VERIFIER_SIGNER_ADDRESS, 10 ether);

        deployCodeTo(
            "../node_modules/@cofhe/mock-contracts/contracts/MockZkVerifier.sol:MockZkVerifier",
            ZK_VERIFIER_ADDRESS
        );
        mockZkVerifier = MockZkVerifier(ZK_VERIFIER_ADDRESS);
        deployCodeTo(
            "../node_modules/@cofhe/foundry-plugin/contracts/MockZkVerifierSigner.sol:MockZkVerifierSigner",
            ZK_VERIFIER_SIGNER_ADDRESS
        );
        mockZkVerifierSigner = MockZkVerifierSigner(ZK_VERIFIER_SIGNER_ADDRESS);
        deployCodeTo(
            "../node_modules/@cofhe/mock-contracts/contracts/MockThresholdNetwork.sol:MockThresholdNetwork",
            THRESHOLD_NETWORK_ADDRESS
        );
        MockThresholdNetwork(THRESHOLD_NETWORK_ADDRESS)
            .initialize(TASK_MANAGER_ADDRESS, address(mockAcl));
        deployCodeTo(
            "../node_modules/@cofhe/foundry-plugin/contracts/MockThresholdNetworkSigner.sol:MockThresholdNetworkSigner",
            DECRYPT_RESULT_SIGNER_ADDRESS
        );
    }

    /// @dev CoFHE 0.7 verifies the (euint8, euint16) pair as ONE batch: a single
    ///      signature over keccak256(h_0 || h_1), with each h_i binding the
    ///      sender AND the contract that consumes the handles. `CofheClient`
    ///      only exposes single-input and same-type batch helpers, so a mixed
    ///      pair is assembled here from the primitives those helpers use.
    function _sealedPair(address sender, uint256 firstValue, uint256 secondValue)
        internal
        returns (externalEuint8 first, externalEuint16 second, bytes memory inputProof)
    {
        return _sealedPairFor(sender, address(sealedVerdicts), firstValue, secondValue);
    }

    function _sealedPairFor(
        address sender,
        address consumingContract,
        uint256 firstValue,
        uint256 secondValue
    ) internal returns (externalEuint8 first, externalEuint16 second, bytes memory inputProof) {
        UnsignedEncryptedInput[] memory inputs = new UnsignedEncryptedInput[](2);

        uint256 firstHash = mockZkVerifier.zkVerifyCalcCtHash(
            firstValue, Utils.EUINT8_TFHE, sender, 0, block.chainid
        );
        mockZkVerifier.insertCtHash(firstHash, firstValue);
        inputs[0] =
            UnsignedEncryptedInput({ctHash: firstHash, securityZone: 0, utype: Utils.EUINT8_TFHE});

        uint256 secondHash = mockZkVerifier.zkVerifyCalcCtHash(
            secondValue, Utils.EUINT16_TFHE, sender, 0, block.chainid
        );
        mockZkVerifier.insertCtHash(secondHash, secondValue);
        inputs[1] =
            UnsignedEncryptedInput({ctHash: secondHash, securityZone: 0, utype: Utils.EUINT16_TFHE});

        inputProof = mockZkVerifierSigner.zkVerifyBatchSign(inputs, sender, consumingContract);
        first = externalEuint8.wrap(bytes32(firstHash));
        second = externalEuint16.wrap(bytes32(secondHash));
    }

    function expectPlaintext(bytes32 ctHash, uint256 value) internal view {
        uint256 ct = uint256(ctHash);
        assertEq(mockTaskManager.inMockStorage(ct), true);
        assertEq(mockTaskManager.mockStorage(ct), value);
    }
}
