// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "forge-std/interfaces/IERC20.sol";

/// @title MurmurEscrow — paid-inference escrow for Murmur Pipelines v0.2
/// @notice Sits between x402 USDC settlement and agent payouts so we can
///         enforce SLA timeouts, commit-reveal binding, and refunds. The x402
///         facilitator settles a buyer's USDC into this contract (payTo = this
///         address); the off-chain Murmur daemon then drives the inference
///         lifecycle by calling commitSignal / finalize / refund.
/// @dev    Single-stream invariant: the off-chain daemon publishes the SAME
///         committed signal to the buyer AND to the public ranked stream;
///         this contract only enforces escrow, payout, and timeout — not
///         distribution-equality (that's enforced by the daemon's commit
///         publishing logic and verified post-hoc via EAS attestations).
contract MurmurEscrow {
    // ─── Errors (gas-efficient revert reasons) ─────────────────────────────

    error NotOwner();
    error Paused();
    error Reentrancy();
    error PipelineNotFound();
    error PipelineNotActive();
    error PriceMustBePositive();
    error SlaMustBePositive();
    error HorizonMustBePositive();
    error FeeTooHigh();
    error UsdcTransferFailed();
    error UsdcReturnFailed();
    error RequestNotFound();
    error WrongState();
    error PastDeadline();
    error BeforeFinalizeWindow();
    error NotPipelineOwner();
    error NotBuyer();
    error CancelWindowClosed();
    error CommitMismatch();
    error MerkleRootEmpty();
    error BatchAlreadySubmitted();
    error ZeroAddress();

    // ─── Constants ─────────────────────────────────────────────────────────

    uint16 public constant MAX_PROTOCOL_FEE_BPS = 1000; // 10% hard cap
    uint16 public constant DEFAULT_PROTOCOL_FEE_BPS = 500; // 5%
    uint64 public constant CANCEL_WINDOW_SECONDS = 60;
    // Audit M-1: how long after the finalize window opens before the owner
    // can force-refund a Committed request whose agent never produced a
    // valid reveal. 7 days is enough for "agent forgot" to be exhausted.
    uint64 public constant COMMITTED_REFUND_GRACE_HOURS = 168;

    // ─── Inference request lifecycle ───────────────────────────────────────

    enum RequestState {
        None,
        Pending,    // paid, awaiting agent commit
        Committed,  // agent committed signal hash, awaiting finalize
        Finalized,  // signal revealed, paid out
        Refunded,
        Canceled
    }

    // ─── Storage ───────────────────────────────────────────────────────────

    IERC20 public immutable USDC;
    address public owner;
    address public protocolFeeSink;
    uint16 public protocolFeeBps;
    bool public paused;
    uint256 private _locked;

    struct Pipeline {
        address agentOwner;     // payout recipient
        uint96 priceUsdc;       // 6-dec USDC, fits in uint96
        uint32 slaSeconds;      // commit must arrive ≤ this many seconds after request
        uint32 horizonHours;    // finalize allowed after this many hours from commit
        bool active;
    }

    struct InferenceRequest {
        bytes32 pipelineId;
        address buyer;
        uint96 paidAmount;
        uint64 paidAt;
        uint64 slaDeadline;     // paid_at + sla_seconds
        bytes32 commitHash;     // set on commitSignal
        bytes32 marketDataCutoff; // operator-declared input freshness anchor
        uint64 committedAt;
        RequestState state;
        // Audit M-2: snapshotted at request time; finalize uses this value
        // so owner cannot change fee bps mid-flight.
        uint16 protocolFeeBps;
    }

    /// pipelineId => Pipeline
    mapping(bytes32 => Pipeline) public pipelines;
    /// requestId => InferenceRequest
    mapping(bytes32 => InferenceRequest) public requests;
    /// batchId => Merkle root (for hourly receipt anchoring)
    mapping(uint256 => bytes32) public merkleRoots;
    /// per-pipeline counter for deterministic requestId derivation
    mapping(bytes32 => uint256) public requestCount;

    // ─── Events ────────────────────────────────────────────────────────────

    event OwnerTransferred(address indexed previousOwner, address indexed newOwner);
    event PipelineCreated(
        bytes32 indexed pipelineId,
        address indexed agentOwner,
        uint96 priceUsdc,
        uint32 slaSeconds,
        uint32 horizonHours
    );
    event PipelineUpdated(bytes32 indexed pipelineId, bool active);
    event InferenceRequested(
        bytes32 indexed requestId,
        bytes32 indexed pipelineId,
        address indexed buyer,
        uint96 paidAmount,
        uint64 slaDeadline
    );
    event SignalCommitted(
        bytes32 indexed requestId,
        bytes32 commitHash,
        bytes32 marketDataCutoff,
        uint64 committedAt
    );
    event InferenceFinalized(
        bytes32 indexed requestId,
        address indexed agentOwner,
        uint96 agentPayout,
        uint96 protocolFee
    );
    event InferenceRefunded(bytes32 indexed requestId, address indexed buyer, uint96 amount);
    event InferenceCanceled(bytes32 indexed requestId, address indexed buyer, uint96 amount);
    event MerkleRootSubmitted(uint256 indexed batchId, bytes32 root);
    event ProtocolFeeUpdated(uint16 oldBps, uint16 newBps);
    event ProtocolFeeSinkUpdated(address oldSink, address newSink);
    event PausedSet(bool paused);

    // ─── Modifiers ─────────────────────────────────────────────────────────

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    modifier nonReentrant() {
        if (_locked == 1) revert Reentrancy();
        _locked = 1;
        _;
        _locked = 0;
    }

    // ─── Construction ──────────────────────────────────────────────────────

    constructor(address usdc_, address protocolFeeSink_) {
        USDC = IERC20(usdc_);
        owner = msg.sender;
        protocolFeeSink = protocolFeeSink_;
        protocolFeeBps = DEFAULT_PROTOCOL_FEE_BPS;
        emit OwnerTransferred(address(0), msg.sender);
        emit ProtocolFeeUpdated(0, DEFAULT_PROTOCOL_FEE_BPS);
        emit ProtocolFeeSinkUpdated(address(0), protocolFeeSink_);
    }

    // ─── Pipeline management ───────────────────────────────────────────────

    /// @notice Create a pipeline. Off-chain daemon enforces rank-gate; this
    ///         contract just records the on-chain pipeline definition and
    ///         payout target.
    /// @dev Audit H-1: must be onlyOwner. Without this gate, anyone could
    ///      squat a pipelineId before the legit operator created it and
    ///      redirect every buyer's payout via the stored agentOwner field.
    function createPipeline(
        bytes32 pipelineId,
        address agentOwner,
        uint96 priceUsdc,
        uint32 slaSeconds,
        uint32 horizonHours
    ) external onlyOwner whenNotPaused {
        if (agentOwner == address(0)) revert ZeroAddress();
        // Re-audit Low: E1 invariant requires agentOwner != escrow. Otherwise
        // a finalize() would route the agent payout back into this contract,
        // leaving escrow balance > sum(active paidAmount).
        if (agentOwner == address(this)) revert ZeroAddress();
        if (priceUsdc == 0) revert PriceMustBePositive();
        if (slaSeconds == 0) revert SlaMustBePositive();
        if (horizonHours == 0) revert HorizonMustBePositive();
        // Audit L-2: SLA must exceed the cancel window so an agent can't be
        // lured into committing only to be cancelled.
        if (slaSeconds <= CANCEL_WINDOW_SECONDS) revert SlaMustBePositive();
        Pipeline storage p = pipelines[pipelineId];
        if (p.agentOwner != address(0)) revert PipelineNotActive(); // already exists
        p.agentOwner = agentOwner;
        p.priceUsdc = priceUsdc;
        p.slaSeconds = slaSeconds;
        p.horizonHours = horizonHours;
        p.active = true;
        emit PipelineCreated(pipelineId, agentOwner, priceUsdc, slaSeconds, horizonHours);
    }

    /// @dev Audit H-1: was previously callable by the pipeline's agentOwner,
    ///      which let a squatting agent re-activate a pipeline the owner had
    ///      disabled. Now strictly onlyOwner.
    function setPipelineActive(bytes32 pipelineId, bool active_) external onlyOwner {
        Pipeline storage p = pipelines[pipelineId];
        if (p.agentOwner == address(0)) revert PipelineNotFound();
        p.active = active_;
        emit PipelineUpdated(pipelineId, active_);
    }

    // ─── Inference lifecycle ───────────────────────────────────────────────

    /// @notice Buyer pays for an inference. USDC must be pre-approved.
    function requestInference(bytes32 pipelineId, bytes32 clientNonce)
        external
        whenNotPaused
        nonReentrant
        returns (bytes32 requestId)
    {
        Pipeline storage p = pipelines[pipelineId];
        if (p.agentOwner == address(0)) revert PipelineNotFound();
        if (!p.active) revert PipelineNotActive();

        // Pull USDC from msg.sender. If x402 is the caller, msg.sender is the
        // x402 facilitator; if a wallet is paying directly, msg.sender is
        // the buyer. We treat tx.origin == msg.sender as "buyer = sender" for
        // refund routing; otherwise refund routes to the recorded `buyer`.
        if (!USDC.transferFrom(msg.sender, address(this), p.priceUsdc)) {
            revert UsdcTransferFailed();
        }

        uint256 ctr = requestCount[pipelineId]++;
        requestId = keccak256(
            abi.encodePacked(pipelineId, msg.sender, clientNonce, ctr)
        );
        // Defensive: ensure no collision
        if (requests[requestId].state != RequestState.None) revert WrongState();

        uint64 nowTs = uint64(block.timestamp);
        requests[requestId] = InferenceRequest({
            pipelineId: pipelineId,
            buyer: msg.sender,
            paidAmount: p.priceUsdc,
            paidAt: nowTs,
            slaDeadline: nowTs + p.slaSeconds,
            commitHash: bytes32(0),
            marketDataCutoff: bytes32(0),
            committedAt: 0,
            state: RequestState.Pending,
            // Audit M-2: snapshot fee bps; subsequent setProtocolFeeBps
            // calls do not affect this request.
            protocolFeeBps: protocolFeeBps
        });

        emit InferenceRequested(
            requestId,
            pipelineId,
            msg.sender,
            p.priceUsdc,
            nowTs + p.slaSeconds
        );
    }

    /// @notice Agent owner publishes the commit hash for a pending request.
    /// @dev    Must arrive before SLA deadline. Single commit per request.
    ///         The off-chain daemon also publishes this commit to the public
    ///         ranked stream — that's where the single-stream invariant is
    ///         enforced; this contract only enforces "did the commit arrive
    ///         in time" and "does finalize match the commit."
    function commitSignal(
        bytes32 requestId,
        bytes32 commitHash,
        bytes32 marketDataCutoff
    ) external whenNotPaused {
        InferenceRequest storage r = requests[requestId];
        if (r.state != RequestState.Pending) revert WrongState();
        Pipeline storage p = pipelines[r.pipelineId];
        if (msg.sender != p.agentOwner) revert NotPipelineOwner();
        if (block.timestamp > r.slaDeadline) revert PastDeadline();
        r.commitHash = commitHash;
        r.marketDataCutoff = marketDataCutoff;
        r.committedAt = uint64(block.timestamp);
        r.state = RequestState.Committed;
        emit SignalCommitted(requestId, commitHash, marketDataCutoff, r.committedAt);
    }

    /// @notice Reveal the signal. Anyone may call after horizon has elapsed.
    /// @dev    Verifies keccak256(signal ‖ nonce) == stored commitHash.
    ///         Pays 95% (or current fee bps) to agent, rest to protocol sink.
    function finalize(bytes32 requestId, bytes calldata signal, bytes32 nonce)
        external
        nonReentrant
    {
        InferenceRequest storage r = requests[requestId];
        if (r.state != RequestState.Committed) revert WrongState();
        Pipeline storage p = pipelines[r.pipelineId];
        uint64 finalizeOpenAt = r.committedAt + uint64(p.horizonHours) * 3600;
        if (block.timestamp < finalizeOpenAt) revert BeforeFinalizeWindow();
        if (keccak256(abi.encodePacked(signal, nonce)) != r.commitHash) {
            revert CommitMismatch();
        }

        // Audit M-2: use the snapshotted fee, NOT live storage.
        uint96 fee = uint96((uint256(r.paidAmount) * r.protocolFeeBps) / 10_000);
        uint96 agentPayout = r.paidAmount - fee;
        r.state = RequestState.Finalized;

        if (fee > 0) {
            if (!USDC.transfer(protocolFeeSink, fee)) revert UsdcReturnFailed();
        }
        if (!USDC.transfer(p.agentOwner, agentPayout)) revert UsdcReturnFailed();

        emit InferenceFinalized(requestId, p.agentOwner, agentPayout, fee);
    }

    /// @notice Refund a pending request whose SLA has elapsed without commit.
    function refund(bytes32 requestId) external nonReentrant {
        InferenceRequest storage r = requests[requestId];
        if (r.state != RequestState.Pending) revert WrongState();
        if (block.timestamp <= r.slaDeadline) revert BeforeFinalizeWindow();
        r.state = RequestState.Refunded;
        if (!USDC.transfer(r.buyer, r.paidAmount)) revert UsdcReturnFailed();
        emit InferenceRefunded(requestId, r.buyer, r.paidAmount);
    }

    /// @notice Owner-gated recovery for Committed requests whose agent never
    ///         produced a valid reveal. Pre-fix, buyer funds for such
    ///         requests were stuck forever — refund/cancel require Pending,
    ///         finalize requires a matching reveal. After
    ///         COMMITTED_REFUND_GRACE_HOURS beyond the finalize-open time,
    ///         the owner can refund the buyer; the agent's commit is dropped.
    /// @dev    Audit M-1. Owner-gated (not permissionless) so a third party
    ///         cannot race a slow but legitimate finalize. Grace = horizon +
    ///         7 days; comfortably outside any reasonable reveal tail.
    function forceRefundCommitted(bytes32 requestId) external onlyOwner nonReentrant {
        InferenceRequest storage r = requests[requestId];
        if (r.state != RequestState.Committed) revert WrongState();
        Pipeline storage p = pipelines[r.pipelineId];
        uint64 graceOpenAt = r.committedAt
            + uint64(p.horizonHours) * 3600
            + COMMITTED_REFUND_GRACE_HOURS * 3600;
        if (block.timestamp < graceOpenAt) revert BeforeFinalizeWindow();
        r.state = RequestState.Refunded;
        if (!USDC.transfer(r.buyer, r.paidAmount)) revert UsdcReturnFailed();
        emit InferenceRefunded(requestId, r.buyer, r.paidAmount);
    }

    /// @notice Buyer cancels within first CANCEL_WINDOW_SECONDS of request.
    function cancel(bytes32 requestId) external nonReentrant {
        InferenceRequest storage r = requests[requestId];
        if (r.state != RequestState.Pending) revert WrongState();
        if (msg.sender != r.buyer) revert NotBuyer();
        if (block.timestamp > r.paidAt + CANCEL_WINDOW_SECONDS) revert CancelWindowClosed();
        r.state = RequestState.Canceled;
        if (!USDC.transfer(r.buyer, r.paidAmount)) revert UsdcReturnFailed();
        emit InferenceCanceled(requestId, r.buyer, r.paidAmount);
    }

    // ─── Merkle anchoring (hourly receipt batch) ───────────────────────────

    function submitMerkleRoot(uint256 batchId, bytes32 root) external onlyOwner {
        if (root == bytes32(0)) revert MerkleRootEmpty();
        if (merkleRoots[batchId] != bytes32(0)) revert BatchAlreadySubmitted();
        merkleRoots[batchId] = root;
        emit MerkleRootSubmitted(batchId, root);
    }

    // ─── Admin ─────────────────────────────────────────────────────────────

    /// @dev Audit L-5: zero-address checked. Re-audit Low: also reject
    ///      `address(this)` because the contract has no self-call admin
    ///      surface, so transferring to itself would brick every onlyOwner
    ///      path permanently.
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        if (newOwner == address(this)) revert ZeroAddress();
        emit OwnerTransferred(owner, newOwner);
        owner = newOwner;
    }

    function setProtocolFeeBps(uint16 newBps) external onlyOwner {
        if (newBps > MAX_PROTOCOL_FEE_BPS) revert FeeTooHigh();
        emit ProtocolFeeUpdated(protocolFeeBps, newBps);
        protocolFeeBps = newBps;
    }

    /// @dev Audit L-5: reject zero sink (fee burned) and `address(this)`
    ///      (breaks E1's address-separation precondition).
    function setProtocolFeeSink(address newSink) external onlyOwner {
        if (newSink == address(0)) revert ZeroAddress();
        if (newSink == address(this)) revert ZeroAddress();
        emit ProtocolFeeSinkUpdated(protocolFeeSink, newSink);
        protocolFeeSink = newSink;
    }

    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit PausedSet(paused_);
    }

    // ─── Views ─────────────────────────────────────────────────────────────

    function getPipeline(bytes32 pipelineId) external view returns (Pipeline memory) {
        return pipelines[pipelineId];
    }

    function getRequest(bytes32 requestId) external view returns (InferenceRequest memory) {
        return requests[requestId];
    }

    /// @notice Convenience helper used by off-chain backend to compute the same
    ///         requestId the contract derived. Keeps the canonical formula in
    ///         one place.
    function computeRequestId(
        bytes32 pipelineId,
        address sender,
        bytes32 clientNonce,
        uint256 counter
    ) external pure returns (bytes32) {
        return keccak256(abi.encodePacked(pipelineId, sender, clientNonce, counter));
    }
}
