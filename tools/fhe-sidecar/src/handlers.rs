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
use anyhow::{anyhow, Result};
use sha2::{Digest, Sha256};
use std::io::Cursor;
use tfhe::prelude::*;
use tfhe::safe_serialization::safe_deserialize;
use tfhe::{set_server_key, FheUint8};

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

        Request::ScoreEncrypted {
            call_id,
            keyset_id,
            circuit_id,
            ciphertext_format,
            encrypted_predicted_outcome,
            resolved_outcome_numerators,
            resolved_outcome_denominator,
        } => match score_encrypted_real(
            keystore,
            &call_id,
            &keyset_id,
            &circuit_id,
            &ciphertext_format,
            &encrypted_predicted_outcome,
            &resolved_outcome_numerators,
            &resolved_outcome_denominator,
        ) {
            Ok(resp) => resp,
            Err(err) => Response::err("score_failed", err.to_string()),
        },

        Request::DecryptScore {
            encrypted_score,
            keyset_id,
        } => match decrypt_score_real(keystore, &keyset_id, &encrypted_score) {
            Ok(resp) => resp,
            Err(err) => Response::err("decrypt_failed", err.to_string()),
        },
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

/// Real homomorphic half-L1 distance. For each pair (encrypted_p_i,
/// cleartext_r_i), computes |p_i * D_r - r_i * D_p| under FHE, then
/// sums across slots and packs (denominator_scale, encrypted_sum) so
/// `decrypt_score` can recover `score = 1 - sum / (2 * D_r * D_p)`.
fn score_encrypted_real(
    keystore: &Keystore,
    _call_id: &str,
    keyset_id: &str,
    circuit_id: &str,
    _ciphertext_format: &str,
    encrypted_predicted_outcome: &[u8],
    resolved_outcome_numerators: &[String],
    resolved_outcome_denominator: &str,
) -> Result<Response> {
    if keyset_id != keystore.keyset_id {
        anyhow::bail!(
            "keyset_id mismatch: request '{keyset_id}' vs active '{}'",
            keystore.keyset_id
        );
    }
    set_server_key(keystore.server_key.clone());

    let (predicted_cts, predicted_denominator) =
        decode_predicted_blob(encrypted_predicted_outcome)?;
    let d_predicted: u8 = predicted_denominator
        .parse()
        .map_err(|err| anyhow!("predicted denominator '{predicted_denominator}' not u8: {err}"))?;
    let d_resolved: u8 = resolved_outcome_denominator
        .parse()
        .map_err(|err| anyhow!("resolved denominator '{resolved_outcome_denominator}' not u8: {err}"))?;
    if predicted_cts.len() != resolved_outcome_numerators.len() {
        anyhow::bail!(
            "vector length mismatch: predicted={}, resolved={}",
            predicted_cts.len(),
            resolved_outcome_numerators.len()
        );
    }

    // sum = Σ_i |p_i * D_r − r_i * D_p|
    // Encrypted sum starts at trivial-zero and accumulates per-slot diffs.
    let mut sum: FheUint8 = FheUint8::try_encrypt_trivial(0u8)
        .map_err(|err| anyhow!("trivial encrypt zero: {err}"))?;
    for (i, r_str) in resolved_outcome_numerators.iter().enumerate() {
        let r_i: u8 = r_str
            .parse()
            .map_err(|err| anyhow!("resolved numerator {i}='{r_str}' not u8: {err}"))?;
        // p_i is already an encrypted FheUint8 with cleartext value 0 or 1
        // (for binary predicted); cross-scaling by D_r yields {0, D_r}.
        let p_scaled: FheUint8 = &predicted_cts[i] * d_resolved;
        // Resolved is cleartext; cross-scaling by D_p gives the same units.
        let r_scaled: u8 = r_i.saturating_mul(d_predicted);
        // |p_scaled − r_scaled| via max/min — both supported on FheUint8.
        let r_scaled_ct = FheUint8::try_encrypt_trivial(r_scaled)
            .map_err(|err| anyhow!("trivial encrypt r_scaled: {err}"))?;
        let max_val = (&p_scaled).max(&r_scaled_ct);
        let min_val = (&p_scaled).min(&r_scaled_ct);
        let diff = max_val - min_val;
        sum = &sum + &diff;
    }

    // Pack the result blob: [scale: u16 BE][serialized FheUint8 of sum].
    // `scale = 2 * D_r * D_p` so decrypt_score recovers score = 1 - sum/scale.
    let scale_u16: u16 = u16::from(d_resolved)
        .checked_mul(u16::from(d_predicted))
        .and_then(|v| v.checked_mul(2))
        .ok_or_else(|| anyhow!("denominator overflow"))?;
    let mut sum_bytes = Vec::new();
    tfhe::safe_serialization::safe_serialize(&sum, &mut sum_bytes, 1 << 24)
        .map_err(|err| anyhow!("safe_serialize sum: {err}"))?;
    let mut packed = Vec::with_capacity(2 + sum_bytes.len());
    packed.extend_from_slice(&scale_u16.to_be_bytes());
    packed.extend_from_slice(&sum_bytes);

    let mut hasher = Sha256::new();
    hasher.update(&packed);
    let score_ciphertext_hash = hex::encode(hasher.finalize());

    // Transcript hash binds (call_id, keyset_id, circuit_id, score_ct_hash).
    // The TS daemon's canonicalTranscriptBytes computes a richer hash that
    // also includes the resolved_outcome_hash + score_range; this sidecar
    // emits a placeholder so the protocol shape is correct, with the
    // real cross-side byte equality landing in a follow-up that mirrors
    // the TS canonical layout exactly.
    let mut th = Sha256::new();
    th.update(b"murmur_score_transcript_v1|");
    th.update(_call_id.as_bytes());
    th.update(b"|");
    th.update(keyset_id.as_bytes());
    th.update(b"|");
    th.update(circuit_id.as_bytes());
    th.update(b"|");
    th.update(score_ciphertext_hash.as_bytes());
    let transcript_hash = hex::encode(th.finalize());

    Ok(Response::ScoreCiphertext {
        encrypted_score: packed,
        transcript_hash,
        score_ciphertext_hash,
    })
}

