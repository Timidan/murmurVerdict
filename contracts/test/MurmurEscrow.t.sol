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
    address internal randomCaller = address(0x9AA51E5);

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

    /// Audit H-1: createPipeline is now onlyOwner. Helper pranks the owner
    /// for each call so the existing test bodies don't have to repeat it.
    /// Pipeline SLAs in tests now use 120s; the audit L-2 fix requires
    /// slaSeconds > CANCEL_WINDOW_SECONDS (60).
    function _createPipeline(uint96 price, uint32 sla, uint32 horizon) internal {
        vm.prank(owner);
        escrow.createPipeline(PIPELINE_ID, agent, price, sla, horizon);
    }

    function test_createPipeline_emitsAndStores() public {
        _createPipeline(1 * 1e6, 120, 4);
        MurmurEscrow.Pipeline memory p = escrow.getPipeline(PIPELINE_ID);
        assertEq(p.agentOwner, agent);
        assertEq(p.priceUsdc, 1 * 1e6);
        assertEq(p.slaSeconds, 120);
        assertEq(p.horizonHours, 4);
        assertTrue(p.active);
    }

    function test_createPipeline_rejectsZeroPrice() public {
        vm.prank(owner);
        vm.expectRevert(MurmurEscrow.PriceMustBePositive.selector);
        escrow.createPipeline(PIPELINE_ID, agent, 0, 120, 4);
    }

    function test_createPipeline_rejectsDuplicate() public {
        _createPipeline(1 * 1e6, 120, 4);
        vm.prank(owner);
        vm.expectRevert(MurmurEscrow.PipelineNotActive.selector);
        escrow.createPipeline(PIPELINE_ID, agent, 2 * 1e6, 120, 1);
    }

    // ─── Audit H-1 + L-5 + L-2 — onlyOwner + zero-address + SLA floor ─────

    function test_createPipeline_rejectsNonOwner() public {
        vm.prank(randomCaller);
        vm.expectRevert(MurmurEscrow.NotOwner.selector);
        escrow.createPipeline(PIPELINE_ID, agent, 1 * 1e6, 120, 4);
    }

    function test_createPipeline_rejectsZeroAgent() public {
        vm.prank(owner);
        vm.expectRevert(MurmurEscrow.ZeroAddress.selector);
        escrow.createPipeline(PIPELINE_ID, address(0), 1 * 1e6, 120, 4);
    }

    function test_createPipeline_rejectsShortSla() public {
        vm.prank(owner);
        vm.expectRevert(MurmurEscrow.SlaMustBePositive.selector);
        escrow.createPipeline(PIPELINE_ID, agent, 1 * 1e6, 60, 4); // == cancel window
    }

    function test_setPipelineActive_ownerCanToggle() public {
        _createPipeline(1 * 1e6, 120, 4);
        vm.prank(owner);
        escrow.setPipelineActive(PIPELINE_ID, false);
        assertFalse(escrow.getPipeline(PIPELINE_ID).active);
        vm.prank(owner);
        escrow.setPipelineActive(PIPELINE_ID, true);
        assertTrue(escrow.getPipeline(PIPELINE_ID).active);
    }

    function test_setPipelineActive_rejectsAgent() public {
        _createPipeline(1 * 1e6, 120, 4);
        vm.prank(owner);
        escrow.setPipelineActive(PIPELINE_ID, false);
        // Audit H-1: agent can no longer reactivate a pipeline the owner
        // disabled. Pre-fix, the agent could squat and re-enable.
        vm.prank(agent);
        vm.expectRevert(MurmurEscrow.NotOwner.selector);
        escrow.setPipelineActive(PIPELINE_ID, true);
    }

    function test_setPipelineActive_rejectsRandom() public {
        _createPipeline(1 * 1e6, 120, 4);
        vm.prank(randomCaller);
        vm.expectRevert(MurmurEscrow.NotOwner.selector);
        escrow.setPipelineActive(PIPELINE_ID, false);
    }

    // ─── Happy path: request → commit → finalize ──────────────────────────

    function test_fullLifecycle_payoutsCorrect() public {
        _createPipeline(10 * 1e6, 120, 4);

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
        _createPipeline(10 * 1e6, 120, 4);
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
        _createPipeline(10 * 1e6, 120, 4);
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
        _createPipeline(10 * 1e6, 120, 4);
        vm.prank(buyer);
        bytes32 requestId = escrow.requestInference(PIPELINE_ID, bytes32(uint256(3)));

        // SLA = 120s; warp past it without any commit
        vm.warp(block.timestamp + 121);
        escrow.refund(requestId);

        // buyer made whole
        assertEq(usdc.balanceOf(buyer), 1_000 * 1e6);
        assertEq(usdc.balanceOf(address(escrow)), 0);

        MurmurEscrow.InferenceRequest memory r = escrow.getRequest(requestId);
        assertEq(uint8(r.state), uint8(MurmurEscrow.RequestState.Refunded));
    }

    function test_refund_rejectsBeforeSla() public {
        _createPipeline(10 * 1e6, 120, 4);
        vm.prank(buyer);
        bytes32 requestId = escrow.requestInference(PIPELINE_ID, bytes32(uint256(4)));

        // still inside SLA window
        vm.expectRevert(MurmurEscrow.BeforeFinalizeWindow.selector);
        escrow.refund(requestId);
    }

    function test_refund_rejectsAfterCommit() public {
        _createPipeline(10 * 1e6, 120, 4);
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
        _createPipeline(10 * 1e6, 120, 4);
        vm.prank(buyer);
        bytes32 requestId = escrow.requestInference(PIPELINE_ID, bytes32(uint256(9)));

        vm.warp(block.timestamp + 121);
        vm.prank(agent);
        vm.expectRevert(MurmurEscrow.PastDeadline.selector);
        escrow.commitSignal(requestId, bytes32(uint256(1)), bytes32(0));
    }

    function test_commitSignal_rejectsNonAgent() public {
        _createPipeline(10 * 1e6, 120, 4);
        vm.prank(buyer);
        bytes32 requestId = escrow.requestInference(PIPELINE_ID, bytes32(uint256(10)));

        vm.prank(buyer);
        vm.expectRevert(MurmurEscrow.NotPipelineOwner.selector);
        escrow.commitSignal(requestId, bytes32(uint256(1)), bytes32(0));
    }

    // ─── Pause ─────────────────────────────────────────────────────────────

    function test_pause_blocksRequests() public {
        _createPipeline(10 * 1e6, 120, 4);
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
        _createPipeline(100 * 1e6, 120, 4);
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

    // ─── Audit M-2 — protocolFeeBps snapshot per request ──────────────────

    /// Owner bumps the fee AFTER the buyer has paid; finalize must use the
    /// fee that was in effect at request time, not the new live value.
    function test_finalize_usesSnapshottedFee_notLive() public {
        // Pipeline starts at the default 5% fee.
        _createPipeline(100 * 1e6, 600, 4);
        vm.prank(buyer);
        bytes32 requestId = escrow.requestInference(PIPELINE_ID, bytes32(uint256(13)));

        // Owner bumps to 10% AFTER the request is in flight.
        vm.prank(owner);
        escrow.setProtocolFeeBps(1000);

        bytes memory sig = bytes("s");
        bytes32 nonce = bytes32(uint256(99));
        bytes32 commitHash = keccak256(abi.encodePacked(sig, nonce));
        vm.prank(agent);
        escrow.commitSignal(requestId, commitHash, bytes32(0));

        vm.warp(block.timestamp + 4 hours + 1);
        escrow.finalize(requestId, sig, nonce);

        // Pre-fix: fee would be 10% (10 USDC). Post-fix: 5% (5 USDC).
        assertEq(usdc.balanceOf(feeSink), 5 * 1e6);
        assertEq(usdc.balanceOf(agent), 95 * 1e6);
    }

    // ─── Audit M-1 — forceRefundCommitted recovery path ───────────────────

    function _setupCommittedRequest() internal returns (bytes32 requestId, uint64 committedAt) {
        _createPipeline(10 * 1e6, 120, 4);
        vm.prank(buyer);
        requestId = escrow.requestInference(PIPELINE_ID, bytes32(uint256(14)));
        bytes32 commitHash = keccak256(abi.encodePacked(bytes("never-revealed"), bytes32(uint256(0))));
        vm.prank(agent);
        escrow.commitSignal(requestId, commitHash, bytes32(0));
        committedAt = uint64(block.timestamp);
    }

    function test_forceRefundCommitted_happyPath() public {
        (bytes32 requestId, uint64 committedAt) = _setupCommittedRequest();
        // horizon = 4h; grace = 168h → 172h total
        vm.warp(uint256(committedAt) + 4 hours + 168 hours + 1);
        vm.prank(owner);
        escrow.forceRefundCommitted(requestId);

        assertEq(usdc.balanceOf(buyer), 1_000 * 1e6);
        assertEq(usdc.balanceOf(address(escrow)), 0);
        MurmurEscrow.InferenceRequest memory r = escrow.getRequest(requestId);
        assertEq(uint8(r.state), uint8(MurmurEscrow.RequestState.Refunded));
    }

    function test_forceRefundCommitted_beforeGrace_reverts() public {
        (bytes32 requestId, uint64 committedAt) = _setupCommittedRequest();
        // 1h short of grace
        vm.warp(uint256(committedAt) + 4 hours + 167 hours);
        vm.prank(owner);
        vm.expectRevert(MurmurEscrow.BeforeFinalizeWindow.selector);
        escrow.forceRefundCommitted(requestId);
    }

    function test_forceRefundCommitted_rejectsNonOwner() public {
        (bytes32 requestId, uint64 committedAt) = _setupCommittedRequest();
        vm.warp(uint256(committedAt) + 4 hours + 168 hours + 1);
        vm.prank(randomCaller);
        vm.expectRevert(MurmurEscrow.NotOwner.selector);
        escrow.forceRefundCommitted(requestId);
    }

    function test_forceRefundCommitted_rejectsPending() public {
        _createPipeline(10 * 1e6, 120, 4);
        vm.prank(buyer);
        bytes32 requestId = escrow.requestInference(PIPELINE_ID, bytes32(uint256(15)));
        // never committed → still Pending
        vm.warp(block.timestamp + 200 hours);
        vm.prank(owner);
        vm.expectRevert(MurmurEscrow.WrongState.selector);
        escrow.forceRefundCommitted(requestId);
    }

    // ─── Audit L-5 — zero-address admin guards ────────────────────────────

    function test_transferOwnership_rejectsZero() public {
        vm.prank(owner);
        vm.expectRevert(MurmurEscrow.ZeroAddress.selector);
        escrow.transferOwnership(address(0));
    }

    function test_setProtocolFeeSink_rejectsZero() public {
        vm.prank(owner);
        vm.expectRevert(MurmurEscrow.ZeroAddress.selector);
        escrow.setProtocolFeeSink(address(0));
    }

    function test_setProtocolFeeSink_rejectsSelf() public {
        vm.prank(owner);
        vm.expectRevert(MurmurEscrow.ZeroAddress.selector);
        escrow.setProtocolFeeSink(address(escrow));
    }
}
