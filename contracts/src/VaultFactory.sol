// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TradeVault} from "./TradeVault.sol";

/**
 * @title VaultFactory
 * @notice Deploys a TradeVault per user. The agent address and router
 *         are set at factory level. Each user gets their own vault
 *         with independent limits and balances.
 */
contract VaultFactory {
    address public agent;
    address public router;
    uint256 public defaultMaxTrade;
    uint256 public defaultDailyLimit;
    address public admin;

    mapping(address => address) public vaults; // user => vault
    address[] public allVaults;

    event VaultCreated(address indexed user, address indexed vault);

    modifier onlyAdmin() {
        require(msg.sender == admin, "Not admin");
        _;
    }

    constructor(
        address _agent,
        address _router,
        uint256 _defaultMaxTrade,
        uint256 _defaultDailyLimit
    ) {
        admin = msg.sender;
        agent = _agent;
        router = _router;
        defaultMaxTrade = _defaultMaxTrade;
        defaultDailyLimit = _defaultDailyLimit;
    }

    /// @notice Create a vault for the caller. Reverts if one already exists.
    function createVault() external returns (address) {
        require(vaults[msg.sender] == address(0), "Vault already exists");

        TradeVault vault = new TradeVault(
            msg.sender,
            agent,
            router,
            defaultMaxTrade,
            defaultDailyLimit
        );

        vaults[msg.sender] = address(vault);
        allVaults.push(address(vault));

        emit VaultCreated(msg.sender, address(vault));
        return address(vault);
    }

    /// @notice Get the vault for a user (returns address(0) if none)
    function getVault(address user) external view returns (address) {
        return vaults[user];
    }

    /// @notice Update defaults for future vaults
    function setDefaults(uint256 _maxTrade, uint256 _dailyLimit) external onlyAdmin {
        defaultMaxTrade = _maxTrade;
        defaultDailyLimit = _dailyLimit;
    }

    /// @notice Update agent for future vaults
    function setAgent(address _agent) external onlyAdmin {
        agent = _agent;
    }

    function totalVaults() external view returns (uint256) {
        return allVaults.length;
    }
}
