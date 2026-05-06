// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/VaultFactory.sol";

contract DeployVaultFactory is Script {
    uint256 private constant BASE_SEPOLIA_CHAIN_ID = 84532;

    // Uniswap V3 SwapRouter02 on Base Sepolia
    address private constant BASE_SEPOLIA_SWAP_ROUTER = 0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4;

    // Explicit Base Sepolia allowlist. Keep this in sync with dashboard/executor token config.
    address private constant BASE_SEPOLIA_USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;
    address private constant BASE_SEPOLIA_WETH = 0x4200000000000000000000000000000000000006;

    function run() external {
        require(block.chainid == BASE_SEPOLIA_CHAIN_ID, "Wrong chain for Base Sepolia deployment");

        uint256 deployerPrivateKey = vm.envUint("AGENT_PRIVATE_KEY");
        address agentAddress = vm.envAddress("AGENT_ADDRESS");

        address router = BASE_SEPOLIA_SWAP_ROUTER;

        address[] memory allowedTokens = new address[](2);
        allowedTokens[0] = BASE_SEPOLIA_USDC;
        allowedTokens[1] = BASE_SEPOLIA_WETH;

        uint24[] memory allowedFeeTiers = new uint24[](3);
        allowedFeeTiers[0] = 500;
        allowedFeeTiers[1] = 3000;
        allowedFeeTiers[2] = 10000;

        // Default limits: 50 USDC max trade, 200 USDC daily (6 decimals)
        uint256 defaultMaxTrade = 50_000_000;
        uint256 defaultDailyLimit = 200_000_000;

        vm.startBroadcast(deployerPrivateKey);

        VaultFactory factory = new VaultFactory(
            agentAddress,
            router,
            defaultMaxTrade,
            defaultDailyLimit,
            allowedTokens,
            allowedFeeTiers
        );
        console.log("VaultFactory deployed at:", address(factory));

        vm.stopBroadcast();
    }
}
