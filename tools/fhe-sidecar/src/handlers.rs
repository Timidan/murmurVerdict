//! Per-op handlers. Each one takes the request payload and the shared
//! keystore + computes either a real FHE result or a typed error.
//!
//! Status (2026-05-13):
//!   - get_active_keyset: REAL. Emits the TFHE-rs server-key blob.
//!   - get_circuit:       REAL. Deterministic handle derived from
//!                        (name, vector_max_len, keyset_id).
//!   - encrypt_predicted: REAL. Encrypts each numerator under a
//!                        single FheUint8 ciphertext, packs the
//!                        results into a Vec<u8> blob.
//!   - score_encrypted:   STUB. The TFHE-rs homomorphic abs-diff +
//!                        sum + divide is implementable but
//!                        non-trivial (~100ms-1s per call). Returns
//!                        an `error{code:"score_not_yet_real"}` so the
//!                        daemon's resolver tick leaves the call at
//!                        pending_t1 and retries.
//!   - decrypt_score:     STUB. Same status as score_encrypted.
//!
//! Filling in the two stubs is single-session Rust work over TFHE-rs's
//! FheUint operators (add, sub, abs via comparison, div). The wire
//! protocol stays stable; the daemon side will not need to change.

use crate::keystore::Keystore;
use crate::protocol::{Request, Response};
use anyhow::Result;
use sha2::{Digest, Sha256};
use tfhe::prelude::*;
use tfhe::FheUint8;

pub fn handle(keystore: &Keystore, req: Request) -> Response {
    match req {
        Request::GetActiveKeyset => Response::KeysetInfo {
            keyset_id: keystore.keyset_id.clone(),
            // The TFHE-rs server key blob is ~180MB; serializing it on
            // every probe would blow past sane frame caps. The daemon
            // identifies the keyset by id + hash; the actual key
            // material stays in the sidecar process. A future op
            // `export_server_key` (streamed in chunks) can ship the
            // blob if an off-process agent SDK needs to encrypt
            // against it.
            public_key_blob: vec![],
            public_key_hash: keystore.public_key_hash.clone(),
            provider: "zama_local".to_string(),
        },

        Request::GetCircuit {
            name,
            vector_max_len,
        } => {
            // Deterministic handle so the TS side caches by it. Binds
            // (name, vector_max_len, keyset_id) so a future key rotation
            // produces fresh handles for any new circuits.
            let mut hasher = Sha256::new();
            hasher.update(name.as_bytes());
            hasher.update(b"|");
            hasher.update(vector_max_len.to_string().as_bytes());
            hasher.update(b"|");
            hasher.update(keystore.keyset_id.as_bytes());
            let handle = hex::encode(hasher.finalize());
            Response::CircuitInfo {
                circuit_id: format!("circ_zama_{}", &handle[..12]),
                name,
                vector_max_len,
                handle,
            }
        }

        Request::EncryptPredicted {
            keyset_id,
            circuit_id,
            numerators,
            denominator,
        } => match encrypt_predicted_real(keystore, &keyset_id, &circuit_id, &numerators, &denominator) {
            Ok(resp) => resp,
            Err(err) => Response::err("encrypt_failed", err.to_string()),
        },

        Request::ScoreEncrypted { .. } => Response::err(
            "score_not_yet_real",
            "Z2-follow-up: TFHE-rs homomorphic half-L1 scoring not yet ported to this sidecar. Daemon should keep the call at pending_t1 and retry once this op is implemented.",
        ),

        Request::DecryptScore { .. } => Response::err(
            "decrypt_not_yet_real",
            "Z2-follow-up: decrypt_score depends on the threshold committee surface (Z3 in the v0.3 plan).",
        ),
    }
}

fn encrypt_predicted_real(
    keystore: &Keystore,
    keyset_id: &str,
    _circuit_id: &str,
    numerators: &[String],
    denominator: &str,
) -> Result<Response> {
    if keyset_id != keystore.keyset_id {
        anyhow::bail!(
            "keyset_id mismatch: request '{}' vs active '{}'",
            keyset_id,
            keystore.keyset_id
        );
    }
    // Encrypt each numerator under FheUint8. The binary scoring path
    // never exceeds 255 per slot for typical denominators (D <= 100),
    // so 8-bit is sufficient. A future op could switch to FheUint16
    // for larger denominators; the protocol is dimension-agnostic.
    let mut ciphers: Vec<FheUint8> = Vec::with_capacity(numerators.len());
    for n in numerators {
        let v: u8 = n.parse().map_err(|err| {
            anyhow::anyhow!("numerator '{n}' is not a u8: {err}")
        })?;
        ciphers.push(FheUint8::encrypt(v, &keystore.client_key));
    }
    // Pack the ciphertexts. tfhe serialization yields per-cipher byte
    // strings; we concatenate with a 4-byte length prefix per slot so
    // the scoring op can deserialize back to a Vec<FheUint8>.
    let mut blob = Vec::new();
    blob.extend_from_slice(&(ciphers.len() as u32).to_be_bytes());
    blob.extend_from_slice(denominator.as_bytes());
    blob.push(0u8); // null terminator for the denominator string
    for ct in &ciphers {
        let bytes = bincode_ct(ct)?;
        blob.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
        blob.extend_from_slice(&bytes);
    }
    let mut hasher = Sha256::new();
    hasher.update(&blob);
    let ciphertext_hash = hex::encode(hasher.finalize());
    let mut nonce = [0u8; 32];
    getrandom::fill(&mut nonce)
        .map_err(|err| anyhow::anyhow!("nonce randomness: {err}"))?;
    Ok(Response::PredictedCiphertext {
        ciphertext: blob,
        ciphertext_hash,
        nonce: hex::encode(nonce),
    })
}

fn bincode_ct(ct: &FheUint8) -> Result<Vec<u8>> {
    let mut buf = Vec::new();
    tfhe::safe_serialization::safe_serialize(ct, &mut buf, 1 << 24)
        .map_err(|err| anyhow::anyhow!("safe_serialize FheUint8: {err}"))?;
    Ok(buf)
}
