//! Z2 request handlers.
//!
//! `GetActiveKeyset` and `GetCircuit` read the keystore the daemon has
//! already seeded and reflect it back. `ScoreEncrypted` now performs
//! the actual encrypted-score computation; `DecryptScore` stays stubbed
//! with `requires_threshold_z3` because the threshold quorum lands in
//! Z3.
//!
//! Z2 scoring shape
//! ----------------
//! Two ciphertext formats arrive on the wire (mirroring
//! `src/verdict/fhe/submission.ts::ciphertextFormatForProvider`):
//!
//!   * `mock_json` — a UTF-8 JSON document `{v, kind, numerators[],
//!     denominator}`. The daemon's MockFheProvider emits these in
//!     clear so CI/dev smokes work without TFHE-rs. The sidecar reads
//!     them too; the encrypted_score is still emitted as a
//!     mock-provider score blob (`{v, kind:"score", score_x1e9}`).
//!   * `zama_tfhe_v1` — real tfhe-rs `FheUint*` ciphertexts. The Z2
//!     "real" path stays guarded: today we don't yet have compiled
//!     circuits inside the sidecar, so we return `tfhe_not_implemented`
//!     and let the daemon retry. The protocol shape, transcript-hash
//!     contract, and error code are stable so Z2-proper-tfhe lands as
//!     a single behind-the-flag change to this handler.
//!
//! Transcript hash binds: circuit_id, sha256(ciphertext bytes), the
//! resolved-outcome numerators (decimal-stringified, comma-joined), and
//! the denominator. The mock and tfhe paths use the SAME binding so a
//! dispute replay produces the same hash regardless of which backend
//! computed it.
//!
//! No state lives in this module on purpose. The handler functions
//! take a `&Keystore` reference and a `&Request` and return a
//! `Response`; the connection loop in `main.rs` owns the lifecycle.

use crate::keystore::Keystore;
use crate::protocol::{Request, Response};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Provider name the sidecar identifies as. Matches
/// `fhe_keysets.provider` and `FheProviderName` in
/// `src/verdict/fhe/provider.ts`.
const PROVIDER: &str = "zama_local";

/// Dispatch one decoded request to its handler. Returns a single
/// `Response` — there's no streaming today; if Z3's threshold-decrypt
/// flow needs progress events we'll add a `Notify` variant rather
/// than retrofitting the request/response shape.
pub fn dispatch(keystore: &Keystore, req: &Request) -> Response {
    match req {
        Request::GetActiveKeyset => handle_get_active_keyset(keystore),
        Request::GetCircuit {
            name,
            vector_max_len,
        } => handle_get_circuit(keystore, name, *vector_max_len),
        Request::ScoreEncrypted {
            circuit_id,
            encrypted_predicted_outcome,
            resolved_outcome_numerators,
            resolved_outcome_denominator,
        } => handle_score_encrypted(
            keystore,
            circuit_id,
            encrypted_predicted_outcome,
            resolved_outcome_numerators,
            resolved_outcome_denominator,
        ),
        Request::DecryptScore { .. } => Response::Error {
            code: "requires_threshold_z3".to_string(),
            message:
                "decryptScore decrypts the bounded score; Z3 wires the threshold quorum"
                    .to_string(),
        },
    }
}

fn handle_get_active_keyset(keystore: &Keystore) -> Response {
    match keystore.get_active_keyset(PROVIDER) {
        Ok(Some(row)) => Response::KeysetInfo {
            keyset_id: row.keyset_id,
            public_key_blob: row.public_key_blob,
            public_key_hash: row.public_key_hash,
            provider: row.provider,
        },
        // No active keyset yet is a normal state during Z0/Z1 boot —
        // the daemon's zama-local-provider seeds it as `pending` and
        // never flips it to `active` on its own. Z2-proper performs
        // the activation after a real keygen; until then this is the
        // expected response and the daemon downgrades to mock /
        // surfaces an FHE-disabled banner.
        Ok(None) => Response::err(
            "no_active_keyset",
            format!(
                "no active keyset for provider='{PROVIDER}'; daemon seeds 'pending' \
                 in Z0 and Z2-proper activates after keygen"
            ),
        ),
        Err(e) => Response::err("keystore_error", format!("get_active_keyset: {e:#}")),
    }
}

