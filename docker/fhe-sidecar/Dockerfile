# Murmur Verdict — FHE sidecar (Zama TFHE-rs)
#
# Z0 status: PLACEHOLDER. No Rust crate exists yet — Z2 lands the
# `murmur-fhe-sidecar` binary that hosts TFHE-rs over a Unix-domain
# socket. This Dockerfile pins the toolchain we'll use so the eventual
# CI image build is reproducible, and it documents the wire protocol
# for Z1/Z2 implementers without forcing them to guess.
#
# Wire protocol (matches comments in src/verdict/fhe/zama-local-provider.ts)
# ------------------------------------------------------------------------
#   Transport: SOCK_STREAM over `/run/murmur/fhe-sidecar.sock` (path
#              overridable via MURMUR_FHE_SIDECAR_SOCKET).
#   Framing:   u32 BE length prefix, then u8 op_code, then payload.
#   Encoding:  payloads use length-prefixed bincode for predictable
#              decoding from both Rust and Node; we'll provide a
#              shared schema crate that exports msg::v1::{Request,
#              Response} on the Rust side and a generated TS module
#              under src/verdict/fhe/sidecar-types.ts on the Node side.
#
# Op-codes (also documented in fhe/zama-local-provider.ts header):
#   0x01 GET_ACTIVE_KEY
#   0x02 GET_CIRCUIT
#   0x10 SCORE_ENCRYPTED
#   0x20 DECRYPT_SCORE_REQ (single-party dev only — Z3 replaces this)
#   0xF0 ERROR
#
# Threat model notes for Z2:
#   * The sidecar process MUST drop privileges before binding the
#     socket; SOCK_STREAM on a 0700 directory is the operator-trust
#     boundary in single-host deployments.
#   * No plaintext predictions ever leave the sidecar except the
#     bounded decrypted score (and even that is gated to single-party
#     dev mode until Z3 lands the threshold ceremony).
#   * Build with `--release` + `RUSTFLAGS="-C target-cpu=x86-64-v3"`
#     to match the throughput numbers the v0 plan assumes (Zama 1.5
#     8-bit add ~76ms on AVX2). ARM64 builds use the default target.
#
# DO NOT add a top-level npm script that depends on this Dockerfile in
# Z0 — it's documentation, not a runnable target. Z2's PR will add
# `npm run fhe:sidecar:build` and the corresponding docker-compose
# wiring.

FROM rust:1.81-slim AS toolchain

# Pinned for reproducibility; bump in lockstep with the actual Rust
# crate that lands in Z2.
RUN rustup component add rustfmt clippy

WORKDIR /work

# Z2 will copy the actual crate here:
#   COPY rust/murmur-fhe-sidecar /work/murmur-fhe-sidecar
#   WORKDIR /work/murmur-fhe-sidecar
#   RUN cargo build --release
#   FROM debian:bookworm-slim
#   COPY --from=toolchain /work/murmur-fhe-sidecar/target/release/murmur-fhe-sidecar /usr/local/bin/
#   USER 65534:65534
#   ENTRYPOINT ["/usr/local/bin/murmur-fhe-sidecar"]

# Z0 placeholder entrypoint — just exits non-zero so anyone who
# accidentally builds and runs this image sees a loud failure rather
# than a "looks healthy" no-op.
CMD ["sh", "-c", "echo 'murmur-fhe-sidecar: Z0 placeholder — Z2 ships the real binary' >&2; exit 1"]
