// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {Script, console2} from "forge-std/Script.sol";
import {MurmurSealedVerdicts} from "../src/MurmurSealedVerdicts.sol";

/// @notice Deploys MurmurSealedVerdicts and authorizes the relayer in the
///         same broadcast. Reads `DEPLOY_PRIVATE_KEY` and `RELAYER_ADDRESS`
///         from the environment. The deployer becomes `owner`.
contract DeployMurmurSealedVerdicts is Script {
    function run() external returns (MurmurSealedVerdicts verdicts) {
        uint256 deployerKey = vm.envUint("DEPLOY_PRIVATE_KEY");
        address relayer = vm.envAddress("RELAYER_ADDRESS");
        require(relayer != address(0), "RELAYER_ADDRESS must not be zero");

        vm.startBroadcast(deployerKey);
        verdicts = new MurmurSealedVerdicts();
        verdicts.setRelayer(relayer, true);
        vm.stopBroadcast();

        console2.log("MurmurSealedVerdicts deployed at:", address(verdicts));
        console2.log("Owner:", verdicts.owner());
        console2.log("Relayer authorized:", relayer);
    }
}
