import { strict as assert } from "node:assert";
import {
  ContractFunctionExecutionError,
  decodeAbiParameters,
  parseAbiParameters,
  type BaseError,
} from "viem";

import { isLegacyMarketsDecodeError } from "./fhenix-market-registration.js";

process.stdout.write("murmur fhenix legacy contract smoke\n");

// A pre-schedule deployment's `markets()` returns 3 words; the six-instant ABI
// expects 7. viem does NOT surface the decoder error directly — `readContract`
// wraps it in a ContractFunctionExecutionError whose own message is human text
// ("Position `127` is out of bounds"), while the matching decoder error name
// lives on `cause`.
//
// This is a real regression test: an earlier version of the detector matched
// only the OUTER name/message and therefore never fired, silently degrading
// legacy detection back into a retryable chain-read error that burned one tick
// per candidate forever against a contract that can never be driven.
let inner: unknown;
try {
  decodeAbiParameters(
    parseAbiParameters("uint64,uint64,uint64,uint64,uint64,uint64,bool"),
    ("0x" + "00".repeat(96)) as `0x${string}`,
  );
} catch (err) {
  inner = err;
}
assert.ok(inner instanceof Error, "short return data must throw a decode error");

const wrapped = new ContractFunctionExecutionError(inner as BaseError, {
  abi: [],
  functionName: "markets",
  args: [],
});

// The outer error deliberately does NOT name the decoder failure.
assert.equal(wrapped.name, "ContractFunctionExecutionError");
assert.ok(
  !/AbiDecodingDataSizeTooSmall|PositionOutOfBounds/i.test(wrapped.name),
  "outer error name must not be relied on — this is why the naive check failed",
);

assert.ok(
  isLegacyMarketsDecodeError(wrapped),
  "wrapped viem decode error must be recognised through the cause chain",
);

// Genuine transient failures must NOT be misreported as a legacy contract, or
// a flaky RPC would permanently halt discovery.
assert.equal(
  isLegacyMarketsDecodeError(new Error("fetch failed: ECONNRESET")),
  false,
  "an RPC transport error is not a legacy contract",
);
assert.equal(isLegacyMarketsDecodeError(null), false);
assert.equal(isLegacyMarketsDecodeError("boom"), false);

// A self-referential cause chain must terminate rather than hang.
const cyclic = new Error("a") as Error & { cause?: unknown };
cyclic.cause = cyclic;
assert.equal(isLegacyMarketsDecodeError(cyclic), false, "cyclic cause chain terminates");

process.stdout.write("OK fhenix legacy contract smoke\n");
