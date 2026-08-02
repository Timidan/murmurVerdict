// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {Test} from "forge-std/Test.sol";
import {CofheClient} from "@cofhe/foundry-plugin/contracts/CofheClient.sol";
import {InEuint8, InEuint16, TASK_MANAGER_ADDRESS} from "@fhenixprotocol/cofhe-contracts/FHE.sol";
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

    address internal constant ZK_VERIFIER_ADDRESS = 0x0000000000000000000000000000000000005001;
    address internal constant THRESHOLD_NETWORK_ADDRESS =
        0x0000000000000000000000000000000000005002;
    address internal constant TM_ADMIN = address(128);

    uint256 internal constant AGENT_KEY = 0xA6E47;
    uint256 internal constant RELAYER_KEY = 0xBEEF;
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
        sealedVerdicts.registerMarket(MARKET_ID, 1 hours, true);
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
            uint64 revealOpenAt,
            bytes32 binaryCt,
            bytes32 confidenceCt,
            bool alreadyGranted
        ) = sealedVerdicts.getDecryptAccess(callId, SUBSCRIBER);
        assertEq(uint8(state), uint8(MurmurSealedVerdicts.CallState.Sealed));
        assertEq(revealOpenAt, sealedVerdicts.callRevealOpenAt(callId));
        assertEq(uint256(binaryCt), binaryHandle);
        assertEq(uint256(confidenceCt), confidenceHandle);
        assertTrue(alreadyGranted);

        // The persistent grant survives the call's later public reveal — the
        // subscriber's earlier per-address permission is not revoked by the
        // global allowPublic added at openReveal.
        vm.warp(block.timestamp + 1 hours);
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

        // The sale window closes at revealOpenAt even before anyone calls
        // openReveal; the reveal worker's grace period does not extend it.
        vm.warp(sealedVerdicts.callRevealOpenAt(callId));
        vm.prank(GRANTOR);
        vm.expectRevert(MurmurSealedVerdicts.DecryptGrantWindowClosed.selector);
        sealedVerdicts.grantDecryptAccess(callId, SUBSCRIBER);
    }

    function test_grantDecryptAccessRevertsOnceRevealOpened() public {
        bytes32 callId = _submitBuy72();
        sealedVerdicts.setGrantor(GRANTOR, true);

        vm.warp(block.timestamp + 1 hours);
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

        InEuint8 memory binaryIndex = relayerClient.createInEuint8(0);
        InEuint16 memory confidence = relayerClient.createInEuint16(7200);
        bytes32 nonce = keccak256("relayed-order-001");

        vm.prank(relayer);
        bytes32 callId = sealedVerdicts.submitSealedFor(
            expectedAgent, MARKET_ID, binaryIndex, confidence, nonce
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
        InEuint8 memory binaryIndex = relayerClient.createInEuint8(0);
        InEuint16 memory confidence = relayerClient.createInEuint16(7200);

        vm.prank(relayer);
        vm.expectRevert(MurmurSealedVerdicts.NotRelayer.selector);
        sealedVerdicts.submitSealedFor(
            expectedAgent, MARKET_ID, binaryIndex, confidence, keccak256("non-relayer")
        );

        sealedVerdicts.setRelayer(relayer, true);
        vm.prank(relayer);
        vm.expectRevert(MurmurSealedVerdicts.ZeroAgent.selector);
        sealedVerdicts.submitSealedFor(
            address(0), MARKET_ID, binaryIndex, confidence, keccak256("zero-agent")
        );
    }

    function test_revealRequiresHorizon() public {
        bytes32 callId = _submitBuy72();

        vm.expectRevert(MurmurSealedVerdicts.RevealWindowNotOpen.selector);
        sealedVerdicts.openReveal(callId);
    }

    function test_fixedRevealMarketUsesAbsoluteRevealTime() public {
        uint64 revealAfter = uint64(block.timestamp + 2 hours);
        sealedVerdicts.registerFixedRevealMarket(FIXED_REVEAL_MARKET_ID, revealAfter, true);

        address relayer = relayerClient.account();
        sealedVerdicts.setRelayer(relayer, true);
        InEuint8 memory binaryIndex = relayerClient.createInEuint8(0);
        InEuint16 memory confidence = relayerClient.createInEuint16(7200);
        address agent = agentClient.account();

        vm.prank(relayer);
        bytes32 callId = sealedVerdicts.submitSealedFor(
            agent,
            FIXED_REVEAL_MARKET_ID,
            binaryIndex,
            confidence,
            keccak256("fixed-reveal-order")
        );

        assertEq(sealedVerdicts.callRevealOpenAt(callId), revealAfter);

        vm.warp(revealAfter - 1);
        vm.expectRevert(MurmurSealedVerdicts.RevealWindowNotOpen.selector);
        sealedVerdicts.openReveal(callId);

        vm.warp(revealAfter);
        sealedVerdicts.openReveal(callId);
    }

    function test_openAndPublishReveal() public {
        bytes32 callId = _submitBuy72();
        vm.warp(block.timestamp + 1 hours);

        sealedVerdicts.openReveal(callId);
        bytes32 binaryIndexHandle = sealedVerdicts.binaryIndexHandle(callId);
        bytes32 confidenceHandle = sealedVerdicts.confidenceHandle(callId);

        (, uint256 binaryIndexPlain, bytes memory binaryIndexSig) =
            agentClient.decryptForTx_withoutPermit(binaryIndexHandle);
        (, uint256 confidencePlain, bytes memory confidenceSig) =
            agentClient.decryptForTx_withoutPermit(confidenceHandle);

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
        vm.warp(block.timestamp + 1 hours);
        sealedVerdicts.openReveal(callId);

        bytes32 binaryIndexHandle = sealedVerdicts.binaryIndexHandle(callId);
        bytes32 confidenceHandle = sealedVerdicts.confidenceHandle(callId);
        (, uint256 binaryIndexPlain, bytes memory binaryIndexSig) =
            agentClient.decryptForTx_withoutPermit(binaryIndexHandle);
        (, uint256 confidencePlain, bytes memory confidenceSig) =
            agentClient.decryptForTx_withoutPermit(confidenceHandle);

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
        vm.warp(block.timestamp + 1 hours);
        sealedVerdicts.openReveal(callId);

        bytes32 binaryIndexHandle = sealedVerdicts.binaryIndexHandle(callId);
        bytes32 confidenceHandle = sealedVerdicts.confidenceHandle(callId);
        (, uint256 binaryIndexPlain, bytes memory binaryIndexSig) =
            agentClient.decryptForTx_withoutPermit(binaryIndexHandle);
        (, uint256 confidencePlain, bytes memory confidenceSig) =
            agentClient.decryptForTx_withoutPermit(confidenceHandle);

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
        vm.warp(block.timestamp + 1 hours);
        sealedVerdicts.openReveal(callId);

        bytes32 binaryIndexHandle = sealedVerdicts.binaryIndexHandle(callId);
        bytes32 confidenceHandle = sealedVerdicts.confidenceHandle(callId);
        (,, bytes memory binaryIndexSig) = agentClient.decryptForTx_withoutPermit(binaryIndexHandle);
        (,, bytes memory confidenceSig) = agentClient.decryptForTx_withoutPermit(confidenceHandle);

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
        assertEq(revealAfter, uint64(block.timestamp + 1 hours));
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

        InEuint8 memory action = relayerClient.createInEuint8(1);
        InEuint16 memory signal = relayerClient.createInEuint16(6500);
        bytes32 nonce = keccak256("relayed-packet-001");
        uint64 revealAfter = uint64(block.timestamp + 1 hours);

        vm.prank(relayer);
        bytes32 packetId = sealedVerdicts.submitFeedPacketFor(
            expectedAgent, FEED_ID, MARKET_ID, revealAfter, action, signal, nonce
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
            assertEq(storedRevealAfter, revealAfter);
            assertEq(uint8(state), uint8(MurmurSealedVerdicts.CallState.Sealed));
        }
        expectPlaintext(sealedVerdicts.feedPacketActionHandle(packetId), 1);
        expectPlaintext(sealedVerdicts.feedPacketSignalHandle(packetId), 6500);
    }

    function test_openAndPublishFeedPacketReveal() public {
        bytes32 packetId = _submitFeedPacket();
        vm.warp(block.timestamp + 1 hours);

        sealedVerdicts.openFeedPacketReveal(packetId);
        bytes32 actionHandle = sealedVerdicts.feedPacketActionHandle(packetId);
        bytes32 signalHandle = sealedVerdicts.feedPacketSignalHandle(packetId);

        (, uint256 actionPlain, bytes memory actionSig) =
            agentClient.decryptForTx_withoutPermit(actionHandle);
        (, uint256 signalPlain, bytes memory signalSig) =
            agentClient.decryptForTx_withoutPermit(signalHandle);

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
        vm.warp(block.timestamp + 1 hours);

        sealedVerdicts.openFeedPacketReveal(packetId);
        bytes32 actionHandle = sealedVerdicts.feedPacketActionHandle(packetId);
        bytes32 signalHandle = sealedVerdicts.feedPacketSignalHandle(packetId);

        (, uint256 actionPlain, bytes memory actionSig) =
            agentClient.decryptForTx_withoutPermit(actionHandle);
        (, uint256 signalPlain, bytes memory signalSig) =
            agentClient.decryptForTx_withoutPermit(signalHandle);

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
        InEuint8 memory binaryIndex = relayerClient.createInEuint8(binaryIndexValue);
        InEuint16 memory confidence = relayerClient.createInEuint16(confidenceValue);

        vm.prank(relayer);
        callId = sealedVerdicts.submitSealedFor(
            agent, MARKET_ID, binaryIndex, confidence, nonce
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
        InEuint8 memory action = relayerClient.createInEuint8(actionValue);
        InEuint16 memory signal = relayerClient.createInEuint16(signalValue);

        vm.prank(relayer);
        packetId = sealedVerdicts.submitFeedPacketFor(
            agent,
            FEED_ID,
            MARKET_ID,
            uint64(block.timestamp + 1 hours),
            action,
            signal,
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
        deployCodeTo(
            "../node_modules/@cofhe/foundry-plugin/contracts/MockZkVerifierSigner.sol:MockZkVerifierSigner",
            ZK_VERIFIER_SIGNER_ADDRESS
        );
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

    function expectPlaintext(bytes32 ctHash, uint256 value) internal view {
        uint256 ct = uint256(ctHash);
        assertEq(mockTaskManager.inMockStorage(ct), true);
        assertEq(mockTaskManager.mockStorage(ct), value);
    }
}
