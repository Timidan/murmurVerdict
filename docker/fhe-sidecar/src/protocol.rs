//! Wire protocol for the Murmur Verdict FHE sidecar.
//!
//! Transport: SOCK_STREAM on a Unix-domain socket. The daemon (Node)
//! and the sidecar (Rust) are co-tenants — no external network exposure.
//!
//! Framing:  `u32 BE length | body`. `body` is UTF-8 JSON. Length is
//! the byte length of `body` and MUST NOT exceed [`MAX_FRAME_BYTES`].
//! A length of 0 is illegal (use a heartbeat request if we ever need
//! one). The reader closes the connection on framing errors; the daemon
//! reconnects.
//!
//! Encoding choice:
//!   * JSON outer envelope keeps things debuggable (`socat - UNIX-CONNECT:...`).
//!   * Ciphertexts ride inside `Vec<u8>` fields, which serde_json
//!     emits as byte arrays. Z2-proper can swap those specific fields
//!     to base64 strings without changing the envelope shape if the
//!     wire size becomes a problem; the daemon-side codec lives in
//!     `src/verdict/fhe/zama-local-provider.ts`.
//!   * bigints arrive as decimal strings, matching the daemon's
//!     `payout_denominator` column (a `TEXT` in SQLite, BigInt in JS).
//!     Parsing happens here, not on the wire — keeps the JSON shape
//!     language-agnostic.
//!
//! Z2-prep status: every variant exists and round-trips; the handlers
//! that consume `Request::ScoreEncrypted` and `Request::DecryptScore`
//! return [`Response::Error`] with `code = "not_implemented_z2_real"`.

use serde::{Deserialize, Serialize};
use std::io;
use thiserror::Error;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// Hard cap on a single frame body, in bytes. tfhe-rs ciphertexts for
/// a length-32 vector at our parameter set sit around ~2 MiB; we leave
/// 8 MiB of headroom so threshold-decrypt bundles (Z3) don't need a
/// protocol bump. Anything larger is almost certainly a corrupt length
/// prefix and we'd rather drop the connection than allocate.
pub const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;

/// Requests the daemon sends. Tagged externally with `op` so the
/// payload sits at a known JSON path and humans tailing the socket
/// can spot the op-code at a glance.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Request {
    /// 0x01 — return the keyset currently accepting submissions.
    GetActiveKeyset,

    /// 0x02 — fetch the compiled-circuit handle for `(name, vector_max_len)`.
    GetCircuit {
        name: String,
        vector_max_len: u32,
    },

    /// 0x10 — score an encrypted prediction against a public outcome.
    /// `resolved_outcome_numerators` and `resolved_outcome_denominator`
    /// are decimal strings to preserve full precision across the Node
    /// (BigInt) ↔ Rust (u128 / BigUint) boundary.
    /// Codex Z2 review fixes #6 + #7 — request now carries the full
    /// identity of the score computation so the transcript hash can
    /// bind (call_id, keyset_id, circuit_id, score_ciphertext_hash,
    /// resolved_outcome_hash, score_range). Cross-language byte equality
    /// with the TS canonicalTranscriptBytes() is the contract.
    ScoreEncrypted {
        call_id: String,
        keyset_id: String,
        circuit_id: String,
        ciphertext_format: String,
        encrypted_predicted_outcome: Vec<u8>,
        resolved_outcome_numerators: Vec<String>,
        resolved_outcome_denominator: String,
    },

    /// 0x20 — decrypt a bounded score ciphertext. Single-party dev only
    /// until Z3 lands the threshold ceremony.
    DecryptScore {
        encrypted_score: Vec<u8>,
        keyset_id: String,
    },
}

