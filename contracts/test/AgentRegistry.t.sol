// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/AgentRegistry.sol";

contract AgentRegistryTest is Test {
    AgentRegistry registry;
    address agent = address(0xBEEF);

    function setUp() public {
        registry = new AgentRegistry();
    }

    function test_attest_emits_event() public {
        bytes32 hash = keccak256("receipt-1");
        vm.prank(agent);
        vm.expectEmit(true, true, false, true);
        emit AgentRegistry.AgentAttested(agent, hash, 1, "ipfs://Qm1", "buy");
        registry.attest(hash, "ipfs://Qm1", "buy");
    }

    function test_attest_stores_attestation() public {
        bytes32 hash = keccak256("receipt-1");
        vm.prank(agent);
        uint256 id = registry.attest(hash, "ipfs://Qm1", "buy");

        assertEq(id, 1);
        assertEq(registry.attestedBy(hash), agent);

        AgentRegistry.Attestation[] memory atts = registry.getAttestations(agent);
        assertEq(atts.length, 1);
        assertEq(atts[0].receiptHash, hash);
        assertEq(atts[0].metadataUri, "ipfs://Qm1");
        assertEq(atts[0].actionType, "buy");
        assertEq(atts[0].attestationId, 1);
    }

    function test_attest_reverts_on_duplicate_hash() public {
        bytes32 hash = keccak256("receipt-dup");
        vm.prank(agent);
        registry.attest(hash, "ipfs://Qm1", "buy");

        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(AgentRegistry.AlreadyAttested.selector, hash, agent)
        );
        registry.attest(hash, "ipfs://Qm2", "hold");
    }

    function test_attest_reverts_on_empty_hash() public {
        vm.prank(agent);
        vm.expectRevert(AgentRegistry.EmptyReceiptHash.selector);
        registry.attest(bytes32(0), "ipfs://Qm1", "buy");
    }

    function test_attest_reverts_on_empty_uri() public {
        vm.prank(agent);
        vm.expectRevert(AgentRegistry.EmptyMetadataUri.selector);
        registry.attest(keccak256("receipt"), "", "buy");
    }

    function test_multiple_attestations_increment_id() public {
        vm.startPrank(agent);
        uint256 id1 = registry.attest(keccak256("r1"), "ipfs://1", "buy");
        uint256 id2 = registry.attest(keccak256("r2"), "ipfs://2", "hold");
        uint256 id3 = registry.attest(keccak256("r3"), "ipfs://3", "exit");
        vm.stopPrank();

        assertEq(id1, 1);
        assertEq(id2, 2);
        assertEq(id3, 3);
        assertEq(registry.attestationCount(agent), 3);
    }

    function test_different_agents_can_attest_different_hashes() public {
        address agent2 = address(0xCAFE);
        bytes32 hash1 = keccak256("r1");
        bytes32 hash2 = keccak256("r2");

        vm.prank(agent);
        registry.attest(hash1, "ipfs://1", "buy");

        vm.prank(agent2);
        registry.attest(hash2, "ipfs://2", "exit");

        assertEq(registry.attestationCount(agent), 1);
        assertEq(registry.attestationCount(agent2), 1);
    }
}
