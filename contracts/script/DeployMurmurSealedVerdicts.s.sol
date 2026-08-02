// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {Script, console2} from "forge-std/Script.sol";
import {MurmurSealedVerdicts} from "../src/MurmurSealedVerdicts.sol";

/// @notice Deploys MurmurSealedVerdicts and authorizes the relayer AND the
///         Flow 2 decrypt-grant signer in the same broadcast. Reads
///         `DEPLOY_PRIVATE_KEY`, `RELAYER_ADDRESS`, and `GRANTOR_ADDRESS` from
///         the environment. The deployer becomes `owner`. The grantor is a
///         DEDICATED key (see FHENIX_GRANT_PRIVATE_KEY) held only for brokering
///         paid private decrypt access — never the relayer or reveal key.
contract DeployMurmurSealedVerdicts is Script {
    function run() external returns (MurmurSealedVerdicts verdicts) {
        uint256 deployerKey = vm.envUint("DEPLOY_PRIVATE_KEY");
        address relayer = vm.envAddress("RELAYER_ADDRESS");
        address grantor = vm.envAddress("GRANTOR_ADDRESS");
        require(relayer != address(0), "RELAYER_ADDRESS must not be zero");
        require(grantor != address(0), "GRANTOR_ADDRESS must not be zero");
        require(grantor != relayer, "GRANTOR_ADDRESS must differ from RELAYER_ADDRESS");
        // Key isolation mirrors the runtime guard (fhenix-grant-env): the grantor
        // must not be the reveal EOA either. REVEAL_ADDRESS is optional at deploy
        // time; when provided, enforce that both on-chain roles stay distinct.
        address reveal = vm.envOr("REVEAL_ADDRESS", address(0));
        if (reveal != address(0)) {
            require(grantor != reveal, "GRANTOR_ADDRESS must differ from REVEAL_ADDRESS");
            require(relayer != reveal, "RELAYER_ADDRESS must differ from REVEAL_ADDRESS");
        }

        vm.startBroadcast(deployerKey);
        verdicts = new MurmurSealedVerdicts();
        verdicts.setRelayer(relayer, true);
        verdicts.setGrantor(grantor, true);
        vm.stopBroadcast();

        console2.log("MurmurSealedVerdicts deployed at:", address(verdicts));
        console2.log("Owner:", verdicts.owner());
        console2.log("Relayer authorized:", relayer);
        console2.log("Grantor authorized:", grantor);
    }
}
