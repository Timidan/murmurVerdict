// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {IERC20} from "forge-std/interfaces/IERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

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
    // ─── Wave L.B errors ───
    error SignatureExpired();
    error SignatureAlreadyUsed();
    error SignatureMismatch();
    error UnauthorizedCaller();
    error HookPaused();
    error CodehashMismatch();
    error CapsNotMonotonic();
    error CapExceededPerCall();
    error CapExceededPerBlock();
    error CapExceededPerDay();
    error ProposalNotPresent();
    error ProposalNotReady();
    error WrongProposalKind();
    error HookNotPaused();
    error HookHasNoCode();
    error NotPendingOwner();

    // ─── Constants ─────────────────────────────────────────────────────────

    uint16 public constant MAX_PROTOCOL_FEE_BPS = 1000; // 10% hard cap
    uint16 public constant DEFAULT_PROTOCOL_FEE_BPS = 500; // 5%
    uint64 public constant CANCEL_WINDOW_SECONDS = 60;
    // Audit M-1: how long after the finalize window opens before the owner
    // can force-refund a Committed request whose agent never produced a
    // valid reveal. 7 days is enough for "agent forgot" to be exhausted.
    uint64 public constant COMMITTED_REFUND_GRACE_HOURS = 168;

    // ─── Wave L.B constants ───
    /// 7-day timelock between propose and commit for allowlist add/remove.
    uint64 public constant ALLOWLIST_TIMELOCK_SECONDS = 7 days;
    /// Shorter 24h timelock for unpause (faster recovery than full add).
    uint64 public constant ALLOWLIST_UNPAUSE_TIMELOCK_SECONDS = 1 days;
    /// Per EIP-1052: an account with no code yields keccak256("").
    bytes32 public constant EMPTY_CODE_HASH =
        0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470;

    // EIP-712 (Wave L.B)
    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant BUYER_AUTH_TYPEHASH =
        keccak256("BuyerAuthorization(address buyer,bytes32 pipelineId,bytes32 nonce,uint256 deadline)");
    bytes32 private constant DOMAIN_NAME_HASH = keccak256("MurmurEscrow");
    bytes32 private constant DOMAIN_VERSION_HASH = keccak256("1");

    /// Proposal kinds — match against `AllowlistProposal.kind` to ensure
    /// `commitAllowlistAdd` can't commit a remove proposal etc.
    uint8 private constant PROPOSAL_KIND_NONE = 0;
    uint8 private constant PROPOSAL_KIND_ADD = 1;
    uint8 private constant PROPOSAL_KIND_REMOVE = 2;
    uint8 private constant PROPOSAL_KIND_UNPAUSE = 3;

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
    address public pendingOwner;
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
        // Audit F-8: sink snapshotted like the fee, so a compromised owner
        // cannot redirect already-funded requests' fees to a new address.
        address protocolFeeSink;
    }

    /// pipelineId => Pipeline
    mapping(bytes32 => Pipeline) public pipelines;
    /// requestId => InferenceRequest
    mapping(bytes32 => InferenceRequest) public requests;
    /// batchId => Merkle root (for hourly receipt anchoring)
    mapping(uint256 => bytes32) public merkleRoots;
    /// per-pipeline counter for deterministic requestId derivation
    mapping(bytes32 => uint256) public requestCount;

    // ─── Wave L.B storage ──────────────────────────────────────────────────

    /// EIP-712 digest of the BuyerAuthorization struct. `true` once a sig
    /// has been redeemed via `requestInferenceFor`. Prevents replay of the
    /// same buyer signature for a fresh requestId (the per-pipeline
    /// counter in `requestCount` advances every call, so request-id
    /// uniqueness alone is NOT sufficient — codex audit 2026-05-23).
    mapping(bytes32 => bool) public usedAuthDigest;

    /// Per-integrator allowlist state for the hook-trust path. An entry
    /// with `committedAt == 0` is treated as "not on the allowlist."
    struct AllowlistedIntegration {
        bytes32 codehashPin;
        uint96 perCallCapUsdc;
        uint96 perBlockCapUsdc;
        uint96 perDayCapUsdc;
        uint96 spentThisBlock;
        uint96 spentToday;
        uint64 spentBlockNumber;
        uint64 spentTodayDayUtc;
        bool paused;
        uint64 committedAt;
    }
    mapping(address => AllowlistedIntegration) public allowlist;

    /// Pending allowlist change. `effectiveAt == 0` means no pending
    /// proposal. `kind` matches `PROPOSAL_KIND_*` constants.
    struct AllowlistProposal {
        bytes32 codehashPin;
        uint96 perCallCapUsdc;
        uint96 perBlockCapUsdc;
        uint96 perDayCapUsdc;
        uint64 effectiveAt;
        uint8 kind;
    }
    mapping(address => AllowlistProposal) public allowlistProposed;

    // ─── Events ────────────────────────────────────────────────────────────

    event OwnerTransferred(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
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
    /// Distinct from InferenceRefunded so off-chain indexers can flag
    /// operator-driven recovery of stuck Committed requests separately from
    /// the normal SLA-miss refund path.
    event InferenceForceRefunded(bytes32 indexed requestId, address indexed buyer, uint96 amount);
    event MerkleRootSubmitted(uint256 indexed batchId, bytes32 root);
    event ProtocolFeeUpdated(uint16 oldBps, uint16 newBps);
    event ProtocolFeeSinkUpdated(address oldSink, address newSink);
    event PausedSet(bool paused);

    // ─── Wave L.B events ───
    event AllowlistAddProposed(
        address indexed integrator,
        bytes32 codehashPin,
        uint96 perCallCapUsdc,
        uint96 perBlockCapUsdc,
        uint96 perDayCapUsdc,
        uint64 effectiveAt
    );
    event AllowlistAddCommitted(address indexed integrator);
    event AllowlistRemoveProposed(address indexed integrator, uint64 effectiveAt);
    event AllowlistRemoveCommitted(address indexed integrator);
    event AllowlistEntryPaused(address indexed integrator);
    event AllowlistUnpauseProposed(address indexed integrator, uint64 effectiveAt);
    event AllowlistUnpauseCommitted(address indexed integrator);
    event AllowlistCallGated(
        address indexed integrator,
        uint96 amountUsdc,
        uint96 spentThisBlock,
        uint96 spentToday
    );

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
        // Re-audit Low: enforce E1's `protocolFeeSink != escrow` precondition
        // at deploy time too, not just on setProtocolFeeSink. Without this a
        // misconfigured deploy could route fees back into escrow and silently
        // break funds conservation.
        if (usdc_ == address(0)) revert ZeroAddress();
        if (protocolFeeSink_ == address(0)) revert ZeroAddress();
        if (protocolFeeSink_ == address(this)) revert ZeroAddress();
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
            protocolFeeBps: protocolFeeBps,
            protocolFeeSink: protocolFeeSink
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

        // Audit M-2 / F-8: use the snapshotted fee AND sink, NOT live storage.
        uint96 fee = uint96((uint256(r.paidAmount) * r.protocolFeeBps) / 10_000);
        uint96 agentPayout = r.paidAmount - fee;
        r.state = RequestState.Finalized;

        if (fee > 0) {
            if (!USDC.transfer(r.protocolFeeSink, fee)) revert UsdcReturnFailed();
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

    /// @notice Recovery for Committed requests whose agent never produced a
    ///         valid reveal. Pre-fix, buyer funds for such requests were
    ///         stuck forever — refund/cancel require Pending, finalize
    ///         requires a matching reveal. After
    ///         COMMITTED_REFUND_GRACE_HOURS beyond the finalize-open time,
    ///         the BUYER or the owner can refund; the agent's commit drops.
    /// @dev    Audit M-1 introduced the owner path; audit F-4 opened it to
    ///         the buyer, because "recoverable only if the owner shows up"
    ///         is a trust dependency on the operator that the buyer never
    ///         priced in. Still not permissionless: a third party racing a
    ///         slow but legitimate finalize gains nothing, and the buyer
    ///         racing it only recovers their own principal instead of the
    ///         signal they paid for.
    function forceRefundCommitted(bytes32 requestId) external nonReentrant {
        InferenceRequest storage r = requests[requestId];
        if (r.state != RequestState.Committed) revert WrongState();
        if (msg.sender != owner && msg.sender != r.buyer) revert UnauthorizedCaller();
        Pipeline storage p = pipelines[r.pipelineId];
        uint64 graceOpenAt = r.committedAt
            + uint64(p.horizonHours) * 3600
            + COMMITTED_REFUND_GRACE_HOURS * 3600;
        if (block.timestamp < graceOpenAt) revert BeforeFinalizeWindow();
        r.state = RequestState.Refunded;
        if (!USDC.transfer(r.buyer, r.paidAmount)) revert UsdcReturnFailed();
        emit InferenceForceRefunded(requestId, r.buyer, r.paidAmount);
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

    // ─── Wave L.B: requestInferenceFor + allowlist governance ──────────────

    /// @notice Buyer authorization carried in the EIP-712 sig path.
    struct BuyerAuthorization {
        uint256 deadline;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    /// @notice Submit an inference request on behalf of an attested
    ///         `buyer`. Two trust modes (mutually exclusive — chosen by
    ///         the value of `buyerSig.deadline`):
    ///
    ///         1. EIP-712 path (`buyerSig.deadline != 0`): caller may be
    ///            any address; we verify a buyer-signed BuyerAuthorization.
    ///            USDC is pulled from `buyer` (must have pre-approved).
    ///
    ///         2. Allowlist path (`buyerSig.deadline == 0`):
    ///            `msg.sender` must be on the strict allowlist with
    ///            matching codehash, within per-call/per-block/per-day
    ///            caps. USDC is pulled from `msg.sender` (e.g. a
    ///            Murmur-controlled CCTP hook that holds the bridged
    ///            funds). The hook is responsible for source-side
    ///            enforcement of `buyer == messageSender` per the
    ///            design's CCTP buyer-binding requirements.
    ///
    ///         In both modes the request's stored `buyer` is the attested
    ///         buyer address, NOT msg.sender. Refunds, cancels, and
    ///         force-refunds route to that attested buyer.
    ///
    /// @dev    Wave L.B. The existing `requestInference()` is unchanged
    ///         (buyer == msg.sender).
    function requestInferenceFor(
        address buyer,
        bytes32 pipelineId,
        bytes32 clientNonce,
        BuyerAuthorization calldata buyerSig
    ) external whenNotPaused nonReentrant returns (bytes32 requestId) {
        if (buyer == address(0)) revert ZeroAddress();
        if (buyer == address(this)) revert ZeroAddress();

        Pipeline storage p = pipelines[pipelineId];
        if (p.agentOwner == address(0)) revert PipelineNotFound();
        if (!p.active) revert PipelineNotActive();

        // Trust-mode selection.
        address payer;
        if (buyerSig.deadline != 0) {
            // EIP-712 path: verify buyer's signature; pull USDC from buyer.
            _verifyBuyerAuthorization(buyer, pipelineId, clientNonce, buyerSig);
            payer = buyer;
        } else {
            // Allowlist path: msg.sender must be an allowlisted hook with
            // matching codehash and within caps. USDC is pulled from hook.
            _enforceAllowlistCall(msg.sender, p.priceUsdc);
            payer = msg.sender;
        }

        if (!USDC.transferFrom(payer, address(this), p.priceUsdc)) {
            revert UsdcTransferFailed();
        }

        uint256 ctr = requestCount[pipelineId]++;
        requestId = keccak256(abi.encodePacked(pipelineId, buyer, clientNonce, ctr));
        if (requests[requestId].state != RequestState.None) revert WrongState();

        uint64 nowTs = uint64(block.timestamp);
        requests[requestId] = InferenceRequest({
            pipelineId: pipelineId,
            buyer: buyer,
            paidAmount: p.priceUsdc,
            paidAt: nowTs,
            slaDeadline: nowTs + p.slaSeconds,
            commitHash: bytes32(0),
            marketDataCutoff: bytes32(0),
            committedAt: 0,
            state: RequestState.Pending,
            protocolFeeBps: protocolFeeBps,
            protocolFeeSink: protocolFeeSink
        });

        emit InferenceRequested(requestId, pipelineId, buyer, p.priceUsdc, nowTs + p.slaSeconds);
    }

    /// @notice EIP-712 domain separator for buyer-authorization sigs.
    ///         Recomputed on every call so a chainid change (fork) is
    ///         immediately reflected; gas cost is small relative to the
    ///         tx-level work this does.
    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return _domainSeparator();
    }

    /// @notice EIP-712 typed-data hash for a BuyerAuthorization. Off-chain
    ///         signing libraries (viem, ethers, web3.js) all reproduce
    ///         this digest given the typed-data schema. Reviewers can
    ///         double-check via `cast keccak <preimage>` using the
    ///         BUYER_AUTH_TYPEHASH constant.
    function hashBuyerAuth(
        address buyer,
        bytes32 pipelineId,
        bytes32 nonce,
        uint256 deadline
    ) external view returns (bytes32) {
        return _hashBuyerAuth(buyer, pipelineId, nonce, deadline);
    }

    function _domainSeparator() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                DOMAIN_NAME_HASH,
                DOMAIN_VERSION_HASH,
                block.chainid,
                address(this)
            )
        );
    }

    function _hashBuyerAuth(
        address buyer,
        bytes32 pipelineId,
        bytes32 nonce,
        uint256 deadline
    ) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(BUYER_AUTH_TYPEHASH, buyer, pipelineId, nonce, deadline)
        );
        return keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
    }

    function _verifyBuyerAuthorization(
        address buyer,
        bytes32 pipelineId,
        bytes32 clientNonce,
        BuyerAuthorization calldata buyerSig
    ) internal {
        if (block.timestamp > buyerSig.deadline) revert SignatureExpired();
        bytes32 digest = _hashBuyerAuth(buyer, pipelineId, clientNonce, buyerSig.deadline);
        if (usedAuthDigest[digest]) revert SignatureAlreadyUsed();
        // Use OZ ECDSA.recover (NOT raw ecrecover) — rejects malleable
        // upper-half s-values per EIP-2 and reverts on bad sigs instead
        // of returning address(0).
        address signer = ECDSA.recover(digest, buyerSig.v, buyerSig.r, buyerSig.s);
        if (signer != buyer) revert SignatureMismatch();
        // Mark used ONLY after signer validated; an invalid sig must NOT
        // consume the digest (codex audit 2026-05-23).
        usedAuthDigest[digest] = true;
    }

    function _enforceAllowlistCall(address integrator, uint96 amount) internal {
        AllowlistedIntegration storage entry = allowlist[integrator];
        if (entry.committedAt == 0) revert UnauthorizedCaller();
        if (entry.paused) revert HookPaused();
        // Call-time codehash check. Catches SELFDESTRUCT+redeploy attacks
        // on pre-EIP-6780 chains AND any registration-time/call-time
        // codehash drift that an upgradeable-proxy hook could introduce.
        if (entry.codehashPin != integrator.codehash) revert CodehashMismatch();
        if (amount > entry.perCallCapUsdc) revert CapExceededPerCall();

        // Per-block counter — reset on new block.number (canonical chain
        // semantics; reorgs are bounded by L2 finality).
        if (entry.spentBlockNumber != block.number) {
            entry.spentBlockNumber = uint64(block.number);
            entry.spentThisBlock = 0;
        }
        // Codex audit 2026-05-23: compare in uint256 to avoid uint96
        // overflow Panic before reaching the named CapExceededPerBlock
        // revert (matters at extreme cap configurations).
        uint256 newBlockSpent = uint256(entry.spentThisBlock) + uint256(amount);
        if (newBlockSpent > uint256(entry.perBlockCapUsdc)) revert CapExceededPerBlock();
        entry.spentThisBlock = uint96(newBlockSpent);

        // Per-day counter — reset on new UTC day (block.timestamp / 86400).
        uint64 todayUtc = uint64(block.timestamp / 86_400);
        if (entry.spentTodayDayUtc != todayUtc) {
            entry.spentTodayDayUtc = todayUtc;
            entry.spentToday = 0;
        }
        uint256 newDaySpent = uint256(entry.spentToday) + uint256(amount);
        if (newDaySpent > uint256(entry.perDayCapUsdc)) revert CapExceededPerDay();
        entry.spentToday = uint96(newDaySpent);

        emit AllowlistCallGated(integrator, amount, entry.spentThisBlock, entry.spentToday);
    }

    // ─── Wave L.B: allowlist admin (7 functions) ──────────────────────────

    /// @notice Propose adding `integrator` to the allowlist. Takes effect
    ///         only after a 7-day timelock AND `commitAllowlistAdd` is
    ///         called. The codehash is pinned at PROPOSE time AND
    ///         re-verified at commit time to catch any churn during the
    ///         window (SELFDESTRUCT+redeploy, etc.).
    ///
    /// @dev    Proxy-rejection (per user lock 2026-05-23): on-chain
    ///         enforces nonzero code + codehash pin. Operator/CI must
    ///         verify off-chain that the bytecode contains no
    ///         DELEGATECALL or SELFDESTRUCT before calling this.
    function proposeAllowlistAdd(
        address integrator,
        bytes32 codehashPin,
        uint96 perCallCapUsdc,
        uint96 perBlockCapUsdc,
        uint96 perDayCapUsdc
    ) external onlyOwner {
        if (integrator == address(0) || integrator == address(this)) revert ZeroAddress();
        if (integrator.code.length == 0) revert HookHasNoCode();
        bytes32 onchainCodehash = integrator.codehash;
        if (onchainCodehash == bytes32(0) || onchainCodehash == EMPTY_CODE_HASH) revert HookHasNoCode();
        if (codehashPin == bytes32(0)) revert HookHasNoCode();
        // Codex audit 2026-05-23: enforce pin == on-chain codehash at
        // propose time. Without this, an operator could pin an incorrect
        // codehash and the commit-time re-check would never reach a
        // pre-validated baseline.
        if (codehashPin != onchainCodehash) revert CodehashMismatch();
        // Cap monotonic: per-call ≤ per-block ≤ per-day. Catches config
        // errors that would silently degrade cap semantics.
        if (perCallCapUsdc == 0) revert CapsNotMonotonic();
        if (perCallCapUsdc > perBlockCapUsdc) revert CapsNotMonotonic();
        if (perBlockCapUsdc > perDayCapUsdc) revert CapsNotMonotonic();

        uint64 effectiveAt = uint64(block.timestamp + ALLOWLIST_TIMELOCK_SECONDS);
        allowlistProposed[integrator] = AllowlistProposal({
            codehashPin: codehashPin,
            perCallCapUsdc: perCallCapUsdc,
            perBlockCapUsdc: perBlockCapUsdc,
            perDayCapUsdc: perDayCapUsdc,
            effectiveAt: effectiveAt,
            kind: PROPOSAL_KIND_ADD
        });
        emit AllowlistAddProposed(
            integrator, codehashPin, perCallCapUsdc, perBlockCapUsdc, perDayCapUsdc, effectiveAt
        );
    }

    function commitAllowlistAdd(address integrator) external onlyOwner {
        AllowlistProposal storage prop = allowlistProposed[integrator];
        if (prop.kind != PROPOSAL_KIND_ADD) revert WrongProposalKind();
        if (block.timestamp < prop.effectiveAt) revert ProposalNotReady();
        // Re-verify codehash hasn't drifted since propose. Catches
        // SELFDESTRUCT+redeploy windows on pre-EIP-6780 chains.
        if (integrator.codehash != prop.codehashPin) revert CodehashMismatch();
        if (integrator.code.length == 0) revert HookHasNoCode();

        allowlist[integrator] = AllowlistedIntegration({
            codehashPin: prop.codehashPin,
            perCallCapUsdc: prop.perCallCapUsdc,
            perBlockCapUsdc: prop.perBlockCapUsdc,
            perDayCapUsdc: prop.perDayCapUsdc,
            spentThisBlock: 0,
            spentToday: 0,
            spentBlockNumber: 0,
            spentTodayDayUtc: 0,
            paused: false,
            committedAt: uint64(block.timestamp)
        });
        delete allowlistProposed[integrator];
        emit AllowlistAddCommitted(integrator);
    }

    function proposeAllowlistRemove(address integrator) external onlyOwner {
        if (allowlist[integrator].committedAt == 0) revert UnauthorizedCaller();
        uint64 effectiveAt = uint64(block.timestamp + ALLOWLIST_TIMELOCK_SECONDS);
        allowlistProposed[integrator] = AllowlistProposal({
            codehashPin: bytes32(0),
            perCallCapUsdc: 0,
            perBlockCapUsdc: 0,
            perDayCapUsdc: 0,
            effectiveAt: effectiveAt,
            kind: PROPOSAL_KIND_REMOVE
        });
        emit AllowlistRemoveProposed(integrator, effectiveAt);
    }

    function commitAllowlistRemove(address integrator) external onlyOwner {
        AllowlistProposal storage prop = allowlistProposed[integrator];
        if (prop.kind != PROPOSAL_KIND_REMOVE) revert WrongProposalKind();
        if (block.timestamp < prop.effectiveAt) revert ProposalNotReady();
        delete allowlist[integrator];
        delete allowlistProposed[integrator];
        emit AllowlistRemoveCommitted(integrator);
    }

    /// @notice Immediate pause — no timelock — emergency stop for a hook
    ///         observed to be misbehaving. Asymmetric with unpause
    ///         (which IS timelocked) per codex audit 2026-05-23.
    function pauseAllowlistEntry(address integrator) external onlyOwner {
        AllowlistedIntegration storage entry = allowlist[integrator];
        if (entry.committedAt == 0) revert UnauthorizedCaller();
        entry.paused = true;
        emit AllowlistEntryPaused(integrator);
    }

    function proposeAllowlistUnpause(address integrator) external onlyOwner {
        AllowlistedIntegration storage entry = allowlist[integrator];
        if (entry.committedAt == 0) revert UnauthorizedCaller();
        if (!entry.paused) revert HookNotPaused();
        uint64 effectiveAt = uint64(block.timestamp + ALLOWLIST_UNPAUSE_TIMELOCK_SECONDS);
        allowlistProposed[integrator] = AllowlistProposal({
            codehashPin: bytes32(0),
            perCallCapUsdc: 0,
            perBlockCapUsdc: 0,
            perDayCapUsdc: 0,
            effectiveAt: effectiveAt,
            kind: PROPOSAL_KIND_UNPAUSE
        });
        emit AllowlistUnpauseProposed(integrator, effectiveAt);
    }

    function commitAllowlistUnpause(address integrator) external onlyOwner {
        AllowlistProposal storage prop = allowlistProposed[integrator];
        if (prop.kind != PROPOSAL_KIND_UNPAUSE) revert WrongProposalKind();
        if (block.timestamp < prop.effectiveAt) revert ProposalNotReady();
        AllowlistedIntegration storage entry = allowlist[integrator];
        if (entry.committedAt == 0) revert UnauthorizedCaller();
        entry.paused = false;
        delete allowlistProposed[integrator];
        emit AllowlistUnpauseCommitted(integrator);
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
    ///      path permanently. Audit F-8: two-step, matching
    ///      MurmurSealedVerdicts — a typoed transfer on the money contract
    ///      must be recoverable, not final.
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        if (newOwner == address(this)) revert ZeroAddress();
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        address previousOwner = owner;
        owner = msg.sender;
        pendingOwner = address(0);
        emit OwnerTransferred(previousOwner, msg.sender);
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
    /// @dev    `addrInId` is the address folded into the request-id derivation.
    ///         For `requestInference()` it equals `msg.sender` (the buyer).
    ///         For `requestInferenceFor()` (Wave L.B) it equals the attested
    ///         `buyer` argument — the relayer / hook caller is NOT folded in.
    ///         Off-chain callers must mirror this distinction; otherwise the
    ///         computed id will not match the on-chain `requestId`.
    function computeRequestId(
        bytes32 pipelineId,
        address addrInId,
        bytes32 clientNonce,
        uint256 counter
    ) external pure returns (bytes32) {
        return keccak256(abi.encodePacked(pipelineId, addrInId, clientNonce, counter));
    }
}
