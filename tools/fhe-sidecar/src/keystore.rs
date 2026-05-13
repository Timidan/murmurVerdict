//! In-memory keystore. The sidecar generates one TFHE-rs client/server
//! key pair at boot and keeps it in memory for the lifetime of the
//! process. A real production deployment persists the keys (with the
//! committee for the threshold path, or locally for single-party dev)
//! — this scaffold keeps them ephemeral so the binary is self-contained.
//!
//! The `keyset_id` is the sha256 prefix of the serialized server key,
//! matching the MockFheProvider's identification scheme so the TS side
//! reads the same shape regardless of which provider is loaded.

use anyhow::{Context, Result};
use sha2::{Digest, Sha256};
use tfhe::safe_serialization::safe_serialize;
use tfhe::{generate_keys, ClientKey, ConfigBuilder, ServerKey};

const SERVER_KEY_MAX_BYTES: u64 = 1 << 30;

pub struct Keystore {
    pub keyset_id: String,
    pub public_key_blob: Vec<u8>,
    pub public_key_hash: String,
    pub client_key: ClientKey,
    #[allow(dead_code)]
    pub server_key: ServerKey,
}

impl Keystore {
    pub fn generate() -> Result<Self> {
        // ConfigBuilder::default() targets 128-bit security with the
        // small-integer message space TFHE-rs ships out of the box.
        // For the binary-payout-vector scoring path that's plenty.
        let config = ConfigBuilder::default().build();
        let (client_key, server_key) = generate_keys(config);

        let mut public_key_blob = Vec::new();
        safe_serialize(&server_key, &mut public_key_blob, SERVER_KEY_MAX_BYTES)
            .context("safe_serialize server_key")?;
        let mut hasher = Sha256::new();
        hasher.update(&public_key_blob);
        let public_key_hash = hex::encode(hasher.finalize());
        let keyset_id = format!("kset_zama_{}", &public_key_hash[..12]);

        Ok(Self {
            keyset_id,
            public_key_blob,
            public_key_hash,
            client_key,
            server_key,
        })
    }
}
