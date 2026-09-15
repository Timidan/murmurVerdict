// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.25;

import {
    FHE,
    Impl,
    euint8,
    euint16,
    externalEuint8,
    externalEuint16
} from "@fhenixprotocol/cofhe-contracts/FHE.sol";
import {UnsignedEncryptedInput, Utils} from "@fhenixprotocol/cofhe-contracts/ICofhe.sol";

/// @title MurmurSealedVerdicts
/// @notice Canonical sealed-call entrypoint for Murmur Verdict.
/// @dev Verdict data is encrypted at submit time and becomes publicly
///      decryptable only after the registered market reveal window opens.
contract MurmurSealedVerdicts {
    error NotOwner();
    error MarketInactive();
    error MarketNotFound();
    error MarketAlreadyRegistered();
    error ScheduleNotStrictlyOrdered();
    error SubmissionWindowNotOpen();
    error SubmissionWindowClosed();
    error CallNotFound();
    error CallAlreadyExists();
    error WrongState();
    error RevealWindowNotOpen();
    error InvalidDecryptProof();
    error PacketNotFound();
    error PacketAlreadyExists();
    error RevealAfterMustBeFuture();
    /// A feed packet arrived at or after the market resolved.
    error FeedWindowClosed();
    error ZeroOwner();
    error NotPendingOwner();
    error NotRelayer();
    error ZeroRelayer();
    error ZeroAgent();
    error NotGrantor();
    error ZeroGrantor();
    error ZeroSubscriber();
    error DecryptGrantWindowClosed();
    error CallNotSellable();

    enum CallState {
        None,
        Sealed,
        Opened,
        Revealed,
        Invalid
    }

    enum InvalidRevealReason {
        None,
        BinaryIndex,
        Confidence,
        SignalBps
    }

    /// @notice A market instance's immutable schedule.
    /// @dev Replaces the old (horizonSeconds | fixedRevealAfter) pair, which
    ///      conflated three unrelated moments: when providers must submit, when
    ///      the value stops being sellable, and when it becomes public.
    ///
    ///      Ordering is strict and enforced at registration:
    ///        armCloseAt < submissionOpenAt < earlyAccessCutoffAt
    ///          < submissionCloseAt < resolutionAt < publicRevealAt
    ///
    ///      armCloseAt → submissionOpenAt is the cohort-commit margin. The
    ///      commitment is a transaction; without a gap a provider's submit can
    ///      be mined ahead of the commit meant to bind it.
    ///
    ///      resolutionAt is the VENUE's end time (when the outcome is
    ///      determined). publicRevealAt is when murmur unseals. They are
    ///      separate on purpose: reveal is embargoed past resolution, so one
    ///      field would assert the market resolves at murmur's reveal deadline.
    ///      resolutionAt is unused by contract logic and stored for auditability
    ///      so the on-chain record is self-describing.
    struct Market {
        uint64 armCloseAt;
        uint64 submissionOpenAt;
        uint64 earlyAccessCutoffAt;
        uint64 submissionCloseAt;
        uint64 resolutionAt;
        uint64 publicRevealAt;
        bool active;
    }

    /// @notice Whether a call was submitted early enough to be sold.
    /// @dev EarlyAccess calls may carry a committed cohort; LateUnsellable ones
    ///      are still sealed, revealed and scored, but can never be granted.
    ///      Persisted on-chain because reputation must distinguish them: a
    ///      provider submitting only in the late window predicts with strictly
    ///      more information than one who sells.
    enum SubmissionClass {
        None,
        EarlyAccess,
        LateUnsellable
    }

    struct SealedCall {
        address agent;
        bytes32 marketId;
        uint64 acceptedAt;
        /// @dev Snapshot of the market's publicRevealAt, frozen at submit so a
        ///      later schedule change cannot retime an existing call.
        uint64 publicRevealAt;
        euint8 binaryIndex;
        euint16 confidenceBps;
        uint8 revealedBinaryIndex;
        uint16 revealedConfidenceBps;
        CallState state;
        SubmissionClass submissionClass;
    }

    struct SealedFeedPacket {
        address agent;
        bytes32 feedId;
        bytes32 marketId;
        uint64 acceptedAt;
        uint64 revealAfter;
        euint8 action;
        euint16 signalBps;
        uint8 revealedAction;
        uint16 revealedSignalBps;
        CallState state;
    }

    /// @dev CoFHE 0.7 dropped runtime security zones; 0 is the only zone the
    ///      library's `external*` overloads and batch helpers construct.
    uint8 private constant SECURITY_ZONE = 0;

    address public owner;
    address public pendingOwner;
    mapping(address => bool) public relayers;
    // Flow 2 (paid private decrypt-grant): keyed EOAs allowed to broker early
    // private decrypt access to a sealed call's ciphertext handles. Isolated
    // from `relayers` so the grant signer never inherits submit authority.
    mapping(address => bool) public grantors;
    // (callId => subscriber => granted). Not required for FHE correctness — the
    // ACL lives in CoFHE — but kept on-chain for idempotency, reconciliation,
    // and incident recovery.
    mapping(bytes32 => mapping(address => bool)) public decryptAccessGranted;
    mapping(bytes32 => Market) public markets;
    mapping(bytes32 => SealedCall) private calls;
    mapping(bytes32 => SealedFeedPacket) private feedPackets;

    event OwnerTransferred(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event RelayerSet(address indexed relayer, bool active);
    event GrantorSet(address indexed grantor, bool active);
    event DecryptAccessGranted(bytes32 indexed callId, address indexed subscriber);
    event MarketRegistered(
        bytes32 indexed marketId,
        uint64 armCloseAt,
        uint64 submissionOpenAt,
        uint64 earlyAccessCutoffAt,
        uint64 submissionCloseAt,
        uint64 resolutionAt,
        uint64 publicRevealAt,
        bool active
    );
    event MarketActiveSet(bytes32 indexed marketId, bool active);
    event SealedCallSubmitted(
        bytes32 indexed callId,
        address indexed agent,
        bytes32 indexed marketId,
        uint64 acceptedAt,
        uint64 publicRevealAt,
        bytes32 binaryIndexCtHash,
        bytes32 confidenceCtHash,
        bytes32 clientNonce,
        SubmissionClass submissionClass
    );
    event RevealOpened(
        bytes32 indexed callId, bytes32 binaryIndexCtHash, bytes32 confidenceCtHash, uint64 openedAt
    );
    event VerdictRevealed(
        bytes32 indexed callId,
        address indexed agent,
        bytes32 indexed marketId,
        uint8 binaryIndex,
        uint16 confidenceBps,
        uint64 revealedAt
    );
    event VerdictRevealInvalid(
        bytes32 indexed callId,
        address indexed agent,
        bytes32 indexed marketId,
        uint8 binaryIndex,
        uint16 confidenceBps,
        uint8 reason,
        uint64 revealedAt
    );
    event FeedPacketSubmitted(
        bytes32 indexed packetId,
        address indexed agent,
        bytes32 indexed feedId,
        bytes32 marketId,
        uint64 acceptedAt,
        uint64 revealAfter,
        bytes32 actionCtHash,
        bytes32 signalCtHash,
        bytes32 clientNonce
    );
    event FeedPacketRevealOpened(
        bytes32 indexed packetId, bytes32 actionCtHash, bytes32 signalCtHash, uint64 openedAt
    );
    event FeedPacketRevealed(
        bytes32 indexed packetId,
        address indexed agent,
        bytes32 indexed feedId,
        bytes32 marketId,
        uint8 action,
        uint16 signalBps,
        uint64 revealedAt
    );
    event FeedPacketRevealInvalid(
        bytes32 indexed packetId,
        address indexed agent,
        bytes32 indexed feedId,
        bytes32 marketId,
        uint8 action,
        uint16 signalBps,
        uint8 reason,
        uint64 revealedAt
    );

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyGrantor() {
        if (!grantors[msg.sender]) revert NotGrantor();
        _;
    }

    constructor() {
        owner = msg.sender;
        emit OwnerTransferred(address(0), msg.sender);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroOwner();
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

    function setRelayer(address relayer, bool active) external onlyOwner {
        if (relayer == address(0)) revert ZeroRelayer();
        relayers[relayer] = active;
        emit RelayerSet(relayer, active);
    }

    function setGrantor(address grantor, bool active) external onlyOwner {
        if (grantor == address(0)) revert ZeroGrantor();
        grantors[grantor] = active;
        emit GrantorSet(grantor, active);
    }

    /// @notice Grant a paying subscriber early private decrypt access to a
    ///         sealed call's ciphertext handles, before the public reveal.
    /// @dev Murmur brokers this after verifying an off-chain payment. Kept as a
    ///      SEPARATE grantor-keyed entrypoint rather than folded into
    ///      submitSealedFor: merging them would let one bad cohort entry revert
    ///      a provider's submission, and would hand the relayer key the grant
    ///      authority the grantor role exists to keep apart. Provider scoring
    ///      must survive consumer delivery failure.
    ///
    ///      The deadline is submissionCloseAt (the prediction window opening),
    ///      NOT publicRevealAt. A grant landing after the window opens is
    ///      worthless to the subscriber — the market is already live — so the
    ///      sale window closes when delivery stops being useful, not when the
    ///      value goes public days later.
    ///
    ///      Only EarlyAccess calls are grantable; LateUnsellable ones are
    ///      refereed and scored but never sold.
    ///
    ///      `FHE.allow` is persistent: the subscriber keeps read access across
    ///      the call's later openReveal/allowPublic and state changes. There is
    ///      no revoke in CoFHE, so a grant is permanent. Idempotent per
    ///      (callId, subscriber).
    function grantDecryptAccess(bytes32 callId, address subscriber) external onlyGrantor {
        SealedCall storage sealedCall = calls[callId];
        if (sealedCall.state == CallState.None) revert CallNotFound();
        if (subscriber == address(0)) revert ZeroSubscriber();
        if (sealedCall.submissionClass != SubmissionClass.EarlyAccess) revert CallNotSellable();
        if (
            sealedCall.state != CallState.Sealed
                || block.timestamp >= markets[sealedCall.marketId].submissionCloseAt
        ) {
            revert DecryptGrantWindowClosed();
        }

        if (decryptAccessGranted[callId][subscriber]) return;

        decryptAccessGranted[callId][subscriber] = true;
        FHE.allow(sealedCall.binaryIndex, subscriber);
        FHE.allow(sealedCall.confidenceBps, subscriber);

        emit DecryptAccessGranted(callId, subscriber);
    }

    /// @notice Subscriber-facing view for the paid decrypt-grant flow.
    /// @dev Returns `grantCloseAt` — the market's submissionCloseAt — NOT
    ///      publicRevealAt. This view answers "can I still buy access?", and
    ///      that closes when the prediction window opens, not when the value
    ///      goes public days later. Returning the reveal time here would let
    ///      the payment gate settle money for access this contract will reject.
    function getDecryptAccess(bytes32 callId, address subscriber)
        external
        view
        returns (
            CallState state,
            uint64 grantCloseAt,
            bytes32 binaryIndexCtHash,
            bytes32 confidenceCtHash,
            bool alreadyGranted
        )
    {
        SealedCall storage sealedCall = calls[callId];
        if (sealedCall.state == CallState.None) revert CallNotFound();
        return (
            sealedCall.state,
            markets[sealedCall.marketId].submissionCloseAt,
            FHE.unwrap(sealedCall.binaryIndex),
            FHE.unwrap(sealedCall.confidenceBps),
            decryptAccessGranted[callId][subscriber]
        );
    }

    /// @notice Register a market instance's immutable schedule.
    /// @dev ONE-SHOT. Re-registering is rejected rather than overwriting.
    ///      The old registrars silently overwrote on-chain configuration, which
    ///      let a "repair" retime a market that consumers had already armed and
    ///      providers had already submitted against. A schedule someone paid
    ///      against must never move; drift is handled off-chain by delisting and
    ///      refunding, never by rebinding.
    ///
    ///      Only `active` remains mutable, via setMarketActive.
    function registerMarket(bytes32 marketId, Market calldata schedule) external onlyOwner {
        if (_isRegistered(markets[marketId])) revert MarketAlreadyRegistered();

        // Strict ordering. Equality anywhere collapses a window to zero length
        // (e.g. submissionOpenAt == earlyAccessCutoffAt leaves no interval in
        // which a sellable call can be submitted).
        if (
            !(
                schedule.armCloseAt < schedule.submissionOpenAt
                    && schedule.submissionOpenAt < schedule.earlyAccessCutoffAt
                    && schedule.earlyAccessCutoffAt < schedule.submissionCloseAt
                    && schedule.submissionCloseAt < schedule.resolutionAt
                    && schedule.resolutionAt < schedule.publicRevealAt
            )
        ) revert ScheduleNotStrictlyOrdered();

        // Registration must complete before arming opens, not merely before the
        // market ends: a window length large relative to the venue's listing
        // lead can place armCloseAt in the past, yielding a market nobody can
        // arm or submit to.
        if (schedule.armCloseAt <= block.timestamp) revert RevealAfterMustBeFuture();

        markets[marketId] = schedule;
        emit MarketRegistered(
            marketId,
            schedule.armCloseAt,
            schedule.submissionOpenAt,
            schedule.earlyAccessCutoffAt,
            schedule.submissionCloseAt,
            schedule.resolutionAt,
            schedule.publicRevealAt,
            schedule.active
        );
    }

    function setMarketActive(bytes32 marketId, bool active) external onlyOwner {
        Market storage market = markets[marketId];
        if (!_isRegistered(market)) revert MarketNotFound();
        market.active = active;
        emit MarketActiveSet(marketId, active);
    }

    /// @dev A registered market always has a nonzero publicRevealAt, since
    ///      registration enforces strict ordering above a nonzero timestamp.
    function _isRegistered(Market storage market) private view returns (bool) {
        return market.publicRevealAt != 0;
    }

    /// @dev CoFHE 0.7 verifies inputs as a BATCH, not one at a time. The
    ///      verifier signs once over keccak256(h_0 || h_1) — where each h_i also
    ///      binds the sender and the consuming contract — so the two hashes must
    ///      be presented together, in the order they were encrypted. Calling
    ///      `FHE.asEuint8(hash, proof)` and `FHE.asEuint16(hash, proof)`
    ///      separately would rebuild two one-element digests and neither would
    ///      match the signature.
    ///
    ///      `FHE.asEuint8s` / `asEuint16s` only take homogeneous batches, so a
    ///      mixed (euint8, euint16) pair goes through `Impl.verifyBatchInputs`
    ///      directly. That call is `internal`, so it inlines here and the
    ///      `sender` it binds is this contract's own msg.sender — the relayer
    ///      that broadcast the submission. The consuming contract the verifier
    ///      binds is address(this).
    ///
    ///      securityZone is fixed at 0 to match the library's own `external*`
    ///      overloads, which no longer accept one at runtime.
    function _verifySealedPair(
        externalEuint8 firstInput,
        externalEuint16 secondInput,
        bytes memory inputProof
    ) private returns (euint8 first, euint16 second) {
        UnsignedEncryptedInput[] memory inputs = new UnsignedEncryptedInput[](2);
        inputs[0] = UnsignedEncryptedInput({
            ctHash: uint256(externalEuint8.unwrap(firstInput)),
            securityZone: SECURITY_ZONE,
            utype: Utils.EUINT8_TFHE
        });
        inputs[1] = UnsignedEncryptedInput({
            ctHash: uint256(externalEuint16.unwrap(secondInput)),
            securityZone: SECURITY_ZONE,
            utype: Utils.EUINT16_TFHE
        });

        bytes32[] memory handles = Impl.verifyBatchInputs(inputs, inputProof);
        return (euint8.wrap(handles[0]), euint16.wrap(handles[1]));
    }

    /// @notice Relay one agent's sealed verdict.
    /// @dev CoFHE 0.7 changed the input shape: the two handles are bare
    ///      `external*` brands and `inputProof` is the SINGLE signature that
    ///      covers both of them, in this order. See `_verifySealedPair`.
    function submitSealedFor(
        address agent,
        bytes32 marketId,
        externalEuint8 binaryIndexInput,
        externalEuint16 confidenceInput,
        bytes calldata inputProof,
        bytes32 clientNonce
    ) external returns (bytes32 callId) {
        if (!relayers[msg.sender]) revert NotRelayer();
        if (agent == address(0)) revert ZeroAgent();
        return _submitSealed(
            agent, marketId, binaryIndexInput, confidenceInput, inputProof, clientNonce
        );
    }

    function _submitSealed(
        address agent,
        bytes32 marketId,
        externalEuint8 binaryIndexInput,
        externalEuint16 confidenceInput,
        bytes memory inputProof,
        bytes32 clientNonce
    ) internal returns (bytes32 callId) {
        Market memory market = markets[marketId];
        if (market.publicRevealAt == 0) revert MarketNotFound();
        if (!market.active) revert MarketInactive();

        uint64 acceptedAt = uint64(block.timestamp);

        // Half-open submission window: [submissionOpenAt, submissionCloseAt).
        //
        // Rejecting at exactly submissionCloseAt is deliberate — that instant is
        // when the prediction window opens and the opening reference price may
        // already be observable, so a "prediction" made there is not one. The
        // previous code enforced no deadline at all beyond a future reveal,
        // which let a provider submit one second before the market ended.
        if (acceptedAt < market.submissionOpenAt) revert SubmissionWindowNotOpen();
        if (acceptedAt >= market.submissionCloseAt) revert SubmissionWindowClosed();

        callId = keccak256(
            abi.encodePacked(block.chainid, address(this), agent, marketId, clientNonce)
        );
        if (calls[callId].state != CallState.None) revert CallAlreadyExists();

        // Sellable only if there is still time to grant the cohort and let a
        // subscriber decrypt before the window opens. Later calls are sealed,
        // revealed and scored — just never granted.
        SubmissionClass submissionClass = acceptedAt < market.earlyAccessCutoffAt
            ? SubmissionClass.EarlyAccess
            : SubmissionClass.LateUnsellable;

        (euint8 sealedBinaryIndex, euint16 sealedConfidence) =
            _verifySealedPair(binaryIndexInput, confidenceInput, inputProof);
        FHE.allowThis(sealedBinaryIndex);
        FHE.allowThis(sealedConfidence);

        calls[callId] = SealedCall({
            agent: agent,
            marketId: marketId,
            acceptedAt: acceptedAt,
            publicRevealAt: market.publicRevealAt,
            binaryIndex: sealedBinaryIndex,
            confidenceBps: sealedConfidence,
            revealedBinaryIndex: 0,
            revealedConfidenceBps: 0,
            state: CallState.Sealed,
            submissionClass: submissionClass
        });

        emit SealedCallSubmitted(
            callId,
            agent,
            marketId,
            acceptedAt,
            market.publicRevealAt,
            FHE.unwrap(sealedBinaryIndex),
            FHE.unwrap(sealedConfidence),
            clientNonce,
            submissionClass
        );
    }

    function openReveal(bytes32 callId) external {
        SealedCall storage sealedCall = calls[callId];
        if (sealedCall.state == CallState.None) revert CallNotFound();
        if (sealedCall.state != CallState.Sealed) revert WrongState();

        if (block.timestamp < sealedCall.publicRevealAt) revert RevealWindowNotOpen();

        sealedCall.state = CallState.Opened;
        FHE.allowPublic(sealedCall.binaryIndex);
        FHE.allowPublic(sealedCall.confidenceBps);

        emit RevealOpened(
            callId,
            FHE.unwrap(sealedCall.binaryIndex),
            FHE.unwrap(sealedCall.confidenceBps),
            uint64(block.timestamp)
        );
    }

    function publishReveal(
        bytes32 callId,
        uint8 binaryIndex,
        uint16 confidenceBps,
        bytes calldata binaryIndexSignature,
        bytes calldata confidenceSignature
    ) external {
        SealedCall storage sealedCall = calls[callId];
        if (sealedCall.state == CallState.None) revert CallNotFound();
        if (sealedCall.state != CallState.Opened) revert WrongState();
        if (!FHE.verifyDecryptResult(sealedCall.binaryIndex, binaryIndex, binaryIndexSignature)) {
            revert InvalidDecryptProof();
        }
        if (!FHE.verifyDecryptResult(sealedCall.confidenceBps, confidenceBps, confidenceSignature))
        {
            revert InvalidDecryptProof();
        }

        InvalidRevealReason reason = InvalidRevealReason.None;
        if (binaryIndex > 1) {
            reason = InvalidRevealReason.BinaryIndex;
        } else if (confidenceBps < 5100 || confidenceBps > 9500) {
            reason = InvalidRevealReason.Confidence;
        }

        if (reason != InvalidRevealReason.None) {
            sealedCall.state = CallState.Invalid;
            sealedCall.revealedBinaryIndex = binaryIndex;
            sealedCall.revealedConfidenceBps = confidenceBps;
            emit VerdictRevealInvalid(
                callId,
                sealedCall.agent,
                sealedCall.marketId,
                binaryIndex,
                confidenceBps,
                uint8(reason),
                uint64(block.timestamp)
            );
            return;
        }

        sealedCall.state = CallState.Revealed;
        sealedCall.revealedBinaryIndex = binaryIndex;
        sealedCall.revealedConfidenceBps = confidenceBps;

        emit VerdictRevealed(
            callId,
            sealedCall.agent,
            sealedCall.marketId,
            binaryIndex,
            confidenceBps,
            uint64(block.timestamp)
        );
    }

    /// @dev The caller no longer supplies a reveal time: it comes from the
    ///      market's registered publicRevealAt. The old `revealAfter` argument
    ///      was overwritten on entry, so it was a no-op that still had to be
    ///      encoded by every caller.
    function submitFeedPacketFor(
        address agent,
        bytes32 feedId,
        bytes32 marketId,
        externalEuint8 actionInput,
        externalEuint16 signalInput,
        bytes calldata inputProof,
        bytes32 clientNonce
    ) external returns (bytes32 packetId) {
        if (!relayers[msg.sender]) revert NotRelayer();
        if (agent == address(0)) revert ZeroAgent();
        return _submitFeedPacket(
            agent, feedId, marketId, actionInput, signalInput, inputProof, clientNonce
        );
    }

    function _submitFeedPacket(
        address agent,
        bytes32 feedId,
        bytes32 marketId,
        externalEuint8 actionInput,
        externalEuint16 signalInput,
        bytes memory inputProof,
        bytes32 clientNonce
    ) internal returns (bytes32 packetId) {
        uint64 revealAfter;
        // The caller no longer chooses when a packet goes public. A
        // caller-supplied revealAfter let this path leak on its own schedule,
        // independent of the market's embargo — a second public-verdict surface
        // that silently voided the privacy promise the call path enforces.
        // The market's registered publicRevealAt is now authoritative here too.
        Market memory market = markets[marketId];
        if (market.publicRevealAt == 0) revert MarketNotFound();
        if (!market.active) revert MarketInactive();
        revealAfter = market.publicRevealAt;
        if (revealAfter <= block.timestamp) {
            revert RevealAfterMustBeFuture();
        }
        // Packets close at RESOLUTION, not at public reveal. Between the two
        // sits the embargo, during which the outcome is already known — a
        // packet accepted there predicts nothing, yet counts as delivered
        // feed evidence. Checking only publicRevealAt left that whole window
        // open.
        if (block.timestamp >= market.resolutionAt) {
            revert FeedWindowClosed();
        }

        packetId = keccak256(
            abi.encodePacked(
                block.chainid, address(this), agent, feedId, marketId, clientNonce
            )
        );
        if (feedPackets[packetId].state != CallState.None) revert PacketAlreadyExists();

        (euint8 sealedAction, euint16 sealedSignal) =
            _verifySealedPair(actionInput, signalInput, inputProof);
        FHE.allowThis(sealedAction);
        FHE.allowThis(sealedSignal);

        uint64 acceptedAt = uint64(block.timestamp);
        feedPackets[packetId] = SealedFeedPacket({
            agent: agent,
            feedId: feedId,
            marketId: marketId,
            acceptedAt: acceptedAt,
            revealAfter: revealAfter,
            action: sealedAction,
            signalBps: sealedSignal,
            revealedAction: 0,
            revealedSignalBps: 0,
            state: CallState.Sealed
        });

        emit FeedPacketSubmitted(
            packetId,
            agent,
            feedId,
            marketId,
            acceptedAt,
            revealAfter,
            FHE.unwrap(sealedAction),
            FHE.unwrap(sealedSignal),
            clientNonce
        );
    }

    function openFeedPacketReveal(bytes32 packetId) external {
        SealedFeedPacket storage packet = feedPackets[packetId];
        if (packet.state == CallState.None) revert PacketNotFound();
        if (packet.state != CallState.Sealed) revert WrongState();
        if (block.timestamp < packet.revealAfter) revert RevealWindowNotOpen();

        packet.state = CallState.Opened;
        FHE.allowPublic(packet.action);
        FHE.allowPublic(packet.signalBps);

        emit FeedPacketRevealOpened(
            packetId,
            FHE.unwrap(packet.action),
            FHE.unwrap(packet.signalBps),
            uint64(block.timestamp)
        );
    }

    function publishFeedPacketReveal(
        bytes32 packetId,
        uint8 action,
        uint16 signalBps,
        bytes calldata actionSignature,
        bytes calldata signalSignature
    ) external {
        SealedFeedPacket storage packet = feedPackets[packetId];
        if (packet.state == CallState.None) revert PacketNotFound();
        if (packet.state != CallState.Opened) revert WrongState();
        if (!FHE.verifyDecryptResult(packet.action, action, actionSignature)) {
            revert InvalidDecryptProof();
        }
        if (!FHE.verifyDecryptResult(packet.signalBps, signalBps, signalSignature)) {
            revert InvalidDecryptProof();
        }

        if (signalBps > 10000) {
            packet.state = CallState.Invalid;
            packet.revealedAction = action;
            packet.revealedSignalBps = signalBps;
            emit FeedPacketRevealInvalid(
                packetId,
                packet.agent,
                packet.feedId,
                packet.marketId,
                action,
                signalBps,
                uint8(InvalidRevealReason.SignalBps),
                uint64(block.timestamp)
            );
            return;
        }

        packet.state = CallState.Revealed;
        packet.revealedAction = action;
        packet.revealedSignalBps = signalBps;

        emit FeedPacketRevealed(
            packetId,
            packet.agent,
            packet.feedId,
            packet.marketId,
            action,
            signalBps,
            uint64(block.timestamp)
        );
    }

    function getFeedPacket(bytes32 packetId)
        external
        view
        returns (
            address agent,
            bytes32 feedId,
            bytes32 marketId,
            uint64 acceptedAt,
            uint64 revealAfter,
            bytes32 actionCtHash,
            bytes32 signalCtHash,
            uint8 revealedAction,
            uint16 revealedSignalBps,
            CallState state
        )
    {
        SealedFeedPacket storage packet = feedPackets[packetId];
        if (packet.state == CallState.None) revert PacketNotFound();
        return (
            packet.agent,
            packet.feedId,
            packet.marketId,
            packet.acceptedAt,
            packet.revealAfter,
            FHE.unwrap(packet.action),
            FHE.unwrap(packet.signalBps),
            packet.revealedAction,
            packet.revealedSignalBps,
            packet.state
        );
    }

    function feedPacketActionHandle(bytes32 packetId) external view returns (bytes32) {
        SealedFeedPacket storage packet = feedPackets[packetId];
        if (packet.state == CallState.None) revert PacketNotFound();
        return FHE.unwrap(packet.action);
    }

    function feedPacketSignalHandle(bytes32 packetId) external view returns (bytes32) {
        SealedFeedPacket storage packet = feedPackets[packetId];
        if (packet.state == CallState.None) revert PacketNotFound();
        return FHE.unwrap(packet.signalBps);
    }

    function getCall(bytes32 callId)
        external
        view
        returns (
            address agent,
            bytes32 marketId,
            uint64 acceptedAt,
            bytes32 binaryIndexCtHash,
            bytes32 confidenceCtHash,
            uint8 revealedBinaryIndex,
            uint16 revealedConfidenceBps,
            CallState state
        )
    {
        SealedCall storage sealedCall = calls[callId];
        if (sealedCall.state == CallState.None) revert CallNotFound();
        return (
            sealedCall.agent,
            sealedCall.marketId,
            sealedCall.acceptedAt,
            FHE.unwrap(sealedCall.binaryIndex),
            FHE.unwrap(sealedCall.confidenceBps),
            sealedCall.revealedBinaryIndex,
            sealedCall.revealedConfidenceBps,
            sealedCall.state
        );
    }

    function binaryIndexHandle(bytes32 callId) external view returns (bytes32) {
        SealedCall storage sealedCall = calls[callId];
        if (sealedCall.state == CallState.None) revert CallNotFound();
        return FHE.unwrap(sealedCall.binaryIndex);
    }

    function confidenceHandle(bytes32 callId) external view returns (bytes32) {
        SealedCall storage sealedCall = calls[callId];
        if (sealedCall.state == CallState.None) revert CallNotFound();
        return FHE.unwrap(sealedCall.confidenceBps);
    }

    function callPublicRevealAt(bytes32 callId) external view returns (uint64) {
        SealedCall storage sealedCall = calls[callId];
        if (sealedCall.state == CallState.None) revert CallNotFound();
        return sealedCall.publicRevealAt;
    }

    function callSubmissionClass(bytes32 callId) external view returns (SubmissionClass) {
        SealedCall storage sealedCall = calls[callId];
        if (sealedCall.state == CallState.None) revert CallNotFound();
        return sealedCall.submissionClass;
    }
}
