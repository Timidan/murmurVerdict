// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {Script, console2} from "forge-std/Script.sol";
import {MurmurEscrow} from "../src/MurmurEscrow.sol";

/// @notice Deploys MurmurEscrow with USDC and protocol fee sink from env.
///         Deployer becomes `owner`.
contract DeployMurmurEscrow is Script {
    function run() external returns (MurmurEscrow escrow) {
        uint256 deployerKey = vm.envUint("DEPLOY_PRIVATE_KEY");
        address usdc = vm.envAddress("USDC_ADDRESS");
        address feeSink = vm.envAddress("PROTOCOL_FEE_SINK");
        require(usdc != address(0), "USDC_ADDRESS must not be zero");
        require(feeSink != address(0), "PROTOCOL_FEE_SINK must not be zero");

        vm.startBroadcast(deployerKey);
        escrow = new MurmurEscrow(usdc, feeSink);
        vm.stopBroadcast();

        console2.log("MurmurEscrow deployed at:", address(escrow));
        console2.log("USDC:", address(escrow.USDC()));
        console2.log("Owner:", escrow.owner());
        console2.log("Fee sink:", escrow.protocolFeeSink());
    }
}
