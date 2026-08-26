// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {Test} from "forge-std/Test.sol";
import {EncryptedInput, InEuint8, InEuint16} from "@fhenixprotocol/cofhe-contracts/ICofhe.sol";
import {TASK_MANAGER_ADDRESS} from "@fhenixprotocol/cofhe-contracts/FHE.sol";
import {MockACL} from "@cofhe/mock-contracts/contracts/MockACL.sol";
import {ZK_VERIFIER_SIGNER_ADDRESS} from "@cofhe/mock-contracts/contracts/MockCoFHE.sol";
import {InvalidSigner, MockTaskManager} from "@cofhe/mock-contracts/contracts/MockTaskManager.sol";
import {MockZkVerifier} from "@cofhe/mock-contracts/contracts/MockZkVerifier.sol";
import {MockZkVerifierSigner} from "@cofhe/foundry-plugin/contracts/MockZkVerifierSigner.sol";
import {MurmurSealedVerdicts} from "../src/MurmurSealedVerdicts.sol";

// Proves agents can bind CoFHE inputs to Murmur's relayer without its private key.
contract RelayerBoundInputsTest is Test {
    address internal constant ZK_VERIFIER_ADDRESS = 0x0000000000000000000000000000000000005001;
    address internal constant TM_ADMIN = address(128);
    address internal constant AGENT = address(0xA6E47);
    address internal constant RELAYER = address(0xBEEF);
    address internal constant OTHER_BINDING = address(0xCAFE);
    bytes32 internal constant MARKET_ID = keccak256("relayer-bound-inputs");

    MurmurSealedVerdicts internal sealedVerdicts;
    MockTaskManager internal mockTaskManager;
    MockZkVerifier internal mockZkVerifier;
    MockZkVerifierSigner internal mockZkVerifierSigner;

    function setUp() public {
        _deployMocks();
        sealedVerdicts = new MurmurSealedVerdicts();
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
        (InEuint8 memory binaryIndex, InEuint16 memory confidence) = _inputsBoundTo(RELAYER);

        vm.prank(RELAYER);
        bytes32 callId = sealedVerdicts.submitSealedFor(
            AGENT, MARKET_ID, binaryIndex, confidence, keccak256("operator-blind-positive")
        );

        (address storedAgent,,,,,,,) = sealedVerdicts.getCall(callId);
        assertEq(storedAgent, AGENT);
        assertNotEq(storedAgent, RELAYER);
    }

    function test_inputsBoundToAnotherAddressFailWhenRelayerSubmits() public {
        (InEuint8 memory binaryIndex, InEuint16 memory confidence) = _inputsBoundTo(OTHER_BINDING);

        vm.prank(RELAYER);
        vm.expectPartialRevert(InvalidSigner.selector);
        sealedVerdicts.submitSealedFor(AGENT, MARKET_ID, binaryIndex, confidence, keccak256("operator-blind-negative"));
    }

    function _inputsBoundTo(address binding)
        internal
        returns (InEuint8 memory binaryIndex, InEuint16 memory confidence)
    {
        EncryptedInput memory binary = mockZkVerifier.zkVerify(1, 2, binding, 0, block.chainid);
        binary = mockZkVerifierSigner.zkVerifySign(binary, binding);
        binaryIndex = InEuint8({
            ctHash: binary.ctHash, securityZone: binary.securityZone, utype: binary.utype, signature: binary.signature
        });

        EncryptedInput memory confidenceInput = mockZkVerifier.zkVerify(7400, 3, binding, 0, block.chainid);
        confidenceInput = mockZkVerifierSigner.zkVerifySign(confidenceInput, binding);
        confidence = InEuint16({
            ctHash: confidenceInput.ctHash,
            securityZone: confidenceInput.securityZone,
            utype: confidenceInput.utype,
            signature: confidenceInput.signature
        });
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
