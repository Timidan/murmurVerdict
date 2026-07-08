import type { ContractCofheInput } from "./fhenix-gateway-contract.js";
import {
  CofheInputSchema,
  type CofheInput,
} from "./fhenix-gateway-schemas.js";
import { contractInput } from "./fhenix-gateway-runtime.js";

export function gatewayCofheInputJson(input: CofheInput): string {
  return JSON.stringify(input);
}

export function sealedCallCofheContractInputs(attempt: {
  binary_index_input_json: string;
  confidence_input_json: string;
}): {
  binaryIndex: ContractCofheInput;
  confidence: ContractCofheInput;
} {
  return {
    binaryIndex: storedGatewayCofheContractInput(
      attempt.binary_index_input_json,
      "gateway_attempt.binary_index_input_json",
    ),
    confidence: storedGatewayCofheContractInput(
      attempt.confidence_input_json,
      "gateway_attempt.confidence_input_json",
    ),
  };
}

export function feedPacketCofheContractInputs(attempt: {
  action_input_json: string;
  signal_input_json: string;
}): {
  action: ContractCofheInput;
  signal: ContractCofheInput;
} {
  return {
    action: storedGatewayCofheContractInput(
      attempt.action_input_json,
      "gateway_feed_packet_attempt.action_input_json",
    ),
    signal: storedGatewayCofheContractInput(
      attempt.signal_input_json,
      "gateway_feed_packet_attempt.signal_input_json",
    ),
  };
}

function storedGatewayCofheContractInput(
  raw: string,
  field: string,
): ContractCofheInput {
  return contractInput(storedGatewayCofheInput(raw, field));
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