fn handle_get_circuit(keystore: &Keystore, name: &str, vector_max_len: u32) -> Response {
    match keystore.get_circuit(PROVIDER, name, vector_max_len as i64) {
        Ok(Some(row)) => Response::CircuitInfo {
            circuit_id: row.circuit_id,
            name: row.name,
            vector_max_len: row.vector_max_len as u32,
            handle: row.handle,
        },
        Ok(None) => Response::err(
            "no_circuit",
            format!(
                "no circuit registered for provider='{PROVIDER}' name='{name}' \
                 vector_max_len={vector_max_len}; Z2-proper compiles and seeds these"
            ),
        ),
        Err(e) => Response::err("keystore_error", format!("get_circuit: {e:#}")),
    }
}

// ─── ScoreEncrypted ─────────────────────────────────────────────────────────
//
// The mock-provider ciphertext shape (mirror of the daemon's
// `MockFheProvider` PredictedBlob / ScoreBlob):
#[derive(Debug, Deserialize)]
struct MockPredictedBlob {
    v: u8,
    kind: String,
    numerators: Vec<String>,
    denominator: String,
}

#[derive(Debug, Serialize)]
struct MockScoreBlob {
    v: u8,
    kind: &'static str,
    score_x1e9: i64,
}

fn handle_score_encrypted(
    _keystore: &Keystore,
    circuit_id: &str,
    encrypted_predicted_outcome: &[u8],
    resolved_outcome_numerators: &[String],
    resolved_outcome_denominator: &str,
) -> Response {
    // Validate the resolved-outcome denominator first — both backends
    // need a non-zero denominator before division.
    let denominator = match parse_bigint(resolved_outcome_denominator) {
        Some(d) if d != 0 => d,
        Some(_) => {
            return Response::err(
                "invalid_resolved_denominator",
                "resolved_outcome_denominator must be non-zero",
            );
        }
        None => {
            return Response::err(
                "invalid_resolved_denominator",
                format!(
                    "resolved_outcome_denominator='{resolved_outcome_denominator}' is not a decimal integer"
                ),
            );
        }
    };
    let mut resolved_num: Vec<i128> = Vec::with_capacity(resolved_outcome_numerators.len());
    for (i, s) in resolved_outcome_numerators.iter().enumerate() {
        match parse_signed_bigint(s) {
            Some(n) => resolved_num.push(n),
            None => {
                return Response::err(
                    "invalid_resolved_numerator",
                    format!(
                        "resolved_outcome_numerators[{i}]='{s}' is not a decimal integer"
                    ),
                );
            }
        }
    }

    // Format inference: mock_json is UTF-8 JSON; the real
    // zama_tfhe_v1 path emits binary tfhe-rs bytes. Try JSON first;
    // fall through to tfhe stub on any decode error.
    let is_mock_json = serde_json::from_slice::<MockPredictedBlob>(encrypted_predicted_outcome)
        .ok()
        .map(|b| b.v == 1 && b.kind == "predicted")
        .unwrap_or(false);

    if is_mock_json {
        score_mock_json(
            circuit_id,
            encrypted_predicted_outcome,
            &resolved_num,
            denominator,
        )
    } else {
        // Real tfhe-rs path. Z2 ships the protocol contract; the
        // compiled-circuit registry + per-circuit eval logic lands as
        // a follow-up behind this same response shape. Return a
        // stable, machine-readable error so the daemon's retry path
        // can switch on it once the real path comes online.
        Response::err(
            "tfhe_not_implemented",
            "zama_tfhe_v1 ciphertext format requires a compiled-circuit registry; \
             the protocol contract is stable, real eval lands as a follow-up to Z2",
        )
    }
}