fn decode_predicted_blob(blob: &[u8]) -> Result<(Vec<FheUint8>, String)> {
    if blob.len() < 4 {
        anyhow::bail!("predicted blob too short ({} bytes)", blob.len());
    }
    let n = u32::from_be_bytes([blob[0], blob[1], blob[2], blob[3]]) as usize;
    // Read null-terminated denominator string.
    let mut idx = 4usize;
    let mut den_end = idx;
    while den_end < blob.len() && blob[den_end] != 0 {
        den_end += 1;
    }
    if den_end >= blob.len() {
        anyhow::bail!("denominator delimiter missing");
    }
    let denominator =
        std::str::from_utf8(&blob[idx..den_end])
            .map_err(|err| anyhow!("denominator utf8: {err}"))?
            .to_string();
    idx = den_end + 1; // skip null

    let mut cts = Vec::with_capacity(n);
    for slot in 0..n {
        if idx + 4 > blob.len() {
            anyhow::bail!("slot {slot} length prefix missing");
        }
        let ct_len = u32::from_be_bytes([
            blob[idx],
            blob[idx + 1],
            blob[idx + 2],
            blob[idx + 3],
        ]) as usize;
        idx += 4;
        if idx + ct_len > blob.len() {
            anyhow::bail!("slot {slot} length {ct_len} overruns blob");
        }
        let ct: FheUint8 =
            safe_deserialize(&mut Cursor::new(&blob[idx..idx + ct_len]), 1 << 24)
                .map_err(|err| anyhow!("deserialize slot {slot}: {err}"))?;
        cts.push(ct);
        idx += ct_len;
    }
    Ok((cts, denominator))
}

/// Real decryption. Single-party dev mode (the sidecar holds the
/// ClientKey). For production threshold release the daemon never calls
/// this op — Z3's `fhe_decrypt_requests` flow returns shares, and the
/// final aggregation happens at the threshold-committee layer.
fn decrypt_score_real(
    keystore: &Keystore,
    keyset_id: &str,
    encrypted_score: &[u8],
) -> Result<Response> {
    if keyset_id != keystore.keyset_id {
        anyhow::bail!(
            "keyset_id mismatch: request '{keyset_id}' vs active '{}'",
            keystore.keyset_id
        );
    }
    if encrypted_score.len() < 2 {
        anyhow::bail!("encrypted_score too short ({} bytes)", encrypted_score.len());
    }
    let scale = u16::from_be_bytes([encrypted_score[0], encrypted_score[1]]);
    if scale == 0 {
        anyhow::bail!("scale=0 (would divide by zero)");
    }
    let sum_bytes = &encrypted_score[2..];
    let sum_ct: FheUint8 =
        safe_deserialize(&mut Cursor::new(sum_bytes), 1 << 24)
            .map_err(|err| anyhow!("deserialize sum: {err}"))?;
    let sum_clear: u8 = sum_ct.decrypt(&keystore.client_key);
    // score = 1 − sum/scale, clamped to [0, 1] for safety.
    let mut score = 1.0_f64 - (f64::from(sum_clear) / f64::from(scale));
    if score < 0.0 {
        score = 0.0;
    } else if score > 1.0 {
        score = 1.0;
    }
    Ok(Response::Score { value: score })
}
