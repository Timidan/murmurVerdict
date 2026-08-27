import { Encryptable } from "@cofhe/sdk";
import { baseSepolia as cofheBaseSepolia } from "@cofhe/sdk/chains";
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
 * CoFHE 0.7 changed the shape of a sealed batch.
 *
 * 0.5 returned one object per input, each carrying its own `signature`, and the
 * verifier signed each input independently (`POST /verify`, on-chain
 * `verifyInput`). 0.7 signs the whole batch ONCE (`POST /verifyBatch`, on-chain
 * `batchVerifyInputs`): `execute()` returns `[...ctHashes, batchSignature]` —
 * one element MORE than the input count — and the hashes come back as bare hex
 * strings, so `securityZone` / `utype` are no longer echoed per input.
 *
 * Two consequences the wire format has to absorb:
 *
 *  - `security_zone` / `utype` are now pinned here rather than read back. We
 *    send exactly the values we asked the verifier to sign, so the Gateway's
 *    per-field utype assertions still mean what they used to.
 *  - Both inputs carry the SAME `signature` — it authenticates
 *    keccak256(h_binary || h_confidence), not either hash alone. Splitting the
 *    batch across two transactions, or reordering the inputs, invalidates it.
 *
 * The two bindings the verifier folds into that signature:
 *
 *  - `setAccount` → the EOA that SENDS the submission (murmur's relayer). A
 *    proof signed for one relayer is not usable by another.
 *  - `setConsumingContract` → MurmurSealedVerdicts, the contract that calls
 *    `FHE.asEuint*s` with these hashes. NOT the relayer and NOT the
 *    TaskManager; a batch signed for one deployment cannot be replayed into
 *    another.
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
      supportedChains: [cofheBaseSepolia],
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