fn score_mock_json(
    circuit_id: &str,
    encrypted_predicted_outcome: &[u8],
    resolved_num: &[i128],
    resolved_den: i128,
) -> Response {
    // Decode the predicted blob.
    let predicted: MockPredictedBlob =
        match serde_json::from_slice(encrypted_predicted_outcome) {
            Ok(p) => p,
            Err(e) => {
                return Response::err(
                    "malformed_mock_ciphertext",
                    format!("mock_json decode failed: {e}"),
                );
            }
        };
    if predicted.kind != "predicted" {
        return Response::err(
            "wrong_ciphertext_kind",
            format!(
                "mock_json blob kind='{}' but expected 'predicted'",
                predicted.kind
            ),
        );
    }
    let pred_den = match parse_bigint(&predicted.denominator) {
        Some(d) if d != 0 => d,
        _ => {
            return Response::err(
                "invalid_predicted_denominator",
                format!(
                    "predicted denominator='{}' must be a non-zero decimal integer",
                    predicted.denominator
                ),
            );
        }
    };
    let mut pred_num: Vec<i128> = Vec::with_capacity(predicted.numerators.len());
    for (i, s) in predicted.numerators.iter().enumerate() {
        match parse_signed_bigint(s) {
            Some(n) => pred_num.push(n),
            None => {
                return Response::err(
                    "invalid_predicted_numerator",
                    format!(
                        "predicted numerators[{i}]='{s}' is not a decimal integer"
                    ),
                );
            }
        }
    }
    if pred_num.len() != resolved_num.len() {
        return Response::err(
            "vector_length_mismatch",
            format!(
                "predicted len={} but resolved len={}",
                pred_num.len(),
                resolved_num.len()
            ),
        );
    }
    // 1 - halfL1Distance(predicted, resolved), with cross-rescale to
    // a common denominator. Mirrors src/verdict/fhe/mock-provider.ts.
    let mut abs_sum: i128 = 0;
    for i in 0..pred_num.len() {
        let p = pred_num[i].saturating_mul(resolved_den);
        let r = resolved_num[i].saturating_mul(pred_den);
        let d = p - r;
        abs_sum = abs_sum.saturating_add(d.abs());
    }
    let common_denom = (pred_den as f64) * (resolved_den as f64);
    let half_l1 = (abs_sum as f64) / 2.0 / common_denom;
    let mut score = 1.0 - half_l1;
    if score < 0.0 {
        score = 0.0;
    }
    if score > 1.0 {
        score = 1.0;
    }
    let score_x1e9 = (score * 1_000_000_000.0).round() as i64;

    let score_blob = MockScoreBlob {
        v: 1,
        kind: "score",
        score_x1e9,
    };
    let encrypted_score = match serde_json::to_vec(&score_blob) {
        Ok(b) => b,
        Err(e) => {
            return Response::err(
                "encode_failed",
                format!("mock score blob encode failed: {e}"),
            );
        }
    };

    // Transcript hash: sha256( circuit_id || '\n' || sha256(ciphertext) ||
    //                          '\n' || join(',', numerators) || '/' || denominator ).
    // Identical to the daemon-side mock-provider transcript so a dispute
    // replay produces byte-identical bytes regardless of which side
    // recomputed.
    let ciphertext_hash_hex = hex_sha256(encrypted_predicted_outcome);
    let mut hasher = Sha256::new();
    hasher.update(circuit_id.as_bytes());
    hasher.update(b"\n");
    hasher.update(ciphertext_hash_hex.as_bytes());
    hasher.update(b"\n");
    // resolved_num was rebuilt from strings; format them back so the
    // hash matches the daemon's pre-encoded resolved numerators.
    let joined_num: String = resolved_num
        .iter()
        .map(|n| n.to_string())
        .collect::<Vec<_>>()
        .join(",");
    hasher.update(joined_num.as_bytes());
    hasher.update(b"/");
    hasher.update(resolved_den.to_string().as_bytes());
    let transcript_hash = hex_string(&hasher.finalize());

    Response::ScoreCiphertext {
        encrypted_score,
        transcript_hash,
    }
}

fn hex_sha256(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    hex_string(&h.finalize())
}

fn hex_string(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// Strict non-negative decimal-integer parse. None on parse failure.
fn parse_bigint(s: &str) -> Option<i128> {
    if s.is_empty() {
        return None;
    }
    s.parse::<i128>().ok().filter(|n| *n >= 0)
}

/// Signed decimal-integer parse. None on parse failure. Used for
/// resolved/predicted numerators which can in principle be negative
/// (some adapter outcomes use signed buckets).
fn parse_signed_bigint(s: &str) -> Option<i128> {
    if s.is_empty() {
        return None;
    }
    s.parse::<i128>().ok()
}
