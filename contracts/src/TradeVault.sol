// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "forge-std/interfaces/IERC20.sol";

/**
 * @title TradeVault
 * @notice Per-user vault for autonomous trading. User deposits funds,
 *         authorizes an agent address, and the agent can swap via an
 *         approved DEX router within configurable limits.
 *         User can pause, withdraw, and revoke at any time.
 */
contract TradeVault {
    // ─── State ──────────────────────────────────────────────────────────────

    address public owner;           // user who controls this vault
    address public agent;           // authorized agent address
    address public router;          // approved DEX router (Uniswap SwapRouter02)

    bool public paused;

    uint256 public maxTradeAmount;  // max per-trade in token decimals
    uint256 public dailyLimit;      // max daily spend in token decimals
    uint256 public dailySpent;      // running daily spend
    uint256 public lastResetDay;    // day number of last reset

    // ─── Events ─────────────────────────────────────────────────────────────

    event Deposited(address indexed token, uint256 amount);
    event Withdrawn(address indexed token, uint256 amount);
    event TradeExecuted(address indexed tokenIn, address indexed tokenOut, uint256 amountIn);
    event AgentUpdated(address indexed newAgent);
    event Paused();
    event Unpaused();
    event LimitsUpdated(uint256 maxTradeAmount, uint256 dailyLimit);

    // ─── Modifiers ──────────────────────────────────────────────────────────

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    modifier onlyAgent() {
        require(msg.sender == agent, "Not agent");
        _;
    }

    modifier whenNotPaused() {
        require(!paused, "Vault is paused");
        _;
    }

    // ─── Constructor ────────────────────────────────────────────────────────

    constructor(
        address _owner,
        address _agent,
        address _router,
        uint256 _maxTradeAmount,
        uint256 _dailyLimit
    ) {
        owner = _owner;
        agent = _agent;
        router = _router;
        maxTradeAmount = _maxTradeAmount;
        dailyLimit = _dailyLimit;
        lastResetDay = block.timestamp / 1 days;
    }

    // ─── Owner Functions ────────────────────────────────────────────────────

    /// @notice Deposit ERC20 tokens into the vault
    function deposit(address token, uint256 amount) external {
        IERC20(token).transferFrom(msg.sender, address(this), amount);
        emit Deposited(token, amount);
    }

    /// @notice Withdraw tokens back to the owner
    function withdraw(address token, uint256 amount) external onlyOwner {
        IERC20(token).transfer(owner, amount);
        emit Withdrawn(token, amount);
    }

    /// @notice Withdraw all of a token back to the owner
    function withdrawAll(address token) external onlyOwner {
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance > 0) {
            IERC20(token).transfer(owner, balance);
            emit Withdrawn(token, balance);
        }
    }

    /// @notice Pause trading (emergency stop)
    function pause() external onlyOwner {
        paused = true;
        emit Paused();
    }

    /// @notice Resume trading
    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused();
    }

    /// @notice Update the authorized agent
    function setAgent(address _agent) external onlyOwner {
        agent = _agent;
        emit AgentUpdated(_agent);
    }

    /// @notice Update trade limits
    function setLimits(uint256 _maxTradeAmount, uint256 _dailyLimit) external onlyOwner {
        maxTradeAmount = _maxTradeAmount;
        dailyLimit = _dailyLimit;
        emit LimitsUpdated(_maxTradeAmount, _dailyLimit);
    }

    // ─── Agent Functions ────────────────────────────────────────────────────

    /// @notice Execute a swap through the approved router
    /// @dev Agent approves the router, then calls it with arbitrary calldata.
    ///      Only the pre-approved router address can be called.
    function executeTrade(
        address tokenIn,
        uint256 amountIn,
        bytes calldata routerCalldata
    ) external onlyAgent whenNotPaused {
        // Daily reset
        uint256 currentDay = block.timestamp / 1 days;
        if (currentDay > lastResetDay) {
            dailySpent = 0;
            lastResetDay = currentDay;
        }

        // Check limits
        require(amountIn <= maxTradeAmount, "Exceeds max trade amount");
        require(dailySpent + amountIn <= dailyLimit, "Exceeds daily limit");

        // Update daily counter
        dailySpent += amountIn;

        // Approve router to spend tokenIn
        IERC20(tokenIn).approve(router, amountIn);

        // Execute the swap via the approved router
        (bool success, ) = router.call(routerCalldata);
        require(success, "Router call failed");

        emit TradeExecuted(tokenIn, address(0), amountIn);
    }

    // ─── View Functions ─────────────────────────────────────────────────────

    /// @notice Get the vault's balance of a token
    function balanceOf(address token) external view returns (uint256) {
        return IERC20(token).balanceOf(address(this));
    }

    /// @notice Get remaining daily allowance
    function dailyRemaining() external view returns (uint256) {
        uint256 currentDay = block.timestamp / 1 days;
        if (currentDay > lastResetDay) return dailyLimit;
        if (dailySpent >= dailyLimit) return 0;
        return dailyLimit - dailySpent;
    }

    /// @notice Check if the vault can execute a trade of given amount
    function canTrade(uint256 amountIn) external view returns (bool) {
        if (paused) return false;
        if (amountIn > maxTradeAmount) return false;
        uint256 currentDay = block.timestamp / 1 days;
        uint256 spent = currentDay > lastResetDay ? 0 : dailySpent;
        if (spent + amountIn > dailyLimit) return false;
        return true;
    }

    // Allow receiving ETH
    receive() external payable {}
}
