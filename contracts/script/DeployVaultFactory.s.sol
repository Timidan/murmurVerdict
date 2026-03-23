// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/VaultFactory.sol";

contract DeployVaultFactory is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("AGENT_PRIVATE_KEY");
        address agentAddress = vm.envAddress("AGENT_ADDRESS");

        // Uniswap V3 SwapRouter02 on Base Sepolia
        address router = 0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4;

        // Default limits: 50 USDC max trade, 200 USDC daily (6 decimals)
        uint256 defaultMaxTrade = 50_000_000;
        uint256 defaultDailyLimit = 200_000_000;

        vm.startBroadcast(deployerPrivateKey);

        VaultFactory factory = new VaultFactory(
            agentAddress,
            router,
            defaultMaxTrade,
            defaultDailyLimit
        );
        console.log("VaultFactory deployed at:", address(factory));

        vm.stopBroadcast();
    }
}
