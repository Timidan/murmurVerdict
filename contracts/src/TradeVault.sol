// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "forge-std/interfaces/IERC20.sol";

/// @notice Minimal interface for Uniswap V3 SwapRouter exactInputSingle
interface ISwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        payable
        returns (uint256 amountOut);
}

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

    /// @dev token address => whether the vault may trade this token
    mapping(address => bool) public allowedTokens;

    /// @dev Uniswap V3 fee tier => whether the vault may use this pool fee
    mapping(uint24 => bool) public allowedFees;

    bool private _locked;

    uint256 public maxTradeAmount;  // max per-trade in token decimals
    uint256 public dailyLimit;      // max daily spend in token decimals
    uint256 public dailySpent;      // running daily spend
    uint256 public lastResetDay;    // day number of last reset

    // ─── Events ─────────────────────────────────────────────────────────────

    event Deposited(address indexed token, uint256 amount);
    event Withdrawn(address indexed token, uint256 amount);
    event TradeExecuted(address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut);
    event AgentUpdated(address indexed newAgent);
    event Paused();
    event Unpaused();
    event LimitsUpdated(uint256 maxTradeAmount, uint256 dailyLimit);
    event TokenAllowlistUpdated(address indexed token, bool allowed);
    event FeeAllowlistUpdated(uint24 indexed fee, bool allowed);
    event EthWithdrawn(uint256 amount);

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

    modifier nonReentrant() {
        require(!_locked, "Reentrant call");
        _locked = true;
        _;
        _locked = false;
    }

    // ─── Constructor ────────────────────────────────────────────────────────

    constructor(
        address _owner,
        address _agent,
        address _router,
        uint256 _maxTradeAmount,
        uint256 _dailyLimit,
        address[] memory _allowedTokens,
        uint24[] memory _allowedFees
    ) {
        require(_owner != address(0), "Zero owner address");
        require(_agent != address(0), "Zero agent address");
        require(_router != address(0), "Zero router address");
        require(_router.code.length > 0, "Router is not a contract");
        require(_maxTradeAmount > 0, "Zero max trade amount");
        require(_dailyLimit >= _maxTradeAmount, "Invalid daily limit");
        require(_allowedTokens.length > 0, "No allowed tokens");
        require(_allowedFees.length > 0, "No allowed fee tiers");

        owner = _owner;
        agent = _agent;
        router = _router;
        maxTradeAmount = _maxTradeAmount;
        dailyLimit = _dailyLimit;
        lastResetDay = block.timestamp / 1 days;

        for (uint256 i = 0; i < _allowedTokens.length; i++) {
            address token = _allowedTokens[i];
            require(token != address(0), "Zero token address");
            require(token.code.length > 0, "Token is not a contract");
            require(!allowedTokens[token], "Duplicate token");
            allowedTokens[token] = true;
            emit TokenAllowlistUpdated(token, true);
        }

        for (uint256 i = 0; i < _allowedFees.length; i++) {
            uint24 fee = _allowedFees[i];
            require(_isSupportedFee(fee), "Unsupported fee tier");
            require(!allowedFees[fee], "Duplicate fee tier");
            allowedFees[fee] = true;
            emit FeeAllowlistUpdated(fee, true);
        }
    }

    // ─── Internal Safe ERC20 Helpers ────────────────────────────────────────

    function _requireContract(address target, string memory message) private view {
        require(target.code.length > 0, message);
    }

    function _safeTransfer(address token, address to, uint256 amount) private {
        _requireContract(token, "Token is not a contract");
        (bool success, bytes memory returndata) = token.call(
            abi.encodeWithSelector(IERC20.transfer.selector, to, amount)
        );
        require(
            success && (returndata.length == 0 || abi.decode(returndata, (bool))),
            "SafeERC20: transfer failed"
        );
    }

    function _safeTransferFrom(address token, address from, address to, uint256 amount) private {
        _requireContract(token, "Token is not a contract");
        (bool success, bytes memory returndata) = token.call(
            abi.encodeWithSelector(IERC20.transferFrom.selector, from, to, amount)
        );
        require(
            success && (returndata.length == 0 || abi.decode(returndata, (bool))),
            "SafeERC20: transferFrom failed"
        );
    }

    function _safeApprove(address token, address spender, uint256 amount) private {
        _requireContract(token, "Token is not a contract");
        _requireContract(spender, "Spender is not a contract");
        (bool success, bytes memory returndata) = token.call(
            abi.encodeWithSelector(IERC20.approve.selector, spender, amount)
        );
        require(
            success && (returndata.length == 0 || abi.decode(returndata, (bool))),
            "SafeERC20: approve failed"
        );
    }

    // ─── Owner Functions ────────────────────────────────────────────────────

    /// @notice Deposit ERC20 tokens into the vault
    function deposit(address token, uint256 amount) external onlyOwner nonReentrant {
        require(amount > 0, "Zero deposit amount");
        _safeTransferFrom(token, msg.sender, address(this), amount);
        emit Deposited(token, amount);
    }

    /// @notice Withdraw tokens back to the owner
    function withdraw(address token, uint256 amount) external onlyOwner nonReentrant {
        require(amount > 0, "Zero withdraw amount");
        _safeTransfer(token, owner, amount);
        emit Withdrawn(token, amount);
    }

    /// @notice Withdraw all of a token back to the owner
    function withdrawAll(address token) external onlyOwner nonReentrant {
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance > 0) {
            _safeTransfer(token, owner, balance);
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
        require(_agent != address(0), "Zero agent address");
        agent = _agent;
        emit AgentUpdated(_agent);
    }

    /// @notice Update trade limits
    function setLimits(uint256 _maxTradeAmount, uint256 _dailyLimit) external onlyOwner {
        require(_maxTradeAmount > 0, "Zero max trade amount");
        require(_dailyLimit >= _maxTradeAmount, "Invalid daily limit");
        maxTradeAmount = _maxTradeAmount;
        dailyLimit = _dailyLimit;
        emit LimitsUpdated(_maxTradeAmount, _dailyLimit);
    }

    /// @notice Allow or disallow an ERC20 token for agent-initiated swaps.
    function setAllowedToken(address token, bool allowed) external onlyOwner {
        require(token != address(0), "Zero token address");
        _requireContract(token, "Token is not a contract");
        allowedTokens[token] = allowed;
        emit TokenAllowlistUpdated(token, allowed);
    }

    /// @notice Allow or disallow a Uniswap V3 fee tier for agent-initiated swaps.
    function setAllowedFee(uint24 fee, bool allowed) external onlyOwner {
        require(_isSupportedFee(fee), "Unsupported fee tier");
        allowedFees[fee] = allowed;
        emit FeeAllowlistUpdated(fee, allowed);
    }

    // ─── Agent Functions ────────────────────────────────────────────────────

    /// @notice Execute a swap through the approved router using Uniswap V3 exactInputSingle
    /// @param tokenIn The token to sell
    /// @param tokenOut The token to buy
    /// @param amountIn The amount of tokenIn to swap
    /// @param minAmountOut Minimum amount of tokenOut to receive (slippage protection)
    /// @param fee The Uniswap V3 pool fee tier (e.g. 500, 3000, 10000)
    function executeTrade(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        uint24 fee
    ) external onlyAgent whenNotPaused nonReentrant {
        require(tokenIn != address(0), "Zero tokenIn address");
        require(tokenOut != address(0), "Zero tokenOut address");
        require(tokenIn != tokenOut, "Identical tokens");
        require(amountIn > 0, "Zero trade amount");
        require(minAmountOut > 0, "Zero min output");
        require(allowedTokens[tokenIn], "tokenIn not allowed");
        require(allowedTokens[tokenOut], "tokenOut not allowed");
        require(allowedFees[fee], "Fee tier not allowed");
        require(IERC20(tokenIn).balanceOf(address(this)) >= amountIn, "Insufficient balance");

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

        // Approve only the exact trade amount, then clear allowance after the swap.
        _safeApprove(tokenIn, router, 0);
        _safeApprove(tokenIn, router, amountIn);

        // Execute the swap via Uniswap V3 exactInputSingle
        uint256 amountOut = ISwapRouter(router).exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                fee: fee,
                recipient: address(this),
                amountIn: amountIn,
                amountOutMinimum: minAmountOut,
                sqrtPriceLimitX96: 0
            })
        );

        _safeApprove(tokenIn, router, 0);

        emit TradeExecuted(tokenIn, tokenOut, amountIn, amountOut);
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

    /// @notice Withdraw native ETH accidentally sent or force-sent to the vault.
    function withdrawETH(uint256 amount) external onlyOwner nonReentrant {
        require(amount > 0, "Zero ETH amount");
        require(address(this).balance >= amount, "Insufficient ETH balance");

        (bool success, ) = owner.call{value: amount}("");
        require(success, "ETH transfer failed");

        emit EthWithdrawn(amount);
    }

    /// @notice Withdraw all native ETH from the vault.
    function withdrawAllETH() external onlyOwner nonReentrant {
        uint256 balance = address(this).balance;
        require(balance > 0, "No ETH balance");

        (bool success, ) = owner.call{value: balance}("");
        require(success, "ETH transfer failed");

        emit EthWithdrawn(balance);
    }

    function _isSupportedFee(uint24 fee) private pure returns (bool) {
        return fee == 100 || fee == 500 || fee == 3000 || fee == 10000;
    }

    // Allow receiving ETH
    receive() external payable {}
}
