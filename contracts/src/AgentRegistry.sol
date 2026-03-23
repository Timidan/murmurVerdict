// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title AgentRegistry — ERC-8004 Attestation Registry for Autonomous Agents
/// @notice Stores immutable attestation records for agent decision receipts on Base Mainnet.
///         Each attestation links a keccak256 receipt hash to an IPFS/Filecoin metadata URI.
///         Only authorized agents can submit attestations.
contract AgentRegistry {
    struct Attestation {
        bytes32 receiptHash;
        string metadataUri;
        string actionType;
        uint256 timestamp;
        uint256 attestationId;
    }

    address public owner;
    uint256 private _nextId = 1;

    /// @dev agent address => whether authorized to attest
    mapping(address => bool) public authorizedAgents;

    /// @dev agent address => list of attestations
    mapping(address => Attestation[]) private _attestations;

    /// @dev receiptHash => attesting agent (prevents duplicate attestations for same hash)
    mapping(bytes32 => address) public attestedBy;

    event AgentAttested(
        address indexed agent,
        bytes32 indexed receiptHash,
        uint256 attestationId,
        string metadataUri,
        string actionType
    );
    event AgentAuthorized(address indexed agent);
    event AgentRevoked(address indexed agent);

    error AlreadyAttested(bytes32 receiptHash, address existingAgent);
    error EmptyReceiptHash();
    error EmptyMetadataUri();
    error NotOwner();
    error NotAuthorizedAgent();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    /// @notice Authorize an agent address to submit attestations.
    function authorizeAgent(address agent) external onlyOwner {
        authorizedAgents[agent] = true;
        emit AgentAuthorized(agent);
    }

    /// @notice Revoke an agent's authorization.
    function revokeAgent(address agent) external onlyOwner {
        authorizedAgents[agent] = false;
        emit AgentRevoked(agent);
    }

    /// @notice Record an attestation for a decision receipt.
    /// @param receiptHash Keccak256 hash of the canonical receipt JSON.
    /// @param metadataUri IPFS/Filecoin URI pointing to the full receipt (e.g. "ipfs://Qm...").
    /// @param actionType The action taken — "buy", "exit", "reduce", or "hold".
    /// @return attestationId The unique ID of this attestation.
    function attest(
        bytes32 receiptHash,
        string calldata metadataUri,
        string calldata actionType
    ) external returns (uint256 attestationId) {
        if (!authorizedAgents[msg.sender]) revert NotAuthorizedAgent();
        if (receiptHash == bytes32(0)) revert EmptyReceiptHash();
        if (bytes(metadataUri).length == 0) revert EmptyMetadataUri();
        if (attestedBy[receiptHash] != address(0)) {
            revert AlreadyAttested(receiptHash, attestedBy[receiptHash]);
        }

        attestationId = _nextId++;
        attestedBy[receiptHash] = msg.sender;

        _attestations[msg.sender].push(
            Attestation({
                receiptHash: receiptHash,
                metadataUri: metadataUri,
                actionType: actionType,
                timestamp: block.timestamp,
                attestationId: attestationId
            })
        );

        emit AgentAttested(msg.sender, receiptHash, attestationId, metadataUri, actionType);
    }

    /// @notice Get all attestations for a given agent.
    function getAttestations(address agent) external view returns (Attestation[] memory) {
        return _attestations[agent];
    }

    /// @notice Get the number of attestations for a given agent.
    function attestationCount(address agent) external view returns (uint256) {
        return _attestations[agent].length;
    }
}
