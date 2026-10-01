import { Encryptable } from "@cofhe/sdk";
import { arbSepolia as cofheArbitrumSepolia } from "@cofhe/sdk/chains";
import { createCofheClient, createCofheConfig } from "@cofhe/sdk/node";
import type {
  PublicClient,
  WalletClient,
} from "viem";

import {
  COFHE_EUINT8_UTYPE,
  COFHE_EUINT16_UTYPE,
  type CofheInput,
} from "./fhenix-gateway-schemas.js";
import {
  normalizeCofheBytesHex,
  normalizeCofheCtHashToHex32,
} from "./fhenix-gateway-cofhe-normalize.js";

/**
 * CoFHE 0.7 signs the batch once: `execute()` returns `[...ctHashes, batchSignature]` and no
 * longer echoes securityZone / utype, so they are pinned here.
 * Both inputs carry the SAME signature over keccak256(h_binary || h_confidence);
 * splitting or reordering invalidates it.
 * Bound into it: `setAccount` = the relayer EOA that sends; `setConsumingContract` =
 * MurmurSealedVerdicts (not the relayer or TaskManager).
 */
const COFHE_SECURITY_ZONE = 0;

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
      supportedChains: [cofheArbitrumSepolia],
    }),
  );

  constructor(
    private readonly publicClient: PublicClient,
    private readonly walletClient: WalletClient,
    /** MurmurSealedVerdicts — the contract that consumes these hashes. */
    private readonly consumingContract: string,
    /** The relayer EOA that broadcasts the sealed submission. */
    private readonly senderAddress: string,
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

    // Input order is load-bearing: the batch signature covers the hashes in
    // this exact sequence.
    const encrypted = await this.client
      .encryptInputs([
        Encryptable.uint8(BigInt(input.binary_index)),
        Encryptable.uint16(BigInt(input.confidence_bps)),
      ])
      .setAccount(this.senderAddress)
      .setSecurityZone(COFHE_SECURITY_ZONE)
      .setConsumingContract(this.consumingContract)
      .execute();

    const [binaryHash, confidenceHash, batchSignature] = encrypted;
    const signature = normalizeCofheBytesHex(batchSignature, "sealed_batch");

    return {
      binary_index_input: {
        ct_hash: normalizeCofheCtHashToHex32(binaryHash, "binary_index_input"),
        security_zone: COFHE_SECURITY_ZONE,
        utype: COFHE_EUINT8_UTYPE,
        signature,
      },
      confidence_input: {
        ct_hash: normalizeCofheCtHashToHex32(confidenceHash, "confidence_input"),
        security_zone: COFHE_SECURITY_ZONE,
        utype: COFHE_EUINT16_UTYPE,
        signature,
      },
    };
  }
}
