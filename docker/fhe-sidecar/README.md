# Murmur Verdict — FHE sidecar (Zama TFHE-rs)

Compute coprocessor for the daemon's operator-blind privacy path. The
daemon (Node) holds the user-facing API and the SQLite store; the
sidecar (this crate, Rust) holds the FHE keys and runs the encrypted
arithmetic.

This is the **Z2-prep** scaffold. The IPC surface, keystore, and
Docker build are wired and stable. The encrypted-compute handlers
return `not_implemented_z2_real` until Z2-proper replaces them with
real `halfL1Distance` evaluation + bounded-score decrypt.

## Why a separate process

Zama's TFHE-rs has no Node binding. The published JS/WASM API
(`docs.zama.org/tfhe-rs/integration/js-on-wasm-api`) is keygen +
encrypt + serialize only — the homomorphic operators (add, sub,
comparison) are Rust-native. Running them in-process inside the daemon
would either:

1. require shipping a Node N-API binding we'd have to maintain, or
2. spawn a Rust child per request and pay the cold-start cost (~hundreds
   of ms per `scoreEncrypted`).

Splitting them as two long-lived processes communicating over a Unix
domain socket gets us the right boundary for free, and matches how the
operator-blind privacy plan
(`docs/operator-blind-privacy-plan.md` §4) describes the deployment.

## Wire protocol

Transport: `SOCK_STREAM` on a Unix-domain socket. Path comes from
`MURMUR_FHE_SIDECAR_SOCKET` (default `/var/run/murmur/fhe.sock`). The
parent directory must be `0700` and owned by the sidecar UID so only
the daemon can traverse it.

Framing: each message is `u32 BE length | JSON body`. Length is the
byte length of the JSON body and is capped at 8 MiB (see
`src/protocol.rs::MAX_FRAME_BYTES`).

### Requests

```jsonc
{ "op": "get_active_keyset" }

{ "op": "get_circuit",
  "name": "half_l1_distance_binary",
  "vector_max_len": 2 }

{ "op": "score_encrypted",
  "circuit_id": "circ_…",
  "encrypted_predicted_outcome": [ /* bytes */ ],
  "resolved_outcome_numerators": ["1", "0"],
  "resolved_outcome_denominator": "1" }

{ "op": "decrypt_score",
  "encrypted_score": [ /* bytes */ ],
  "keyset_id": "kset_…" }
```

BigInts ride as decimal strings to preserve full precision across the
Node BigInt ↔ Rust BigUint boundary; this matches how
`payout_denominator` is stored in SQLite.

### Responses

```jsonc
{ "kind": "keyset_info",
  "keyset_id": "kset_zama_local_…",
  "public_key_blob": [ /* bytes */ ],
  "public_key_hash": "abc…",
  "provider": "zama_local" }

{ "kind": "circuit_info",
  "circuit_id": "circ_…",
  "name": "half_l1_distance_binary",
  "vector_max_len": 2,
  "handle": "…" }

{ "kind": "score_ciphertext",
  "encrypted_score": [ /* bytes */ ],
  "transcript_hash": "…" }

{ "kind": "score", "value": 0.875 }

{ "kind": "error", "code": "not_implemented_z2_real",
  "message": "scoreEncrypted: Z2-prep scaffold; …" }
```

`code` is the stable contract — daemon-side dispatch switches on it
(e.g. `not_implemented_z2_real` maps to `FheNotImplementedError`).

## Keystore

The sidecar reads `fhe_keysets` and `fhe_circuits` from the daemon's
SQLite DB (`MURMUR_VERDICT_DB_PATH`, default `/data/verdict.db`) in
**read-only** mode. The daemon (better-sqlite3) is the sole writer; Z0
seeds rows as `status='pending'` and Z2-proper will flip them to
`active` after a real keygen ceremony.

## Running locally

```bash
docker compose \
  -f docker-compose.yml \
  -f docker/fhe-sidecar/docker-compose.fhe.yml \
  up
```

Compose places the socket on a shared named volume (`fhe_sockets`)
mounted at `/var/run/murmur` inside both containers. The daemon reads
`MURMUR_FHE_SIDECAR_SOCKET=/var/run/murmur/fhe.sock` from the same
overlay.

Cold builds of the sidecar image take ~5 minutes (TFHE-rs is large).
Subsequent builds reuse the cargo dep layer and finish in seconds.

## What's NOT in this scaffold

- No real homomorphic compute — Z2-proper lands `halfL1Distance` and
  the bounded-score decrypt.
- No threshold-decrypt ceremony — that's Z3.
- No Rust unit tests — Z2-proper adds them alongside the real handlers.
- No CI build — the cargo build is intentionally local-only until the
  real handlers exist (the build is too expensive to spend on a
  scaffold).

## Z2-proper milestone

Z2-proper is "done" when:

1. `scoreEncrypted` returns a real `score_ciphertext` for the
   `half_l1_distance_binary` and `half_l1_distance_n` circuits.
2. `decryptScore` returns a value in `[0, 1]` from a freshly-scored
   ciphertext (single-party dev mode — Z3 replaces this with the
   quorum flow).
3. The daemon's `submitCall` + `resolver` paths can execute the FHE
   pipeline end-to-end against this sidecar with
   `MURMUR_FHE_PROVIDER=zama_local`.
