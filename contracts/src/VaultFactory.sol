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

    address[] public allowedTradeTokens;
    uint24[] public allowedFeeTiers;

    mapping(address => address) public vaults; // user => vault
    address[] public allVaults;

    event VaultCreated(address indexed user, address indexed vault);
    event DefaultsUpdated(uint256 maxTradeAmount, uint256 dailyLimit);
    event AgentUpdated(address indexed agent);
    event RouterUpdated(address indexed router);
    event TradeAllowlistUpdated(address[] allowedTradeTokens, uint24[] allowedFeeTiers);

    modifier onlyAdmin() {
        require(msg.sender == admin, "Not admin");
        _;
    }

    constructor(
        address _agent,
        address _router,
        uint256 _defaultMaxTrade,
        uint256 _defaultDailyLimit,
        address[] memory _allowedTradeTokens,
        uint24[] memory _allowedFeeTiers
    ) {
        require(_agent != address(0), "Zero agent address");
        require(_router != address(0), "Zero router address");
        require(_router.code.length > 0, "Router is not a contract");
        require(_defaultMaxTrade > 0, "Zero max trade");
        require(_defaultDailyLimit >= _defaultMaxTrade, "Invalid daily limit");

        _validateAllowlist(_allowedTradeTokens, _allowedFeeTiers);

        admin = msg.sender;
        agent = _agent;
        router = _router;
        defaultMaxTrade = _defaultMaxTrade;
        defaultDailyLimit = _defaultDailyLimit;
        allowedTradeTokens = _allowedTradeTokens;
        allowedFeeTiers = _allowedFeeTiers;
    }

    /// @notice Create a vault for the caller. Reverts if one already exists.
    function createVault() external returns (address) {
        require(vaults[msg.sender] == address(0), "Vault already exists");

        TradeVault vault = new TradeVault(
            msg.sender,
            agent,
            router,
            defaultMaxTrade,
            defaultDailyLimit,
            _copyAllowedTradeTokens(),
            _copyAllowedFeeTiers()
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
        require(_maxTrade > 0, "Zero max trade");
        require(_dailyLimit >= _maxTrade, "Invalid daily limit");

        defaultMaxTrade = _maxTrade;
        defaultDailyLimit = _dailyLimit;

        emit DefaultsUpdated(_maxTrade, _dailyLimit);
    }

    /// @notice Update agent for future vaults
    function setAgent(address _agent) external onlyAdmin {
        require(_agent != address(0), "Zero agent address");

        agent = _agent;

        emit AgentUpdated(_agent);
    }

    /// @notice Update router for future vaults
    function setRouter(address _router) external onlyAdmin {
        require(_router != address(0), "Zero router address");
        require(_router.code.length > 0, "Router is not a contract");

        router = _router;

        emit RouterUpdated(_router);
    }

    /// @notice Update trade allowlists for future vaults
    function setTradeAllowlist(
        address[] calldata _allowedTradeTokens,
        uint24[] calldata _allowedFeeTiers
    ) external onlyAdmin {
        _validateAllowlist(_allowedTradeTokens, _allowedFeeTiers);

        delete allowedTradeTokens;
        delete allowedFeeTiers;

        for (uint256 i = 0; i < _allowedTradeTokens.length; i++) {
            allowedTradeTokens.push(_allowedTradeTokens[i]);
        }

        for (uint256 i = 0; i < _allowedFeeTiers.length; i++) {
            allowedFeeTiers.push(_allowedFeeTiers[i]);
        }

        emit TradeAllowlistUpdated(_copyAllowedTradeTokens(), _copyAllowedFeeTiers());
    }

    function totalVaults() external view returns (uint256) {
        return allVaults.length;
    }

    function allowedTradeTokensCount() external view returns (uint256) {
        return allowedTradeTokens.length;
    }

    function allowedFeeTiersCount() external view returns (uint256) {
        return allowedFeeTiers.length;
    }

    function _validateAllowlist(
        address[] memory _allowedTradeTokens,
        uint24[] memory _allowedFeeTiers
    ) internal pure {
        require(_allowedTradeTokens.length > 0, "No allowed tokens");
        require(_allowedFeeTiers.length > 0, "No allowed fee tiers");

        for (uint256 i = 0; i < _allowedTradeTokens.length; i++) {
            require(_allowedTradeTokens[i] != address(0), "Zero token address");

            for (uint256 j = i + 1; j < _allowedTradeTokens.length; j++) {
                require(_allowedTradeTokens[i] != _allowedTradeTokens[j], "Duplicate token");
            }
        }

        for (uint256 i = 0; i < _allowedFeeTiers.length; i++) {
            require(_allowedFeeTiers[i] > 0, "Zero fee tier");

            for (uint256 j = i + 1; j < _allowedFeeTiers.length; j++) {
                require(_allowedFeeTiers[i] != _allowedFeeTiers[j], "Duplicate fee tier");
            }
        }
    }

    function _copyAllowedTradeTokens() internal view returns (address[] memory tokens) {
        tokens = new address[](allowedTradeTokens.length);

        for (uint256 i = 0; i < allowedTradeTokens.length; i++) {
            tokens[i] = allowedTradeTokens[i];
        }
    }

    function _copyAllowedFeeTiers() internal view returns (uint24[] memory feeTiers) {
        feeTiers = new uint24[](allowedFeeTiers.length);

        for (uint256 i = 0; i < allowedFeeTiers.length; i++) {
            feeTiers[i] = allowedFeeTiers[i];
        }
    }
}
