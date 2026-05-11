/**
 * Z2 — Unix-socket IPC client for the FHE sidecar.
 *
 * The Rust sidecar speaks length-prefixed JSON over a Unix-domain
 * socket (see docker/fhe-sidecar/src/protocol.rs). This module is the
 * Node side of that protocol: it knows how to frame a request, write
 * it to a socket, read a single response back, and time the whole
 * exchange against a hard budget.
 *
 * Wire shape, restated for the Node side:
 *
 *   ┌────────────┬──────────────────────────────┐
 *   │ u32 BE len │ <UTF-8 JSON body of len bytes>│
 *   └────────────┴──────────────────────────────┘
 *
 * The Rust enum uses `serde(tag = "op")` for requests and
 * `serde(tag = "kind")` for responses, both `rename_all = "snake_case"`.
 * Mirror those discriminators exactly here — a typo silently
 * deserializes on the Rust side as "unknown variant" and surfaces as
 * a connection-fatal frame error.
 *
 * Ciphertexts ride inside `Vec<u8>` fields, which serde_json emits as
 * JSON arrays of integers. We mirror that on the way in (encode
 * Uint8Array as number[]) and the way out (decode number[] back to
 * Uint8Array). Base64 is not used on the wire — keeping the encoding
 * consistent with the Rust crate's serde defaults.
 *
 * Lifecycle: one socket per request. Connection pooling is not worth
 * it at the resolver's throughput (a tick handles tens of calls, not
 * thousands), and one-shot connections sidestep the "did the previous
 * partial frame corrupt the stream" problem we'd otherwise have to
 * solve on every retry.
 */
import { Socket } from "node:net";
import { FheUnavailableError } from "./provider.js";

/** Sidecar request shapes (mirror docker/fhe-sidecar/src/protocol.rs Request). */
export type SidecarRequest =
  | { op: "get_active_keyset" }
  | { op: "get_circuit"; name: string; vector_max_len: number }
  | {
      op: "score_encrypted";
      circuit_id: string;
      encrypted_predicted_outcome: number[];
      resolved_outcome_numerators: string[];
      resolved_outcome_denominator: string;
    }
  | {
      op: "decrypt_score";
      encrypted_score: number[];
      keyset_id: string;
    };

/** Sidecar response shapes (mirror Response in protocol.rs). */
export type SidecarResponse =
  | {
      kind: "keyset_info";
      keyset_id: string;
      public_key_blob: number[];
      public_key_hash: string;
      provider: string;
    }
  | {
      kind: "circuit_info";
      circuit_id: string;
      name: string;
      vector_max_len: number;
      handle: string;
    }
  | {
      kind: "score_ciphertext";
      encrypted_score: number[];
      transcript_hash: string;
    }
  | { kind: "score"; value: number }
  | { kind: "error"; code: string; message: string };

export interface SidecarClientOptions {
  readonly socketPath: string;
  /** Hard cap on the full request/response round-trip. Default 30s. */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Sends one request, awaits one response, closes the socket. All
 * failure modes (connect refused, partial read, timeout, malformed
 * frame) bubble as FheUnavailableError so the resolver's retry path
 * sees one error class.
 */
export async function sendRequest(
  req: SidecarRequest,
  opts: SidecarClientOptions,
): Promise<SidecarResponse> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const body = Buffer.from(JSON.stringify(req), "utf8");
  if (body.length > MAX_FRAME_BYTES) {
    throw new FheUnavailableError(
      req.op,
      `request body ${body.length} bytes exceeds protocol cap ${MAX_FRAME_BYTES}`,
    );
  }
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(body.length, 0);

  return new Promise<SidecarResponse>((resolve, reject) => {
    const socket = new Socket();
    let settled = false;
    const finish = (
      err: FheUnavailableError | null,
      resp: SidecarResponse | null,
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else if (resp) resolve(resp);
    };

    const timer = setTimeout(() => {
      finish(
        new FheUnavailableError(
          req.op,
          `sidecar timeout after ${timeoutMs}ms`,
        ),
        null,
      );
    }, timeoutMs);

    // Read state. We need to accumulate until we have 4 length bytes,
    // then the full body. Once we see the body we can parse and
    // resolve.
    const chunks: Buffer[] = [];
    let expectedBodyLen: number | null = null;

    socket.on("error", (err: Error) => {
      finish(new FheUnavailableError(req.op, err.message), null);
    });

    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      const total = Buffer.concat(chunks);
      if (expectedBodyLen === null) {
        if (total.length < 4) return;
        expectedBodyLen = total.readUInt32BE(0);
        if (expectedBodyLen === 0 || expectedBodyLen > MAX_FRAME_BYTES) {
          finish(
            new FheUnavailableError(
              req.op,
              `invalid response frame length ${expectedBodyLen}`,
            ),
            null,
          );
          return;
        }
      }
      if (total.length >= 4 + expectedBodyLen) {
        const bodyBytes = total.subarray(4, 4 + expectedBodyLen);
        let parsed: SidecarResponse;
        try {
          parsed = JSON.parse(bodyBytes.toString("utf8")) as SidecarResponse;
        } catch (err) {
          finish(
            new FheUnavailableError(
              req.op,
              `malformed JSON response: ${err instanceof Error ? err.message : String(err)}`,
            ),
            null,
          );
          return;
        }
        finish(null, parsed);
      }
    });

    socket.on("close", () => {
      if (!settled) {
        finish(
          new FheUnavailableError(
            req.op,
            "sidecar closed connection before sending a complete response",
          ),
          null,
        );
      }
    });

    socket.connect(opts.socketPath, () => {
      socket.write(Buffer.concat([lenBuf, body]), (err) => {
        if (err) {
          finish(
            new FheUnavailableError(req.op, `socket write failed: ${err.message}`),
            null,
          );
        }
      });
    });
  });
}

/** Mirrors MAX_FRAME_BYTES in docker/fhe-sidecar/src/protocol.rs. */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;

/** Convenience: convert Uint8Array to the wire encoding (number[]). */
export function bytesToWire(bytes: Uint8Array): number[] {
  const out: number[] = new Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = bytes[i] ?? 0;
  return out;
}

/** Convenience: convert wire encoding (number[]) back to Uint8Array. */
export function wireToBytes(wire: number[]): Uint8Array {
  return Uint8Array.from(wire);
}
