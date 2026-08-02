// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {FHE, InEuint8, InEuint16, euint8, euint16} from "@fhenixprotocol/cofhe-contracts/FHE.sol";

/// @title MurmurSealedVerdicts
/// @notice Canonical sealed-call entrypoint for Murmur Verdict.
/// @dev Verdict data is encrypted at submit time and becomes publicly
///      decryptable only after the registered market reveal window opens.
contract MurmurSealedVerdicts {
    error NotOwner();
    error MarketInactive();
    error MarketNotFound();
    error HorizonMustBePositive();
    error CallNotFound();
    error CallAlreadyExists();
    error WrongState();
    error RevealWindowNotOpen();
    error InvalidDecryptProof();
    error PacketNotFound();
    error PacketAlreadyExists();
    error RevealAfterMustBeFuture();
    error ZeroOwner();
    error NotPendingOwner();
    error NotRelayer();
    error ZeroRelayer();
    error ZeroAgent();
    error NotGrantor();
    error ZeroGrantor();
    error ZeroSubscriber();
    error DecryptGrantWindowClosed();

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

    struct Market {
        uint64 horizonSeconds;
        uint64 fixedRevealAfter;
        bool active;
    }

    struct SealedCall {
        address agent;
        bytes32 marketId;
        uint64 acceptedAt;
        uint64 revealOpenAt;
        euint8 binaryIndex;
        euint16 confidenceBps;
        uint8 revealedBinaryIndex;
        uint16 revealedConfidenceBps;
        CallState state;
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
    event MarketRegistered(bytes32 indexed marketId, uint64 horizonSeconds, bool active);
    event FixedRevealMarketRegistered(bytes32 indexed marketId, uint64 revealAfter, bool active);
    event MarketActiveSet(bytes32 indexed marketId, bool active);
    event SealedCallSubmitted(
        bytes32 indexed callId,
        address indexed agent,
        bytes32 indexed marketId,
        uint64 acceptedAt,
        uint64 revealOpenAt,
        bytes32 binaryIndexCtHash,
        bytes32 confidenceCtHash,
        bytes32 clientNonce
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
    /// @dev Grant-only Flow 2 v1: Murmur brokers this after verifying an
    ///      off-chain payment. Enforced strictly inside the sale window
    ///      (state == Sealed && block.timestamp < revealOpenAt) so a grant can
    ///      never be produced after the value is (or is about to become)
    ///      public via openReveal. `FHE.allow` is persistent: the subscriber
    ///      keeps read access across the call's later openReveal/allowPublic
    ///      and state changes. Idempotent per (callId, subscriber).
    function grantDecryptAccess(bytes32 callId, address subscriber) external onlyGrantor {
        SealedCall storage sealedCall = calls[callId];
        if (sealedCall.state == CallState.None) revert CallNotFound();
        if (subscriber == address(0)) revert ZeroSubscriber();
        if (sealedCall.state != CallState.Sealed || block.timestamp >= sealedCall.revealOpenAt) {
            revert DecryptGrantWindowClosed();
        }

        if (decryptAccessGranted[callId][subscriber]) return;

        decryptAccessGranted[callId][subscriber] = true;
        FHE.allow(sealedCall.binaryIndex, subscriber);
        FHE.allow(sealedCall.confidenceBps, subscriber);

        emit DecryptAccessGranted(callId, subscriber);
    }

    /// @notice Subscriber-facing view for the paid decrypt-grant flow: the
    ///         reveal-window state, both ciphertext handles, and whether the
    ///         given subscriber already holds an early grant.
    function getDecryptAccess(bytes32 callId, address subscriber)
        external
        view
        returns (
            CallState state,
            uint64 revealOpenAt,
            bytes32 binaryIndexCtHash,
            bytes32 confidenceCtHash,
            bool alreadyGranted
        )
    {
        SealedCall storage sealedCall = calls[callId];
        if (sealedCall.state == CallState.None) revert CallNotFound();
        return (
            sealedCall.state,
            sealedCall.revealOpenAt,
            FHE.unwrap(sealedCall.binaryIndex),
            FHE.unwrap(sealedCall.confidenceBps),
            decryptAccessGranted[callId][subscriber]
        );
    }

    function registerMarket(bytes32 marketId, uint64 horizonSeconds, bool active)
        external
        onlyOwner
    {
        if (horizonSeconds == 0) revert HorizonMustBePositive();
        markets[marketId] =
            Market({horizonSeconds: horizonSeconds, fixedRevealAfter: 0, active: active});
        emit MarketRegistered(marketId, horizonSeconds, active);
    }

    function registerFixedRevealMarket(bytes32 marketId, uint64 revealAfter, bool active)
        external
        onlyOwner
    {
        if (revealAfter <= block.timestamp) revert RevealAfterMustBeFuture();
        markets[marketId] =
            Market({horizonSeconds: 0, fixedRevealAfter: revealAfter, active: active});
        emit FixedRevealMarketRegistered(marketId, revealAfter, active);
    }

    function setMarketActive(bytes32 marketId, bool active) external onlyOwner {
        Market storage market = markets[marketId];
        if (market.horizonSeconds == 0 && market.fixedRevealAfter == 0) revert MarketNotFound();
        market.active = active;
        emit MarketActiveSet(marketId, active);
    }

    function submitSealedFor(
        address agent,
        bytes32 marketId,
        InEuint8 memory binaryIndexInput,
        InEuint16 memory confidenceInput,
        bytes32 clientNonce
    ) external returns (bytes32 callId) {
        if (!relayers[msg.sender]) revert NotRelayer();
        if (agent == address(0)) revert ZeroAgent();
        return _submitSealed(agent, marketId, binaryIndexInput, confidenceInput, clientNonce);
    }

    function _submitSealed(
        address agent,
        bytes32 marketId,
        InEuint8 memory binaryIndexInput,
        InEuint16 memory confidenceInput,
        bytes32 clientNonce
    ) internal returns (bytes32 callId) {
        Market memory market = markets[marketId];
        if (market.horizonSeconds == 0 && market.fixedRevealAfter == 0) revert MarketNotFound();
        if (!market.active) revert MarketInactive();

        callId = keccak256(
            abi.encodePacked(block.chainid, address(this), agent, marketId, clientNonce)
        );
        if (calls[callId].state != CallState.None) revert CallAlreadyExists();

        uint64 acceptedAt = uint64(block.timestamp);
        uint64 revealOpenAt = _revealOpenAt(market, acceptedAt);
        if (revealOpenAt <= acceptedAt) revert RevealAfterMustBeFuture();

        euint8 sealedBinaryIndex = FHE.asEuint8(binaryIndexInput);
        euint16 sealedConfidence = FHE.asEuint16(confidenceInput);
        FHE.allowThis(sealedBinaryIndex);
        FHE.allowThis(sealedConfidence);

        calls[callId] = SealedCall({
            agent: agent,
            marketId: marketId,
            acceptedAt: acceptedAt,
            revealOpenAt: revealOpenAt,
            binaryIndex: sealedBinaryIndex,
            confidenceBps: sealedConfidence,
            revealedBinaryIndex: 0,
            revealedConfidenceBps: 0,
            state: CallState.Sealed
        });

        emit SealedCallSubmitted(
            callId,
            agent,
            marketId,
            acceptedAt,
            revealOpenAt,
            FHE.unwrap(sealedBinaryIndex),
            FHE.unwrap(sealedConfidence),
            clientNonce
        );
    }

    function openReveal(bytes32 callId) external {
        SealedCall storage sealedCall = calls[callId];
        if (sealedCall.state == CallState.None) revert CallNotFound();
        if (sealedCall.state != CallState.Sealed) revert WrongState();

        if (block.timestamp < sealedCall.revealOpenAt) revert RevealWindowNotOpen();

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

    function submitFeedPacketFor(
        address agent,
        bytes32 feedId,
        bytes32 marketId,
        uint64 revealAfter,
        InEuint8 memory actionInput,
        InEuint16 memory signalInput,
        bytes32 clientNonce
    ) external returns (bytes32 packetId) {
        if (!relayers[msg.sender]) revert NotRelayer();
        if (agent == address(0)) revert ZeroAgent();
        return _submitFeedPacket(
            agent, feedId, marketId, revealAfter, actionInput, signalInput, clientNonce
        );
    }

    function _submitFeedPacket(
        address agent,
        bytes32 feedId,
        bytes32 marketId,
        uint64 revealAfter,
        InEuint8 memory actionInput,
        InEuint16 memory signalInput,
        bytes32 clientNonce
    ) internal returns (bytes32 packetId) {
        if (revealAfter <= block.timestamp) {
            revert RevealAfterMustBeFuture();
        }

        packetId = keccak256(
            abi.encodePacked(
                block.chainid, address(this), agent, feedId, marketId, clientNonce
            )
        );
        if (feedPackets[packetId].state != CallState.None) revert PacketAlreadyExists();

        euint8 sealedAction = FHE.asEuint8(actionInput);
        euint16 sealedSignal = FHE.asEuint16(signalInput);
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

    function callRevealOpenAt(bytes32 callId) external view returns (uint64) {
        SealedCall storage sealedCall = calls[callId];
        if (sealedCall.state == CallState.None) revert CallNotFound();
        return sealedCall.revealOpenAt;
    }

    function _revealOpenAt(Market memory market, uint64 acceptedAt) private pure returns (uint64) {
        if (market.fixedRevealAfter != 0) return market.fixedRevealAfter;
        return acceptedAt + market.horizonSeconds;
    }
}
