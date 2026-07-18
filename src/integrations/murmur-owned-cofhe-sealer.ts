import { Encryptable } from "@cofhe/sdk";
import { baseSepolia as cofheBaseSepolia } from "@cofhe/sdk/chains";
import { createCofheClient, createCofheConfig } from "@cofhe/sdk/node";
import type {
  PublicClient,
  WalletClient,
} from "viem";

import type { CofheInput } from "./fhenix-gateway-schemas.js";
import {
  normalizeCofheBytesHex,
  normalizeCofheCtHashToHex32,
} from "./fhenix-gateway-cofhe-normalize.js";

export interface MurmurOwnedCofheSealer {
  sealVerdict(input: {
    binary_index: number;
    confidence_bps: number;
  }): Promise<{
    binary_index_input: CofheInput;
    confidence_input: CofheInput;
  }>;
}

export class SdkMurmurOwnedCofheSealer implements MurmurOwnedCofheSealer {
  private connected = false;
  private readonly client = createCofheClient(
    createCofheConfig({
      environment: "node",
      supportedChains: [cofheBaseSepolia],
    }),
  );

  constructor(
    private readonly publicClient: PublicClient,
    private readonly walletClient: WalletClient,
  ) {}

  async sealVerdict(input: {
    binary_index: number;
    confidence_bps: number;
  }): Promise<{
    binary_index_input: CofheInput;
    confidence_input: CofheInput;
  }> {
    if (!this.connected) {
      await this.client.connect(
        this.publicClient as never,
        this.walletClient as never,
      );
      this.connected = true;
    }

    const encryptedInputs = await this.client
      .encryptInputs([
        Encryptable.uint8(BigInt(input.binary_index)),
        Encryptable.uint16(BigInt(input.confidence_bps)),
      ])
      .execute();
    const binary = encryptedInputs[0];
    const confidence = encryptedInputs[1];

    return {
      binary_index_input: {
        ct_hash: normalizeCofheCtHashToHex32(
          binary.ctHash,
          "binary_index_input",
        ),
        security_zone: binary.securityZone,
        utype: binary.utype,
        signature: normalizeCofheBytesHex(
          binary.signature,
          "binary_index_input",
        ),
      },
      confidence_input: {
        ct_hash: normalizeCofheCtHashToHex32(
          confidence.ctHash,
          "confidence_input",
        ),
        security_zone: confidence.securityZone,
        utype: confidence.utype,
        signature: normalizeCofheBytesHex(
          confidence.signature,
          "confidence_input",
        ),
      },
    };
  }
}
