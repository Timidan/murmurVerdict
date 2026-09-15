import type { ContractSealedInputPair } from "./fhenix-gateway-contract.js";
import {
  CofheInputSchema,
  type CofheInput,
} from "./fhenix-gateway-schemas.js";
import { contractSealedPair } from "./fhenix-gateway-runtime.js";

export function gatewayCofheInputJson(input: CofheInput): string {
  return JSON.stringify(input);
}

/**
 * The two inputs are ONE CoFHE 0.7 batch: one signature over both handles, in this order.
 * Resolved together so a mismatched pair is caught before the relayer spends gas.
 */
export function sealedCallCofheContractInputs(attempt: {
  binary_index_input_json: string;
  confidence_input_json: string;
}): ContractSealedInputPair {
  return contractSealedPair(
    storedGatewayCofheInput(
      attempt.binary_index_input_json,
      "gateway_attempt.binary_index_input_json",
    ),
    storedGatewayCofheInput(
      attempt.confidence_input_json,
      "gateway_attempt.confidence_input_json",
    ),
    "gateway_attempt",
  );
}

export function feedPacketCofheContractInputs(attempt: {
  action_input_json: string;
  signal_input_json: string;
}): ContractSealedInputPair {
  return contractSealedPair(
    storedGatewayCofheInput(
      attempt.action_input_json,
      "gateway_feed_packet_attempt.action_input_json",
    ),
    storedGatewayCofheInput(
      attempt.signal_input_json,
      "gateway_feed_packet_attempt.signal_input_json",
    ),
    "gateway_feed_packet_attempt",
  );
}

function storedGatewayCofheInput(raw: string, field: string): CofheInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (err) {
    throw new Error(`${field} is malformed JSON: ${errorMessage(err)}`);
  }
  try {
    return CofheInputSchema.parse(parsed);
  } catch (err) {
    throw new Error(`${field} is not a valid CoFHE input: ${errorMessage(err)}`);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
