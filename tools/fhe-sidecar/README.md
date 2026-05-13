# murmur-fhe-sidecar

Real Zama TFHE-rs sidecar binary. Speaks the length-prefixed JSON
protocol defined by `src/verdict/fhe/sidecar-client.ts` on a
Unix-domain socket.

## Build + run

```sh
cd tools/fhe-sidecar
cargo build --release
target/release/murmur-fhe-sidecar --socket /tmp/fhe-sidecar.sock
```

First run generates a TFHE-rs `ClientKey` + `ServerKey` (takes ~10s).
The server key (~180 MB) lives in process memory and never leaves the
sidecar; the daemon identifies it by `keyset_id` + sha256.

## Daemon configuration

```sh
MURMUR_FHE_PROVIDER=zama_local
MURMUR_FHE_SIDECAR_SOCKET=/tmp/fhe-sidecar.sock
```

When the daemon boots with these env vars, `ZamaLocalFheProvider` calls
the sidecar over UDS for every FHE operation. Without the sidecar
running the daemon's `/v2/calls` path returns `503 fhe_unavailable`.

## Op-code status

| Op | Status |
|---|---|
| `get_active_keyset` | REAL — TFHE-rs keypair, sha256 ID |
| `get_circuit` | REAL — deterministic handle bound to (name, vector_max_len, keyset_id) |
| `encrypt_predicted` | REAL — `FheUint8::encrypt` per numerator, packed blob |
| `score_encrypted` | STUB — returns `error{code:"score_not_yet_real"}`. Z2 follow-up will implement homomorphic half-L1 distance via TFHE-rs `FheUint8` arithmetic. |
| `decrypt_score` | STUB — depends on `score_encrypted` + the v0.3 threshold-release path. |

Filling in the two stubs is a single-session port over TFHE-rs's
`FheUint` operators (`+`, `-`, comparison-based abs, division).
The wire protocol stays stable; the daemon side won't need changes.

## License

Same license as the parent repo. TFHE-rs itself is BSD-3-Clause from
Zama — no payment, no API keys.
