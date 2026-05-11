//! Z2-prep request handlers.
//!
//! Two of the four entry points (`GetActiveKeyset`, `GetCircuit`) can
//! actually serve real data: they read the keystore the daemon has
//! already seeded and reflect it back. The encrypted-compute paths
//! (`ScoreEncrypted`, `DecryptScore`) return [`Response::Error`] with
//! `code = "not_implemented_z2_real"` because the TFHE-rs wiring lands
//! in Z2-proper.
//!
//! Why surface the keystore queries at all in Z2-prep?
//!   * It lets the daemon's smoke harness round-trip a real request
//!     through the IPC end-to-end without needing the crypto.
//!   * It exercises rusqlite + serde + framing as one slice, so any
//!     packaging regression (missing libsqlite, JSON shape drift, etc.)
//!     trips locally instead of at Z2-proper integration time.
//!
//! No state lives in this module on purpose. The handler functions
//! take a `&Keystore` reference and a `&Request` and return a
//! `Response`; the connection loop in `main.rs` owns the lifecycle.

use crate::keystore::Keystore;
use crate::protocol::{Request, Response};

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
        Request::ScoreEncrypted { .. } => Response::not_implemented("scoreEncrypted"),
        Request::DecryptScore { .. } => Response::not_implemented("decryptScore"),
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
