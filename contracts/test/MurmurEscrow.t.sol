// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {MurmurEscrow} from "../src/MurmurEscrow.sol";

/// Minimal mock USDC: 6 decimals, mintable, no transfer hooks.
contract MockUSDC {
    string public constant name = "MockUSDC";
    string public constant symbol = "mUSDC";
    uint8 public constant decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public totalSupply;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "bal");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "bal");
        require(allowance[from][msg.sender] >= amount, "allow");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}

contract MurmurEscrowTest is Test {
    MurmurEscrow internal escrow;
    MockUSDC internal usdc;

    address internal owner = address(0xA11CE);
    address internal feeSink = address(0xFEE5);
    address internal agent = address(0xA6E47);
    address internal buyer = address(0xB44E2);

    bytes32 internal constant PIPELINE_ID = keccak256("alpha-bot:eth-4h");

    function setUp() public {
        usdc = new MockUSDC();
        vm.prank(owner);
        escrow = new MurmurEscrow(address(usdc), feeSink);

        // mint USDC to buyer
        usdc.mint(buyer, 1_000 * 1e6);
        vm.prank(buyer);
        usdc.approve(address(escrow), type(uint256).max);
    }

    // ─── Pipeline lifecycle ───────────────────────────────────────────────

    function _createPipeline(uint96 price, uint32 sla, uint32 horizon) internal {
        escrow.createPipeline(PIPELINE_ID, agent, price, sla, horizon);
    }

    function test_createPipeline_emitsAndStores() public {
        _createPipeline(1 * 1e6, 60, 4);
        MurmurEscrow.Pipeline memory p = escrow.getPipeline(PIPELINE_ID);
        assertEq(p.agentOwner, agent);
        assertEq(p.priceUsdc, 1 * 1e6);
        assertEq(p.slaSeconds, 60);
        assertEq(p.horizonHours, 4);
        assertTrue(p.active);
    }

    function test_createPipeline_rejectsZeroPrice() public {
        vm.expectRevert(MurmurEscrow.PriceMustBePositive.selector);
        escrow.createPipeline(PIPELINE_ID, agent, 0, 60, 4);
    }

    function test_createPipeline_rejectsDuplicate() public {
        _createPipeline(1 * 1e6, 60, 4);
        vm.expectRevert(MurmurEscrow.PipelineNotActive.selector);
        _createPipeline(2 * 1e6, 30, 1);
    }

    // ─── Happy path: request → commit → finalize ──────────────────────────

    function test_fullLifecycle_payoutsCorrect() public {
        _createPipeline(10 * 1e6, 60, 4);

        bytes32 nonce = bytes32(uint256(0xABCD));
        vm.prank(buyer);
        bytes32 requestId = escrow.requestInference(PIPELINE_ID, nonce);

        // escrow now holds the buyer's USDC
        assertEq(usdc.balanceOf(address(escrow)), 10 * 1e6);
        assertEq(usdc.balanceOf(buyer), 990 * 1e6);

        // agent commits
        bytes memory signal = bytes("BUY ETH 4h size=0.05 entry=3000 stop=2950");
        bytes32 revealNonce = bytes32(uint256(0xDEADBEEF));
        bytes32 commitHash = keccak256(abi.encodePacked(signal, revealNonce));
        bytes32 mdc = bytes32(uint256(block.timestamp));

        vm.prank(agent);
        escrow.commitSignal(requestId, commitHash, mdc);

        MurmurEscrow.InferenceRequest memory r = escrow.getRequest(requestId);
        assertEq(uint8(r.state), uint8(MurmurEscrow.RequestState.Committed));
        assertEq(r.commitHash, commitHash);

        // jump to after horizon
        vm.warp(block.timestamp + 4 hours + 1);

        // anyone can finalize
        escrow.finalize(requestId, signal, revealNonce);

        // 95% to agent, 5% to fee sink
        assertEq(usdc.balanceOf(agent), 9_500_000); // 9.5 USDC
        assertEq(usdc.balanceOf(feeSink), 500_000); // 0.5 USDC
        assertEq(usdc.balanceOf(address(escrow)), 0);
    }

    function test_finalize_rejectsCommitMismatch() public {
        _createPipeline(10 * 1e6, 60, 4);
        vm.prank(buyer);
        bytes32 requestId = escrow.requestInference(PIPELINE_ID, bytes32(uint256(1)));

        bytes32 commitHash = keccak256(abi.encodePacked(bytes("real"), bytes32(uint256(7))));
        vm.prank(agent);
        escrow.commitSignal(requestId, commitHash, bytes32(0));

        vm.warp(block.timestamp + 4 hours + 1);
        vm.expectRevert(MurmurEscrow.CommitMismatch.selector);
        escrow.finalize(requestId, bytes("forgery"), bytes32(uint256(7)));
    }

    function test_finalize_rejectsBeforeWindow() public {
        _createPipeline(10 * 1e6, 60, 4);
        vm.prank(buyer);
        bytes32 requestId = escrow.requestInference(PIPELINE_ID, bytes32(uint256(2)));

        bytes memory signal = bytes("x");
        bytes32 nonce = bytes32(uint256(7));
        bytes32 commitHash = keccak256(abi.encodePacked(signal, nonce));
        vm.prank(agent);
        escrow.commitSignal(requestId, commitHash, bytes32(0));

        // horizon hasn't elapsed
        vm.warp(block.timestamp + 1 hours);
        vm.expectRevert(MurmurEscrow.BeforeFinalizeWindow.selector);
        escrow.finalize(requestId, signal, nonce);
    }

    // ─── SLA timeout / refund ──────────────────────────────────────────────

    function test_refund_succeedsAfterSla() public {
        _createPipeline(10 * 1e6, 60, 4);
        vm.prank(buyer);
        bytes32 requestId = escrow.requestInference(PIPELINE_ID, bytes32(uint256(3)));

        // SLA = 60s; warp past it without any commit
        vm.warp(block.timestamp + 61);
        escrow.refund(requestId);

        // buyer made whole
        assertEq(usdc.balanceOf(buyer), 1_000 * 1e6);
        assertEq(usdc.balanceOf(address(escrow)), 0);

        MurmurEscrow.InferenceRequest memory r = escrow.getRequest(requestId);
        assertEq(uint8(r.state), uint8(MurmurEscrow.RequestState.Refunded));
    }

    function test_refund_rejectsBeforeSla() public {
        _createPipeline(10 * 1e6, 60, 4);
        vm.prank(buyer);
        bytes32 requestId = escrow.requestInference(PIPELINE_ID, bytes32(uint256(4)));

        // still inside SLA window
        vm.expectRevert(MurmurEscrow.BeforeFinalizeWindow.selector);
        escrow.refund(requestId);
    }

    function test_refund_rejectsAfterCommit() public {
        _createPipeline(10 * 1e6, 60, 4);
        vm.prank(buyer);
        bytes32 requestId = escrow.requestInference(PIPELINE_ID, bytes32(uint256(5)));

        vm.prank(agent);
        escrow.commitSignal(requestId, bytes32(uint256(0xC0FFEE)), bytes32(0));

        vm.warp(block.timestamp + 4 hours + 100);
        vm.expectRevert(MurmurEscrow.WrongState.selector);
        escrow.refund(requestId);
    }

    // ─── Cancel window ─────────────────────────────────────────────────────

    function test_cancel_succeedsWithinWindow() public {
        _createPipeline(10 * 1e6, 600, 4);
        vm.prank(buyer);
        bytes32 requestId = escrow.requestInference(PIPELINE_ID, bytes32(uint256(6)));

        vm.warp(block.timestamp + 30); // < CANCEL_WINDOW_SECONDS
        vm.prank(buyer);
        escrow.cancel(requestId);

        assertEq(usdc.balanceOf(buyer), 1_000 * 1e6);
    }

    function test_cancel_rejectsAfterWindow() public {
        _createPipeline(10 * 1e6, 600, 4);
        vm.prank(buyer);
        bytes32 requestId = escrow.requestInference(PIPELINE_ID, bytes32(uint256(7)));

        vm.warp(block.timestamp + 90); // > 60s window
        vm.prank(buyer);
        vm.expectRevert(MurmurEscrow.CancelWindowClosed.selector);
        escrow.cancel(requestId);
    }

    function test_cancel_rejectsNonBuyer() public {
        _createPipeline(10 * 1e6, 600, 4);
        vm.prank(buyer);
        bytes32 requestId = escrow.requestInference(PIPELINE_ID, bytes32(uint256(8)));

        vm.prank(agent);
        vm.expectRevert(MurmurEscrow.NotBuyer.selector);
        escrow.cancel(requestId);
    }

    // ─── Commit window ─────────────────────────────────────────────────────

    function test_commitSignal_rejectsPastSla() public {
        _createPipeline(10 * 1e6, 60, 4);
        vm.prank(buyer);
        bytes32 requestId = escrow.requestInference(PIPELINE_ID, bytes32(uint256(9)));

        vm.warp(block.timestamp + 61);
        vm.prank(agent);
        vm.expectRevert(MurmurEscrow.PastDeadline.selector);
        escrow.commitSignal(requestId, bytes32(uint256(1)), bytes32(0));
    }

    function test_commitSignal_rejectsNonAgent() public {
        _createPipeline(10 * 1e6, 60, 4);
        vm.prank(buyer);
        bytes32 requestId = escrow.requestInference(PIPELINE_ID, bytes32(uint256(10)));

        vm.prank(buyer);
        vm.expectRevert(MurmurEscrow.NotPipelineOwner.selector);
        escrow.commitSignal(requestId, bytes32(uint256(1)), bytes32(0));
    }

    // ─── Pause ─────────────────────────────────────────────────────────────

    function test_pause_blocksRequests() public {
        _createPipeline(10 * 1e6, 60, 4);
        vm.prank(owner);
        escrow.setPaused(true);
        vm.prank(buyer);
        vm.expectRevert(MurmurEscrow.Paused.selector);
        escrow.requestInference(PIPELINE_ID, bytes32(uint256(11)));
    }

    // ─── Merkle root anchoring ────────────────────────────────────────────

    function test_merkleRoot_ownerOnly() public {
        bytes32 root = keccak256("batch-1");
        vm.prank(owner);
        escrow.submitMerkleRoot(1, root);
        assertEq(escrow.merkleRoots(1), root);

        vm.expectRevert(MurmurEscrow.NotOwner.selector);
        escrow.submitMerkleRoot(2, keccak256("batch-2"));
    }

    function test_merkleRoot_rejectsRebatch() public {
        vm.startPrank(owner);
        escrow.submitMerkleRoot(1, keccak256("first"));
        vm.expectRevert(MurmurEscrow.BatchAlreadySubmitted.selector);
        escrow.submitMerkleRoot(1, keccak256("second"));
        vm.stopPrank();
    }

    function test_merkleRoot_rejectsEmpty() public {
        vm.prank(owner);
        vm.expectRevert(MurmurEscrow.MerkleRootEmpty.selector);
        escrow.submitMerkleRoot(1, bytes32(0));
    }

    // ─── Admin ─────────────────────────────────────────────────────────────

    function test_setProtocolFeeBps_capped() public {
        vm.prank(owner);
        vm.expectRevert(MurmurEscrow.FeeTooHigh.selector);
        escrow.setProtocolFeeBps(1001);
    }

    function test_setProtocolFeeBps_appliesToFinalize() public {
        _createPipeline(100 * 1e6, 60, 4);
        vm.prank(owner);
        escrow.setProtocolFeeBps(1000); // 10%

        vm.prank(buyer);
        bytes32 requestId = escrow.requestInference(PIPELINE_ID, bytes32(uint256(12)));

        bytes memory sig = bytes("s");
        bytes32 nonce = bytes32(uint256(99));
        bytes32 commitHash = keccak256(abi.encodePacked(sig, nonce));
        vm.prank(agent);
        escrow.commitSignal(requestId, commitHash, bytes32(0));

        vm.warp(block.timestamp + 4 hours + 1);
        escrow.finalize(requestId, sig, nonce);

        assertEq(usdc.balanceOf(feeSink), 10 * 1e6); // 10% of 100
        assertEq(usdc.balanceOf(agent), 90 * 1e6);
    }
}
