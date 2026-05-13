//! Wire protocol shared with `src/verdict/fhe/sidecar-client.ts`. The TS
//! side already speaks the length-prefixed JSON framing; this module
//! defines the serde shapes the Rust binary deserializes / emits.
//!
//! Discriminators: `op` on requests, `kind` on responses. Both lowercase
//! snake-case to match the TS payloads byte-for-byte. Adding a new op
//! requires touching both this enum AND the TS `SidecarRequest` union.

use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Request {
    GetActiveKeyset,
    GetCircuit {
        name: String,
        vector_max_len: u32,
    },
    /// Server-side encryption — used by the operator-run benchmark
    /// baselines that build their predicted vector inside the daemon
    /// process. Agents encrypt client-side and never reach this op.
    EncryptPredicted {
        keyset_id: String,
        circuit_id: String,
        /// Decimal-string numerators (bigint-safe).
        numerators: Vec<String>,
        /// Decimal-string denominator.
        denominator: String,
    },
    ScoreEncrypted {
        call_id: String,
        keyset_id: String,
        circuit_id: String,
        ciphertext_format: String,
        encrypted_predicted_outcome: Vec<u8>,
        resolved_outcome_numerators: Vec<String>,
        resolved_outcome_denominator: String,
    },
    DecryptScore {
        encrypted_score: Vec<u8>,
        keyset_id: String,
    },
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Response {
    KeysetInfo {
        keyset_id: String,
        public_key_blob: Vec<u8>,
        public_key_hash: String,
        provider: String,
    },
    CircuitInfo {
        circuit_id: String,
        name: String,
        vector_max_len: u32,
        handle: String,
    },
    PredictedCiphertext {
        ciphertext: Vec<u8>,
        ciphertext_hash: String,
        nonce: String,
    },
    ScoreCiphertext {
        encrypted_score: Vec<u8>,
        transcript_hash: String,
        score_ciphertext_hash: String,
    },
    Score {
        value: f64,
    },
    Error {
        code: String,
        message: String,
    },
}

impl Response {
    pub fn err(code: &str, message: impl Into<String>) -> Self {
        Response::Error {
            code: code.to_string(),
            message: message.into(),
        }
    }
}
