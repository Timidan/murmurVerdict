// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/AgentRegistry.sol";

contract DeployAgentRegistry is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("AGENT_PRIVATE_KEY");
        address agentAddress = vm.envAddress("AGENT_ADDRESS");

        vm.startBroadcast(deployerPrivateKey);

        AgentRegistry registry = new AgentRegistry();
        console.log("AgentRegistry deployed at:", address(registry));

        registry.authorizeAgent(agentAddress);
        console.log("Authorized agent:", agentAddress);

        vm.stopBroadcast();
    }
}