/// Responses the sidecar emits. Mirrors `Request` op-by-op so the
/// daemon can dispatch on the tag alone.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Response {
    /// Reply to [`Request::GetActiveKeyset`].
    KeysetInfo {
        keyset_id: String,
        /// Raw public-key bytes (Zama TFHE-rs serialized PublicKey).
        public_key_blob: Vec<u8>,
        /// `sha256(public_key_blob)` as lowercase hex.
        public_key_hash: String,
        /// Mirrors `fhe_keysets.provider` — `"zama_local"` today.
        provider: String,
    },

    /// Reply to [`Request::GetCircuit`].
    CircuitInfo {
        circuit_id: String,
        name: String,
        vector_max_len: u32,
        /// Opaque provider-specific handle (e.g. compiled circuit file
        /// path or hash). The daemon stores this verbatim.
        handle: String,
    },

    /// Reply to [`Request::ScoreEncrypted`].
    ScoreCiphertext {
        encrypted_score: Vec<u8>,
        /// `sha256` of the canonical transcript bytes per
        /// MURMUR_FHE_SCORE_TRANSCRIPT_V1 (see TS provider.ts).
        /// Binds: { domain, call_id, circuit_id, keyset_id,
        ///   score_ciphertext_hash, resolved_outcome_hash, score_range }.
        /// Daemon mock and sidecar produce identical bytes for the same
        /// input — cross-language equality is the dispute-replay contract.
        transcript_hash: String,
        /// `sha256(encrypted_score)` lowercase hex. Daemon also
        /// computes this independently and asserts they match.
        score_ciphertext_hash: String,
    },

    /// Reply to [`Request::DecryptScore`].
    Score {
        /// Bounded value in [0, 1]. Carried as f64 because the daemon
        /// already stores `verdict_score` as a REAL.
        value: f64,
    },

    /// Catch-all error. `code` is stable and machine-readable; the
    /// daemon may switch on it (e.g. to map
    /// `not_implemented_z2_real` onto an `FheNotImplementedError`).
    Error { code: String, message: String },
}

impl Response {
    /// Convenience builder for keystore / framing errors.
    pub fn err(code: &str, message: impl Into<String>) -> Self {
        Response::Error {
            code: code.to_string(),
            message: message.into(),
        }
    }
}

/// Errors emitted by the framing layer. These are connection-fatal —
/// the loop closes the socket and the daemon reconnects.
#[derive(Debug, Error)]
pub enum FrameError {
    #[error("io: {0}")]
    Io(#[from] io::Error),

    #[error("frame too large: {0} bytes (max {})", MAX_FRAME_BYTES)]
    TooLarge(usize),

    #[error("frame length was zero")]
    Empty,

    #[error("decode: {0}")]
    Decode(#[from] serde_json::Error),
}

/// Reads one length-prefixed JSON frame. Returns `Ok(None)` on clean
/// EOF (peer closed between frames); returns `Err` on partial frame.
pub async fn read_frame<R: AsyncReadExt + Unpin>(
    reader: &mut R,
) -> Result<Option<Request>, FrameError> {
    let mut len_buf = [0u8; 4];
    match reader.read_exact(&mut len_buf).await {
        Ok(_) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(FrameError::Io(e)),
    }

    let len = u32::from_be_bytes(len_buf) as usize;
    if len == 0 {
        return Err(FrameError::Empty);
    }
    if len > MAX_FRAME_BYTES {
        return Err(FrameError::TooLarge(len));
    }

    let mut body = vec![0u8; len];
    reader.read_exact(&mut body).await?;
    let req: Request = serde_json::from_slice(&body)?;
    Ok(Some(req))
}

/// Writes one length-prefixed JSON frame. Buffered into a single
/// vector so the u32-len and body hit the wire in one syscall — the
/// daemon's reader assumes that ordering and Tokio doesn't promise
/// it across two `write_all` calls on the same handle.
pub async fn write_frame<W: AsyncWriteExt + Unpin>(
    writer: &mut W,
    resp: &Response,
) -> Result<(), FrameError> {
    let body = serde_json::to_vec(resp)?;
    if body.len() > MAX_FRAME_BYTES {
        return Err(FrameError::TooLarge(body.len()));
    }
    let mut out = Vec::with_capacity(4 + body.len());
    out.extend_from_slice(&(body.len() as u32).to_be_bytes());
    out.extend_from_slice(&body);
    writer.write_all(&out).await?;
    writer.flush().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    // Z2-prep deliberately ships no unit tests; the harness lands with
    // Z2-proper alongside the real handlers. The protocol module is
    // small enough that the integration smoke (daemon ↔ sidecar) in
    // Z2 covers it without per-function tests here.
}
