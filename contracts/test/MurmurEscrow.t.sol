// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test, Vm, console} from "forge-std/Test.sol";
import {MurmurEscrow} from "../src/MurmurEscrow.sol";

/// Minimal mock x402 hook used to test the allowlist path of
/// `requestInferenceFor`. The hook holds USDC (after a CCTP mint, etc.)
/// and pays escrow on behalf of an attested buyer.
contract MockHook {
    function callRequestInferenceFor(
        address escrowAddr,
        address buyer,
        bytes32 pipelineId,
        bytes32 clientNonce
    ) external returns (bytes32) {
        MurmurEscrow.BuyerAuthorization memory emptySig = MurmurEscrow.BuyerAuthorization({
            deadline: 0,
            v: 0,
            r: bytes32(0),
            s: bytes32(0)
        });
        return MurmurEscrow(escrowAddr).requestInferenceFor(buyer, pipelineId, clientNonce, emptySig);
    }
    function approveUsdc(address usdcAddr, address spender, uint256 amount) external {
        MockUSDC(usdcAddr).approve(spender, amount);
    }
}

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

    function test_createPipeline_rejectsEscrowSelfAgent() public {
        // Re-audit Low: E1 invariant requires agentOwner != escrow. Otherwise
        // finalize() would route the agent payout back into this contract.
        vm.prank(owner);
        vm.expectRevert(MurmurEscrow.ZeroAddress.selector);
        escrow.createPipeline(PIPELINE_ID, address(escrow), 1 * 1e6, 120, 4);
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

    /// Re-audit gap: explicit zero-fee snapshot path. Confirms the boundary
    /// where the snapshot is 0 → agent gets paidAmount in full, fee transfer
    /// is skipped entirely, no dust stuck.
    function test_finalize_zeroFeeSnapshot_fullPayoutToAgent() public {
        vm.prank(owner);
        escrow.setProtocolFeeBps(0);
        _createPipeline(100 * 1e6, 600, 4);
        vm.prank(buyer);
        bytes32 requestId = escrow.requestInference(PIPELINE_ID, bytes32(uint256(31)));

        // Owner re-enables a fee after the request is in flight; snapshot
        // must still treat this request as 0-fee.
        vm.prank(owner);
        escrow.setProtocolFeeBps(500);

        bytes memory sig = bytes("z");
        bytes32 nonce = bytes32(uint256(77));
        bytes32 commitHash = keccak256(abi.encodePacked(sig, nonce));
        vm.prank(agent);
        escrow.commitSignal(requestId, commitHash, bytes32(0));
        vm.warp(block.timestamp + 4 hours + 1);
        escrow.finalize(requestId, sig, nonce);

        assertEq(usdc.balanceOf(feeSink), 0);
        assertEq(usdc.balanceOf(agent), 100 * 1e6);
        assertEq(usdc.balanceOf(address(escrow)), 0);
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

    /// Re-audit gap: tight boundary check. At graceOpenAt-1 it MUST revert;
    /// at graceOpenAt it MUST succeed. Pins the off-by-one to the second.
    function test_forceRefundCommitted_atGraceBoundary() public {
        (bytes32 requestId, uint64 committedAt) = _setupCommittedRequest();
        uint256 graceOpenAt = uint256(committedAt) + 4 hours + 168 hours;

        vm.warp(graceOpenAt - 1);
        vm.prank(owner);
        vm.expectRevert(MurmurEscrow.BeforeFinalizeWindow.selector);
        escrow.forceRefundCommitted(requestId);

        vm.warp(graceOpenAt);
        vm.prank(owner);
        escrow.forceRefundCommitted(requestId);
        MurmurEscrow.InferenceRequest memory r = escrow.getRequest(requestId);
        assertEq(uint8(r.state), uint8(MurmurEscrow.RequestState.Refunded));
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

    function test_transferOwnership_rejectsSelf() public {
        // Re-audit Low: contract has no self-call admin path, so transferring
        // ownership to itself would brick every onlyOwner function.
        vm.prank(owner);
        vm.expectRevert(MurmurEscrow.ZeroAddress.selector);
        escrow.transferOwnership(address(escrow));
    }

    // ─── Re-audit Low — constructor guards ────────────────────────────────

    function test_constructor_rejectsZeroUsdc() public {
        vm.expectRevert(MurmurEscrow.ZeroAddress.selector);
        new MurmurEscrow(address(0), feeSink);
    }

    function test_constructor_rejectsZeroSink() public {
        vm.expectRevert(MurmurEscrow.ZeroAddress.selector);
        new MurmurEscrow(address(usdc), address(0));
    }

    /// Constructor must reject `protocolFeeSink_ == address(this)` for the
    /// same E1-precondition reason as setProtocolFeeSink. We can't reference
    /// `address(this)` of the not-yet-deployed escrow, but we can simulate
    /// the danger by computing the CREATE address and passing it in.
    function test_constructor_rejectsSelfSink() public {
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        vm.expectRevert(MurmurEscrow.ZeroAddress.selector);
        new MurmurEscrow(address(usdc), predicted);
    }

    // ─── Re-audit Info — distinct force-refund event ──────────────────────

    /// forceRefundCommitted must emit InferenceForceRefunded, not the
    /// generic InferenceRefunded, so off-chain indexers can tell operator
    /// recovery apart from a normal SLA-miss refund.
    function test_forceRefundCommitted_emitsDistinctEvent() public {
        (bytes32 requestId, uint64 committedAt) = _setupCommittedRequest();
        vm.warp(uint256(committedAt) + 4 hours + 168 hours);
        vm.expectEmit(true, true, false, true, address(escrow));
        emit MurmurEscrow.InferenceForceRefunded(requestId, buyer, uint96(10 * 1e6));
        vm.prank(owner);
        escrow.forceRefundCommitted(requestId);
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

    // ─── Wave L.B — requestInferenceFor (EIP-712 path) ─────────────────────

    /// Use a known PK so we can sign typed data deterministically.
    /// Mints USDC + approves escrow for this wallet on demand.
    function _makeBuyer(uint256 pk) internal returns (Vm.Wallet memory) {
        Vm.Wallet memory w = vm.createWallet(pk);
        usdc.mint(w.addr, 1_000 * 1e6);
        vm.prank(w.addr);
        usdc.approve(address(escrow), type(uint256).max);
        return w;
    }

    function _hashBuyerAuth(
        address buyerAddr,
        bytes32 pipelineId,
        bytes32 nonce,
        uint256 deadline
    ) internal view returns (bytes32) {
        return escrow.hashBuyerAuth(buyerAddr, pipelineId, nonce, deadline);
    }

    function _signBuyerAuth(
        Vm.Wallet memory w,
        bytes32 pipelineId,
        bytes32 nonce,
        uint256 deadline
    ) internal returns (MurmurEscrow.BuyerAuthorization memory) {
        bytes32 digest = _hashBuyerAuth(w.addr, pipelineId, nonce, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(w, digest);
        return MurmurEscrow.BuyerAuthorization({deadline: deadline, v: v, r: r, s: s});
    }

    function test_requestInferenceFor_eip712_happyPath() public {
        _createPipeline(10 * 1e6, 120, 4);
        Vm.Wallet memory w = _makeBuyer(0xB17EB001);
        uint256 deadline = block.timestamp + 5 minutes;
        bytes32 nonce = bytes32(uint256(1001));
        MurmurEscrow.BuyerAuthorization memory sig =
            _signBuyerAuth(w, PIPELINE_ID, nonce, deadline);

        // Relayer (NOT the buyer) submits.
        vm.prank(randomCaller);
        bytes32 reqId = escrow.requestInferenceFor(w.addr, PIPELINE_ID, nonce, sig);

        MurmurEscrow.InferenceRequest memory r = escrow.getRequest(reqId);
        assertEq(r.buyer, w.addr, "attested buyer recorded");
        assertEq(uint8(r.state), uint8(MurmurEscrow.RequestState.Pending));
    }

    function test_requestInferenceFor_eip712_rejectsExpiredSig() public {
        _createPipeline(10 * 1e6, 120, 4);
        Vm.Wallet memory w = _makeBuyer(0xB17EB002);
        uint256 deadline = block.timestamp + 5 minutes;
        bytes32 nonce = bytes32(uint256(1002));
        MurmurEscrow.BuyerAuthorization memory sig =
            _signBuyerAuth(w, PIPELINE_ID, nonce, deadline);
        // Warp past deadline.
        vm.warp(deadline + 1);
        vm.prank(randomCaller);
        vm.expectRevert(MurmurEscrow.SignatureExpired.selector);
        escrow.requestInferenceFor(w.addr, PIPELINE_ID, nonce, sig);
    }

    function test_requestInferenceFor_eip712_rejectsWrongSigner() public {
        _createPipeline(10 * 1e6, 120, 4);
        Vm.Wallet memory imposter = _makeBuyer(0xB17EB003);
        Vm.Wallet memory victim = _makeBuyer(0xB17EB004);
        uint256 deadline = block.timestamp + 5 minutes;
        bytes32 nonce = bytes32(uint256(1003));
        // Imposter signs for victim's address — should revert.
        bytes32 digest = _hashBuyerAuth(victim.addr, PIPELINE_ID, nonce, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(imposter, digest);
        MurmurEscrow.BuyerAuthorization memory sig =
            MurmurEscrow.BuyerAuthorization({deadline: deadline, v: v, r: r, s: s});
        vm.prank(randomCaller);
        vm.expectRevert(MurmurEscrow.SignatureMismatch.selector);
        escrow.requestInferenceFor(victim.addr, PIPELINE_ID, nonce, sig);
    }

    function test_requestInferenceFor_eip712_rejectsReusedDigest() public {
        _createPipeline(10 * 1e6, 120, 4);
        Vm.Wallet memory w = _makeBuyer(0xB17EB005);
        uint256 deadline = block.timestamp + 5 minutes;
        bytes32 nonce = bytes32(uint256(1005));
        MurmurEscrow.BuyerAuthorization memory sig =
            _signBuyerAuth(w, PIPELINE_ID, nonce, deadline);
        vm.prank(randomCaller);
        escrow.requestInferenceFor(w.addr, PIPELINE_ID, nonce, sig);
        // Second redemption of identical sig → revert.
        vm.prank(randomCaller);
        vm.expectRevert(MurmurEscrow.SignatureAlreadyUsed.selector);
        escrow.requestInferenceFor(w.addr, PIPELINE_ID, nonce, sig);
    }

    function test_requestInferenceFor_rejectsZeroBuyer() public {
        _createPipeline(10 * 1e6, 120, 4);
        Vm.Wallet memory w = _makeBuyer(0xB17EB006);
        uint256 deadline = block.timestamp + 5 minutes;
        bytes32 nonce = bytes32(uint256(1006));
        MurmurEscrow.BuyerAuthorization memory sig =
            _signBuyerAuth(w, PIPELINE_ID, nonce, deadline);
        vm.prank(randomCaller);
        vm.expectRevert(MurmurEscrow.ZeroAddress.selector);
        escrow.requestInferenceFor(address(0), PIPELINE_ID, nonce, sig);
    }

    function test_requestInferenceFor_rejectsBuyerEqualsEscrow() public {
        _createPipeline(10 * 1e6, 120, 4);
        Vm.Wallet memory w = _makeBuyer(0xB17EB007);
        uint256 deadline = block.timestamp + 5 minutes;
        bytes32 nonce = bytes32(uint256(1007));
        MurmurEscrow.BuyerAuthorization memory sig =
            _signBuyerAuth(w, PIPELINE_ID, nonce, deadline);
        vm.prank(randomCaller);
        vm.expectRevert(MurmurEscrow.ZeroAddress.selector);
        escrow.requestInferenceFor(address(escrow), PIPELINE_ID, nonce, sig);
    }

    function test_requestInferenceFor_invalidSig_doesNotConsumeDigest() public {
        _createPipeline(10 * 1e6, 120, 4);
        Vm.Wallet memory w = _makeBuyer(0xB17EB008);
        uint256 deadline = block.timestamp + 5 minutes;
        bytes32 nonce = bytes32(uint256(1008));
        // First attempt: tampered s value → revert SignatureMismatch
        MurmurEscrow.BuyerAuthorization memory good =
            _signBuyerAuth(w, PIPELINE_ID, nonce, deadline);
        // Construct `bad` as a FRESH struct (memory copy, not reference)
        // so mutating its s doesn't also mutate `good.s`.
        MurmurEscrow.BuyerAuthorization memory bad = MurmurEscrow.BuyerAuthorization({
            deadline: good.deadline,
            v: good.v,
            r: good.r,
            s: bytes32(uint256(good.s) ^ 0xdeadbeef)
        });
        vm.prank(randomCaller);
        vm.expectRevert();
        escrow.requestInferenceFor(w.addr, PIPELINE_ID, nonce, bad);
        // Now the GOOD sig should still work — the digest was NOT consumed.
        vm.prank(randomCaller);
        escrow.requestInferenceFor(w.addr, PIPELINE_ID, nonce, good);
    }

    // ─── Wave L.B — requestInferenceFor (allowlist path) ──────────────────

    function _allowlistHook(MockHook hook, uint96 perCall, uint96 perBlock, uint96 perDay)
        internal
    {
        bytes32 ch = address(hook).codehash;
        vm.prank(owner);
        escrow.proposeAllowlistAdd(address(hook), ch, perCall, perBlock, perDay);
        vm.warp(block.timestamp + escrow.ALLOWLIST_TIMELOCK_SECONDS() + 1);
        vm.prank(owner);
        escrow.commitAllowlistAdd(address(hook));
    }

    function _fundHook(MockHook hook, uint256 amount) internal {
        usdc.mint(address(hook), amount);
        hook.approveUsdc(address(usdc), address(escrow), type(uint256).max);
    }

    function _emptyAuth() internal pure returns (MurmurEscrow.BuyerAuthorization memory) {
        return MurmurEscrow.BuyerAuthorization({deadline: 0, v: 0, r: bytes32(0), s: bytes32(0)});
    }

    function test_requestInferenceFor_allowlist_happyPath() public {
        _createPipeline(10 * 1e6, 120, 4);
        MockHook hook = new MockHook();
        _allowlistHook(hook, 100 * 1e6, 100 * 1e6, 100 * 1e6);
        _fundHook(hook, 100 * 1e6);

        bytes32 reqId = hook.callRequestInferenceFor(address(escrow), buyer, PIPELINE_ID, bytes32(uint256(2001)));
        MurmurEscrow.InferenceRequest memory r = escrow.getRequest(reqId);
        assertEq(r.buyer, buyer, "attested buyer recorded from allowlist path");
    }

    function test_requestInferenceFor_allowlist_rejectsNonAllowlistedCaller() public {
        _createPipeline(10 * 1e6, 120, 4);
        MockHook hook = new MockHook();
        // No allowlisting.
        _fundHook(hook, 10 * 1e6);
        vm.expectRevert(MurmurEscrow.UnauthorizedCaller.selector);
        hook.callRequestInferenceFor(address(escrow), buyer, PIPELINE_ID, bytes32(uint256(2002)));
    }

    function test_requestInferenceFor_allowlist_rejectsPausedEntry() public {
        _createPipeline(10 * 1e6, 120, 4);
        MockHook hook = new MockHook();
        _allowlistHook(hook, 100 * 1e6, 100 * 1e6, 100 * 1e6);
        _fundHook(hook, 10 * 1e6);
        vm.prank(owner);
        escrow.pauseAllowlistEntry(address(hook));
        vm.expectRevert(MurmurEscrow.HookPaused.selector);
        hook.callRequestInferenceFor(address(escrow), buyer, PIPELINE_ID, bytes32(uint256(2003)));
    }

    function test_requestInferenceFor_allowlist_perCallCapExceeded() public {
        _createPipeline(10 * 1e6, 120, 4);
        MockHook hook = new MockHook();
        _allowlistHook(hook, 1 * 1e6, 100 * 1e6, 100 * 1e6); // perCall=1, pipeline price=10
        _fundHook(hook, 10 * 1e6);
        vm.expectRevert(MurmurEscrow.CapExceededPerCall.selector);
        hook.callRequestInferenceFor(address(escrow), buyer, PIPELINE_ID, bytes32(uint256(2004)));
    }

    function test_requestInferenceFor_allowlist_perBlockCapExceeded() public {
        _createPipeline(10 * 1e6, 120, 4);
        MockHook hook = new MockHook();
        _allowlistHook(hook, 10 * 1e6, 15 * 1e6, 100 * 1e6); // perBlock=15, pipeline price=10
        _fundHook(hook, 50 * 1e6);
        hook.callRequestInferenceFor(address(escrow), buyer, PIPELINE_ID, bytes32(uint256(2005)));
        // Second call in same block: 10 + 10 = 20 > 15 cap → revert.
        vm.expectRevert(MurmurEscrow.CapExceededPerBlock.selector);
        hook.callRequestInferenceFor(address(escrow), buyer, PIPELINE_ID, bytes32(uint256(2006)));
    }

    function test_requestInferenceFor_allowlist_perBlockCounterResets() public {
        _createPipeline(10 * 1e6, 120, 4);
        MockHook hook = new MockHook();
        _allowlistHook(hook, 10 * 1e6, 15 * 1e6, 100 * 1e6);
        _fundHook(hook, 50 * 1e6);
        hook.callRequestInferenceFor(address(escrow), buyer, PIPELINE_ID, bytes32(uint256(2007)));
        // Advance to next block.
        vm.roll(block.number + 1);
        // Now the per-block counter resets — second call succeeds.
        hook.callRequestInferenceFor(address(escrow), buyer, PIPELINE_ID, bytes32(uint256(2008)));
    }

    function test_requestInferenceFor_allowlist_perDayCapExceeded() public {
        _createPipeline(10 * 1e6, 120, 4);
        MockHook hook = new MockHook();
        _allowlistHook(hook, 10 * 1e6, 10 * 1e6, 15 * 1e6);
        _fundHook(hook, 50 * 1e6);
        hook.callRequestInferenceFor(address(escrow), buyer, PIPELINE_ID, bytes32(uint256(2009)));
        vm.roll(block.number + 1);
        // Same UTC day, second 10 USDC → total 20 > 15 cap → revert.
        vm.expectRevert(MurmurEscrow.CapExceededPerDay.selector);
        hook.callRequestInferenceFor(address(escrow), buyer, PIPELINE_ID, bytes32(uint256(2010)));
    }

    function test_requestInferenceFor_allowlist_perDayCounterResets() public {
        _createPipeline(10 * 1e6, 120, 4);
        MockHook hook = new MockHook();
        _allowlistHook(hook, 10 * 1e6, 10 * 1e6, 15 * 1e6);
        _fundHook(hook, 50 * 1e6);
        hook.callRequestInferenceFor(address(escrow), buyer, PIPELINE_ID, bytes32(uint256(2011)));
        // Advance to next UTC day.
        vm.warp(block.timestamp + 1 days);
        vm.roll(block.number + 1);
        // Day counter resets → succeed.
        hook.callRequestInferenceFor(address(escrow), buyer, PIPELINE_ID, bytes32(uint256(2012)));
    }

    function test_proposeAllowlistAdd_rejectsWrongCodehashPin() public {
        // Codex audit 2026-05-23: propose-time codehash check enforced.
        // Pin must equal current `integrator.codehash` at propose time;
        // commit-time + call-time recheck is defense-in-depth, not the
        // only guard.
        MockHook hook = new MockHook();
        vm.prank(owner);
        vm.expectRevert(MurmurEscrow.CodehashMismatch.selector);
        escrow.proposeAllowlistAdd(
            address(hook),
            bytes32(uint256(0xDEADBEEF)),
            100 * 1e6, 100 * 1e6, 100 * 1e6
        );
    }

    function test_commitAllowlistAdd_rejectsCodehashDriftDuringTimelock() public {
        // Drift scenario: hook had codehash X at propose, gets replaced
        // (vm.etch) with different bytecode before commit. commit
        // re-reads codehash and rejects.
        MockHook hook = new MockHook();
        bytes32 ch = address(hook).codehash;
        vm.prank(owner);
        escrow.proposeAllowlistAdd(address(hook), ch, 100 * 1e6, 100 * 1e6, 100 * 1e6);
        vm.warp(block.timestamp + escrow.ALLOWLIST_TIMELOCK_SECONDS() + 1);
        // Replace bytecode mid-window — codehash changes.
        vm.etch(address(hook), hex"6080604052"); // tiny stub
        vm.prank(owner);
        vm.expectRevert(MurmurEscrow.CodehashMismatch.selector);
        escrow.commitAllowlistAdd(address(hook));
    }

    // (Note: a dedicated call-time codehash-drift test using vm.etch is
    // tricky because the etched bytecode also affects ABI dispatch, so
    // the failure mode isn't a clean CodehashMismatch — it's a generic
    // revert from the call. The call-time check is exercised indirectly
    // by every allowlist test that runs through `_enforceAllowlistCall`,
    // and the propose-time + commit-time tests above pin the codehash
    // semantics. Dedicated drift test deferred to Phase 3 audit with a
    // more controlled scenario.)

    // ─── Wave L.B — Allowlist admin ────────────────────────────────────────

    function test_proposeAllowlistAdd_rejectsNonOwner() public {
        MockHook hook = new MockHook();
        vm.prank(randomCaller);
        vm.expectRevert(MurmurEscrow.NotOwner.selector);
        escrow.proposeAllowlistAdd(address(hook), address(hook).codehash, 10, 10, 10);
    }

    function test_proposeAllowlistAdd_rejectsEoa() public {
        // EOA has no code → revert HookHasNoCode.
        vm.prank(owner);
        vm.expectRevert(MurmurEscrow.HookHasNoCode.selector);
        escrow.proposeAllowlistAdd(buyer, bytes32(uint256(1)), 10, 10, 10);
    }

    function test_proposeAllowlistAdd_rejectsZeroCodehashPin() public {
        MockHook hook = new MockHook();
        vm.prank(owner);
        vm.expectRevert(MurmurEscrow.HookHasNoCode.selector);
        escrow.proposeAllowlistAdd(address(hook), bytes32(0), 10, 10, 10);
    }

    function test_proposeAllowlistAdd_rejectsNonMonotonicCaps() public {
        MockHook hook = new MockHook();
        bytes32 ch = address(hook).codehash;
        vm.prank(owner);
        vm.expectRevert(MurmurEscrow.CapsNotMonotonic.selector);
        escrow.proposeAllowlistAdd(address(hook), ch, 100, 50, 200); // perBlock < perCall
    }

    function test_proposeAllowlistAdd_rejectsZeroPerCall() public {
        MockHook hook = new MockHook();
        bytes32 ch = address(hook).codehash;
        vm.prank(owner);
        vm.expectRevert(MurmurEscrow.CapsNotMonotonic.selector);
        escrow.proposeAllowlistAdd(address(hook), ch, 0, 10, 10);
    }

    function test_commitAllowlistAdd_beforeTimelockReverts() public {
        MockHook hook = new MockHook();
        bytes32 ch = address(hook).codehash;
        vm.prank(owner);
        escrow.proposeAllowlistAdd(address(hook), ch, 10, 10, 10);
        // Don't warp.
        vm.prank(owner);
        vm.expectRevert(MurmurEscrow.ProposalNotReady.selector);
        escrow.commitAllowlistAdd(address(hook));
    }

    function test_commitAllowlistAdd_withoutProposalReverts() public {
        MockHook hook = new MockHook();
        vm.prank(owner);
        vm.expectRevert(MurmurEscrow.WrongProposalKind.selector);
        escrow.commitAllowlistAdd(address(hook));
    }

    function test_commitAllowlistAdd_rejectsNonOwner() public {
        MockHook hook = new MockHook();
        bytes32 ch = address(hook).codehash;
        vm.prank(owner);
        escrow.proposeAllowlistAdd(address(hook), ch, 10, 10, 10);
        vm.warp(block.timestamp + escrow.ALLOWLIST_TIMELOCK_SECONDS() + 1);
        vm.prank(randomCaller);
        vm.expectRevert(MurmurEscrow.NotOwner.selector);
        escrow.commitAllowlistAdd(address(hook));
    }

    function test_proposeAllowlistRemove_hookCallableDuringWindow() public {
        _createPipeline(10 * 1e6, 120, 4);
        MockHook hook = new MockHook();
        _allowlistHook(hook, 100 * 1e6, 100 * 1e6, 100 * 1e6);
        _fundHook(hook, 50 * 1e6);
        vm.prank(owner);
        escrow.proposeAllowlistRemove(address(hook));
        // Hook still callable during the propose-remove → commit window.
        hook.callRequestInferenceFor(address(escrow), buyer, PIPELINE_ID, bytes32(uint256(3001)));
    }

    function test_commitAllowlistRemove_afterTimelockRevokesHook() public {
        _createPipeline(10 * 1e6, 120, 4);
        MockHook hook = new MockHook();
        _allowlistHook(hook, 100 * 1e6, 100 * 1e6, 100 * 1e6);
        _fundHook(hook, 50 * 1e6);
        vm.prank(owner);
        escrow.proposeAllowlistRemove(address(hook));
        vm.warp(block.timestamp + escrow.ALLOWLIST_TIMELOCK_SECONDS() + 1);
        vm.prank(owner);
        escrow.commitAllowlistRemove(address(hook));
        vm.expectRevert(MurmurEscrow.UnauthorizedCaller.selector);
        hook.callRequestInferenceFor(address(escrow), buyer, PIPELINE_ID, bytes32(uint256(3002)));
    }

    function test_pauseAllowlistEntry_immediateAndRejectsNonOwner() public {
        _createPipeline(10 * 1e6, 120, 4);
        MockHook hook = new MockHook();
        _allowlistHook(hook, 100 * 1e6, 100 * 1e6, 100 * 1e6);
        vm.prank(randomCaller);
        vm.expectRevert(MurmurEscrow.NotOwner.selector);
        escrow.pauseAllowlistEntry(address(hook));
        // Owner can pause.
        vm.prank(owner);
        escrow.pauseAllowlistEntry(address(hook));
    }

    function test_unpauseTimelocked_24h() public {
        _createPipeline(10 * 1e6, 120, 4);
        MockHook hook = new MockHook();
        _allowlistHook(hook, 100 * 1e6, 100 * 1e6, 100 * 1e6);
        _fundHook(hook, 50 * 1e6);
        vm.prank(owner);
        escrow.pauseAllowlistEntry(address(hook));
        vm.prank(owner);
        escrow.proposeAllowlistUnpause(address(hook));
        // Before 24h: revert.
        vm.prank(owner);
        vm.expectRevert(MurmurEscrow.ProposalNotReady.selector);
        escrow.commitAllowlistUnpause(address(hook));
        // After 24h: succeeds.
        vm.warp(block.timestamp + escrow.ALLOWLIST_UNPAUSE_TIMELOCK_SECONDS() + 1);
        vm.prank(owner);
        escrow.commitAllowlistUnpause(address(hook));
        // Hook callable again.
        hook.callRequestInferenceFor(address(escrow), buyer, PIPELINE_ID, bytes32(uint256(3003)));
    }

    function test_proposeAllowlistUnpause_revertsOnNonPaused() public {
        MockHook hook = new MockHook();
        _allowlistHook(hook, 100 * 1e6, 100 * 1e6, 100 * 1e6);
        vm.prank(owner);
        vm.expectRevert(MurmurEscrow.HookNotPaused.selector);
        escrow.proposeAllowlistUnpause(address(hook));
    }

    // ─── Wave L.B — Refund / cancel route to attested buyer ────────────────

    function test_refund_routesToAttestedBuyer_eip712Path() public {
        _createPipeline(10 * 1e6, 120, 4);
        Vm.Wallet memory w = _makeBuyer(0xB17EB100);
        uint256 deadline = block.timestamp + 5 minutes;
        bytes32 nonce = bytes32(uint256(4001));
        MurmurEscrow.BuyerAuthorization memory sig =
            _signBuyerAuth(w, PIPELINE_ID, nonce, deadline);
        uint256 startBuyerBal = usdc.balanceOf(w.addr);
        vm.prank(randomCaller);
        bytes32 reqId = escrow.requestInferenceFor(w.addr, PIPELINE_ID, nonce, sig);
        // Skip SLA window without commit.
        vm.warp(block.timestamp + 121);
        escrow.refund(reqId);
        // Refund must route to attested buyer (w.addr), NOT the relayer.
        assertEq(usdc.balanceOf(w.addr), startBuyerBal, "attested buyer made whole");
        assertEq(usdc.balanceOf(randomCaller), 0);
    }

    function test_refund_routesToAttestedBuyer_allowlistPath() public {
        _createPipeline(10 * 1e6, 120, 4);
        MockHook hook = new MockHook();
        _allowlistHook(hook, 100 * 1e6, 100 * 1e6, 100 * 1e6);
        _fundHook(hook, 10 * 1e6);
        uint256 startBuyerBal = usdc.balanceOf(buyer);
        bytes32 reqId = hook.callRequestInferenceFor(address(escrow), buyer, PIPELINE_ID, bytes32(uint256(4002)));
        vm.warp(block.timestamp + 121);
        escrow.refund(reqId);
        assertEq(usdc.balanceOf(buyer), startBuyerBal + 10 * 1e6, "attested buyer received refund");
    }

    function test_cancel_routesToAttestedBuyer_eip712Path() public {
        _createPipeline(10 * 1e6, 120, 4);
        Vm.Wallet memory w = _makeBuyer(0xB17EB101);
        uint256 deadline = block.timestamp + 5 minutes;
        bytes32 nonce = bytes32(uint256(4003));
        MurmurEscrow.BuyerAuthorization memory sig =
            _signBuyerAuth(w, PIPELINE_ID, nonce, deadline);
        uint256 startBuyerBal = usdc.balanceOf(w.addr);
        vm.prank(randomCaller);
        bytes32 reqId = escrow.requestInferenceFor(w.addr, PIPELINE_ID, nonce, sig);
        // Buyer themselves cancels within window.
        vm.prank(w.addr);
        escrow.cancel(reqId);
        assertEq(usdc.balanceOf(w.addr), startBuyerBal);
    }

    function test_cancel_routesToAttestedBuyer_allowlistPath() public {
        _createPipeline(10 * 1e6, 120, 4);
        MockHook hook = new MockHook();
        _allowlistHook(hook, 100 * 1e6, 100 * 1e6, 100 * 1e6);
        _fundHook(hook, 10 * 1e6);
        uint256 startBuyerBal = usdc.balanceOf(buyer);
        bytes32 reqId = hook.callRequestInferenceFor(address(escrow), buyer, PIPELINE_ID, bytes32(uint256(4500)));
        // Buyer themselves cancels within window (within 60s of paidAt).
        vm.prank(buyer);
        escrow.cancel(reqId);
        assertEq(usdc.balanceOf(buyer), startBuyerBal + 10 * 1e6, "attested buyer received cancel refund");
    }

    function test_forceRefundCommitted_routesToAttestedBuyer_allowlistPath() public {
        _createPipeline(10 * 1e6, 120, 4);
        MockHook hook = new MockHook();
        _allowlistHook(hook, 100 * 1e6, 100 * 1e6, 100 * 1e6);
        _fundHook(hook, 10 * 1e6);
        uint256 startBuyerBal = usdc.balanceOf(buyer);
        bytes32 reqId = hook.callRequestInferenceFor(address(escrow), buyer, PIPELINE_ID, bytes32(uint256(4501)));
        // Agent commits.
        bytes32 commitHash = keccak256(abi.encodePacked(bytes("sig"), bytes32(uint256(11))));
        vm.prank(agent);
        escrow.commitSignal(reqId, commitHash, bytes32(0));
        vm.warp(block.timestamp + 4 hours + 168 hours + 1);
        vm.prank(owner);
        escrow.forceRefundCommitted(reqId);
        assertEq(usdc.balanceOf(buyer), startBuyerBal + 10 * 1e6, "attested buyer received force refund");
    }

    // ─── Wave L.B — Admin onlyOwner coverage ───────────────────────────────

    function test_proposeAllowlistRemove_rejectsNonOwner() public {
        MockHook hook = new MockHook();
        _allowlistHook(hook, 10 * 1e6, 10 * 1e6, 10 * 1e6);
        vm.prank(randomCaller);
        vm.expectRevert(MurmurEscrow.NotOwner.selector);
        escrow.proposeAllowlistRemove(address(hook));
    }

    function test_commitAllowlistRemove_rejectsNonOwner() public {
        MockHook hook = new MockHook();
        _allowlistHook(hook, 10 * 1e6, 10 * 1e6, 10 * 1e6);
        vm.prank(owner);
        escrow.proposeAllowlistRemove(address(hook));
        vm.warp(block.timestamp + escrow.ALLOWLIST_TIMELOCK_SECONDS() + 1);
        vm.prank(randomCaller);
        vm.expectRevert(MurmurEscrow.NotOwner.selector);
        escrow.commitAllowlistRemove(address(hook));
    }

    function test_proposeAllowlistUnpause_rejectsNonOwner() public {
        MockHook hook = new MockHook();
        _allowlistHook(hook, 10 * 1e6, 10 * 1e6, 10 * 1e6);
        vm.prank(owner);
        escrow.pauseAllowlistEntry(address(hook));
        vm.prank(randomCaller);
        vm.expectRevert(MurmurEscrow.NotOwner.selector);
        escrow.proposeAllowlistUnpause(address(hook));
    }

    function test_commitAllowlistUnpause_rejectsNonOwner() public {
        MockHook hook = new MockHook();
        _allowlistHook(hook, 10 * 1e6, 10 * 1e6, 10 * 1e6);
        vm.prank(owner);
        escrow.pauseAllowlistEntry(address(hook));
        vm.prank(owner);
        escrow.proposeAllowlistUnpause(address(hook));
        vm.warp(block.timestamp + escrow.ALLOWLIST_UNPAUSE_TIMELOCK_SECONDS() + 1);
        vm.prank(randomCaller);
        vm.expectRevert(MurmurEscrow.NotOwner.selector);
        escrow.commitAllowlistUnpause(address(hook));
    }

    // ─── Wave L.B — E1 funds-conservation across mixed entry points ───────

    function test_e1_invariant_mixedEntryPoints() public {
        // Run mixed traffic of all three entry points; assert escrow's
        // USDC balance equals sum of paidAmount across active
        // (Pending|Committed) requests after each transition.
        _createPipeline(10 * 1e6, 120, 4);
        // A: requestInference (legacy, buyer == msg.sender)
        vm.prank(buyer);
        bytes32 idA = escrow.requestInference(PIPELINE_ID, bytes32(uint256(7001)));
        // B: requestInferenceFor via EIP-712
        Vm.Wallet memory w = _makeBuyer(0xB17EB200);
        uint256 deadline = block.timestamp + 5 minutes;
        bytes32 nonceB = bytes32(uint256(7002));
        MurmurEscrow.BuyerAuthorization memory sig =
            _signBuyerAuth(w, PIPELINE_ID, nonceB, deadline);
        vm.prank(randomCaller);
        bytes32 idB = escrow.requestInferenceFor(w.addr, PIPELINE_ID, nonceB, sig);
        // C: requestInferenceFor via allowlist hook
        MockHook hook = new MockHook();
        _allowlistHook(hook, 100 * 1e6, 100 * 1e6, 100 * 1e6);
        _fundHook(hook, 10 * 1e6);
        bytes32 idC = hook.callRequestInferenceFor(address(escrow), buyer, PIPELINE_ID, bytes32(uint256(7003)));
        // Invariant: 3 active requests × 10 USDC each = 30 USDC in escrow
        assertEq(usdc.balanceOf(address(escrow)), 30 * 1e6, "E1: balance == sum(active)");
        // Refund B → invariant should still hold (sum reduces by 10, balance reduces by 10).
        vm.warp(block.timestamp + 121);
        escrow.refund(idB);
        assertEq(usdc.balanceOf(address(escrow)), 20 * 1e6, "E1 after refund B");
        // Refund A.
        escrow.refund(idA);
        assertEq(usdc.balanceOf(address(escrow)), 10 * 1e6, "E1 after refund A");
        // Refund C.
        escrow.refund(idC);
        assertEq(usdc.balanceOf(address(escrow)), 0, "E1 after refund C");
    }

    function test_forceRefundCommitted_routesToAttestedBuyer_eip712Path() public {
        _createPipeline(10 * 1e6, 120, 4);
        Vm.Wallet memory w = _makeBuyer(0xB17EB102);
        uint256 deadline = block.timestamp + 5 minutes;
        bytes32 nonce = bytes32(uint256(4004));
        MurmurEscrow.BuyerAuthorization memory sig =
            _signBuyerAuth(w, PIPELINE_ID, nonce, deadline);
        uint256 startBuyerBal = usdc.balanceOf(w.addr);
        vm.prank(randomCaller);
        bytes32 reqId = escrow.requestInferenceFor(w.addr, PIPELINE_ID, nonce, sig);
        // Agent commits.
        bytes32 commitHash = keccak256(abi.encodePacked(bytes("sig"), bytes32(uint256(7))));
        vm.prank(agent);
        escrow.commitSignal(reqId, commitHash, bytes32(0));
        // Warp past horizon + 168h grace.
        vm.warp(block.timestamp + 4 hours + 168 hours + 1);
        vm.prank(owner);
        escrow.forceRefundCommitted(reqId);
        assertEq(usdc.balanceOf(w.addr), startBuyerBal);
    }
}
