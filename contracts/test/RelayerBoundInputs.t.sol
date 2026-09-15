// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.25;

import {Test} from "forge-std/Test.sol";
import {UnsignedEncryptedInput, Utils} from "@fhenixprotocol/cofhe-contracts/ICofhe.sol";
import {
    externalEuint8,
    externalEuint16,
    TASK_MANAGER_ADDRESS
} from "@fhenixprotocol/cofhe-contracts/FHE.sol";
import {MockACL} from "@cofhe/mock-contracts/contracts/MockACL.sol";
import {ZK_VERIFIER_SIGNER_ADDRESS} from "@cofhe/mock-contracts/contracts/MockCoFHE.sol";
import {InvalidSigner, MockTaskManager} from "@cofhe/mock-contracts/contracts/MockTaskManager.sol";
import {MockZkVerifier} from "@cofhe/mock-contracts/contracts/MockZkVerifier.sol";
import {MockZkVerifierSigner} from "@cofhe/foundry-plugin/contracts/MockZkVerifierSigner.sol";
import {MurmurSealedVerdicts} from "../src/MurmurSealedVerdicts.sol";

/// Proves agents can bind CoFHE inputs to Murmur's relayer without its private
/// key, and that the two bindings CoFHE 0.7 folds into the batch signature both
/// hold: the SENDER (murmur's relayer) and the CONSUMING CONTRACT
/// (MurmurSealedVerdicts — not the relayer, not the TaskManager).
contract RelayerBoundInputsTest is Test {
    address internal constant ZK_VERIFIER_ADDRESS = 0x0000000000000000000000000000000000005001;
    address internal constant TM_ADMIN = address(128);
    address internal constant AGENT = address(0xA6E47);
    address internal constant RELAYER = address(0xBEEF);
    address internal constant OTHER_BINDING = address(0xCAFE);
    bytes32 internal constant MARKET_ID = keccak256("relayer-bound-inputs");

    MurmurSealedVerdicts internal sealedVerdicts;
    MurmurSealedVerdicts internal otherDeployment;
    MockTaskManager internal mockTaskManager;
    MockZkVerifier internal mockZkVerifier;
    MockZkVerifierSigner internal mockZkVerifierSigner;

    function setUp() public {
        _deployMocks();
        sealedVerdicts = new MurmurSealedVerdicts();
        // A second deployment of the same contract, used only as the wrong
        // consuming contract for a proof bound elsewhere.
        otherDeployment = new MurmurSealedVerdicts();
        sealedVerdicts.registerMarket(
            MARKET_ID,
            MurmurSealedVerdicts.Market({
                armCloseAt: 60,
                submissionOpenAt: 120,
                earlyAccessCutoffAt: 600,
                submissionCloseAt: 900,
                resolutionAt: 1200,
                publicRevealAt: 1800,
                active: true
            })
        );
        sealedVerdicts.setRelayer(RELAYER, true);
        vm.warp(120);
    }

    function test_agentBuildsRelayerBoundInputsWithoutRelayerKeyAndStoredAgentRemainsAgent() public {
        (externalEuint8 binaryIndex, externalEuint16 confidence, bytes memory inputProof) =
            _inputsBoundTo(RELAYER, address(sealedVerdicts));

        vm.prank(RELAYER);
        bytes32 callId = sealedVerdicts.submitSealedFor(
            AGENT,
            MARKET_ID,
            binaryIndex,
            confidence,
            inputProof,
            keccak256("operator-blind-positive")
        );

        (address storedAgent,,,,,,,) = sealedVerdicts.getCall(callId);
        assertEq(storedAgent, AGENT);
        assertNotEq(storedAgent, RELAYER);
    }

    function test_inputsBoundToAnotherAddressFailWhenRelayerSubmits() public {
        (externalEuint8 binaryIndex, externalEuint16 confidence, bytes memory inputProof) =
            _inputsBoundTo(OTHER_BINDING, address(sealedVerdicts));

        vm.prank(RELAYER);
        vm.expectPartialRevert(InvalidSigner.selector);
        sealedVerdicts.submitSealedFor(
            AGENT,
            MARKET_ID,
            binaryIndex,
            confidence,
            inputProof,
            keccak256("operator-blind-negative")
        );
    }

    /// CoFHE 0.7 binds the CONSUMING CONTRACT into every per-input hash, so a
    /// batch signed for one MurmurSealedVerdicts deployment cannot be replayed
    /// into another — even by the correct relayer, in the same block, with the
    /// same handles. Without this the proof would only bind the sender, and a
    /// stale or hostile deployment could consume a live submission's inputs.
    function test_inputsBoundToAnotherConsumingContractAreRejected() public {
        (externalEuint8 binaryIndex, externalEuint16 confidence, bytes memory inputProof) =
            _inputsBoundTo(RELAYER, address(otherDeployment));

        vm.prank(RELAYER);
        vm.expectPartialRevert(InvalidSigner.selector);
        sealedVerdicts.submitSealedFor(
            AGENT,
            MARKET_ID,
            binaryIndex,
            confidence,
            inputProof,
            keccak256("wrong-consuming-contract")
        );
    }

    /// The signature covers keccak256(h_binaryIndex || h_confidence). Presenting
    /// the same two handles in the other order is a different digest, so a
    /// caller cannot silently swap which value lands in which field.
    function test_swappedInputOrderIsRejected() public {
        (uint256 binaryHash, uint256 confidenceHash, bytes memory inputProof) =
            _batch(RELAYER, address(sealedVerdicts), 1, 7400);

        vm.prank(RELAYER);
        vm.expectPartialRevert(InvalidSigner.selector);
        sealedVerdicts.submitSealedFor(
            AGENT,
            MARKET_ID,
            // confidence handle where the euint8 belongs, and vice versa.
            externalEuint8.wrap(bytes32(confidenceHash)),
            externalEuint16.wrap(bytes32(binaryHash)),
            inputProof,
            keccak256("swapped-order")
        );
    }

    /// The regression this migration exists for: 0.5 signed each input on its
    /// own, and the contract verified each on its own. Under 0.7 a per-input
    /// proof is a batch-of-ONE digest — keccak256(h_binaryIndex) — which cannot
    /// authenticate a two-element batch. Submitting one is rejected rather than
    /// silently accepted for the first input.
    function test_perInputProofIsRejected() public {
        (uint256 binaryHash, uint256 confidenceHash,) =
            _batch(RELAYER, address(sealedVerdicts), 1, 7400);

        UnsignedEncryptedInput[] memory single = new UnsignedEncryptedInput[](1);
        single[0] =
            UnsignedEncryptedInput({ctHash: binaryHash, securityZone: 0, utype: Utils.EUINT8_TFHE});
        bytes memory perInputProof =
            mockZkVerifierSigner.zkVerifyBatchSign(single, RELAYER, address(sealedVerdicts));

        vm.prank(RELAYER);
        vm.expectPartialRevert(InvalidSigner.selector);
        sealedVerdicts.submitSealedFor(
            AGENT,
            MARKET_ID,
            externalEuint8.wrap(bytes32(binaryHash)),
            externalEuint16.wrap(bytes32(confidenceHash)),
            perInputProof,
            keccak256("per-input-proof")
        );
    }

    function _inputsBoundTo(address binding, address consumingContract)
        internal
        returns (externalEuint8 binaryIndex, externalEuint16 confidence, bytes memory inputProof)
    {
        (uint256 binaryHash, uint256 confidenceHash, bytes memory proof) =
            _batch(binding, consumingContract, 1, 7400);
        return (
            externalEuint8.wrap(bytes32(binaryHash)),
            externalEuint16.wrap(bytes32(confidenceHash)),
            proof
        );
    }

    /// @dev One CoFHE 0.7 batch: two handles of DIFFERENT types authenticated by
    ///      a single signature over keccak256(h_0 || h_1). Each h_i binds
    ///      ctHash, utype, securityZone, `sender`, chainid and
    ///      `consumingContract`, so both are parameters here.
    function _batch(
        address sender,
        address consumingContract,
        uint256 binaryIndexValue,
        uint256 confidenceValue
    ) internal returns (uint256 binaryHash, uint256 confidenceHash, bytes memory inputProof) {
        UnsignedEncryptedInput[] memory inputs = new UnsignedEncryptedInput[](2);

        binaryHash = mockZkVerifier.zkVerifyCalcCtHash(
            binaryIndexValue, Utils.EUINT8_TFHE, sender, 0, block.chainid
        );
        mockZkVerifier.insertCtHash(binaryHash, binaryIndexValue);
        inputs[0] =
            UnsignedEncryptedInput({ctHash: binaryHash, securityZone: 0, utype: Utils.EUINT8_TFHE});

        confidenceHash = mockZkVerifier.zkVerifyCalcCtHash(
            confidenceValue, Utils.EUINT16_TFHE, sender, 0, block.chainid
        );
        mockZkVerifier.insertCtHash(confidenceHash, confidenceValue);
        inputs[1] = UnsignedEncryptedInput({
            ctHash: confidenceHash,
            securityZone: 0,
            utype: Utils.EUINT16_TFHE
        });

        inputProof = mockZkVerifierSigner.zkVerifyBatchSign(inputs, sender, consumingContract);
    }

    function _deployMocks() internal {
        deployCodeTo(
            "../node_modules/@cofhe/mock-contracts/contracts/MockTaskManager.sol:MockTaskManager", TASK_MANAGER_ADDRESS
        );
        mockTaskManager = MockTaskManager(TASK_MANAGER_ADDRESS);
        mockTaskManager.initialize(TM_ADMIN);
        mockTaskManager.setLogOps(false);

        MockACL mockAcl = new MockACL();
        vm.startPrank(TM_ADMIN);
        mockTaskManager.setACLContract(address(mockAcl));
        mockTaskManager.setSecurityZoneMin(0);
        mockTaskManager.setSecurityZoneMax(1);
        mockTaskManager.setVerifierSigner(ZK_VERIFIER_SIGNER_ADDRESS);
        vm.stopPrank();

        deployCodeTo(
            "../node_modules/@cofhe/mock-contracts/contracts/MockZkVerifier.sol:MockZkVerifier", ZK_VERIFIER_ADDRESS
        );
        mockZkVerifier = MockZkVerifier(ZK_VERIFIER_ADDRESS);
        deployCodeTo(
            "../node_modules/@cofhe/foundry-plugin/contracts/MockZkVerifierSigner.sol:MockZkVerifierSigner",
            ZK_VERIFIER_SIGNER_ADDRESS
        );
        mockZkVerifierSigner = MockZkVerifierSigner(ZK_VERIFIER_SIGNER_ADDRESS);
    }
}
