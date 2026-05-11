# Murmur Verdict — FHE sidecar (Zama TFHE-rs)
#
# Z2-prep status: this image builds the real `fhe-sidecar` binary. The
# IPC + keystore paths are live; the encrypted-compute handlers
# return `not_implemented_z2_real` until Z2-proper lands.
#
# Why a separate process at all
# -----------------------------
# Zama's TFHE-rs has no Node binding and the published JS/WASM API
# (docs.zama.org/tfhe-rs/integration/js-on-wasm-api) intentionally
# omits computation primitives — it ships keygen + encrypt + serialize
# only. The homomorphic operators (add, sub, comparison) live in the
# Rust crate and run natively. Hence: Rust sidecar, Unix socket, the
# daemon (Node) speaks the protocol defined in
# `docker/fhe-sidecar/src/protocol.rs`.
#
# Wire protocol (lives in src/protocol.rs; mirrored in
# src/verdict/fhe/zama-local-provider.ts on the daemon side)
# ----------------------------------------------------------
#   Transport: SOCK_STREAM over `${MURMUR_FHE_SIDECAR_SOCKET}`
#              (default `/var/run/murmur/fhe.sock`).
#   Framing:   `u32 BE length | JSON body`.
#   Tags:      `op` discriminates requests, `kind` discriminates
#              responses. Error responses use code = stable string.
#
# Threat model notes carried forward from Z0:
#   * The sidecar drops privileges before binding (USER 1000:1000).
#   * Mount the socket directory at mode 0700; only the daemon and the
#     sidecar should be able to traverse it.
#   * No plaintext predictions ever leave the sidecar except the
#     bounded decrypted score (and Z3 will gate even that behind a
#     quorum ceremony).
#
# Build cost: TFHE-rs is heavy (~5 min cold cargo build). The Z2-prep
# layer ordering below puts `Cargo.toml` + `Cargo.lock` ahead of the
# source copy so iterating on `src/*.rs` only triggers a re-link, not
# a full crate rebuild.

# ─── Stage 1: build ──────────────────────────────────────────────────
FROM rust:1.81-slim AS builder

# Toolchain pinning comes from rust-toolchain.toml (channel = "1.81").
# Matching the base image keeps rustup from downloading a duplicate
# toolchain at build time.

WORKDIR /build

# Native build deps. pkg-config + libsqlite3-dev are only needed when
# rusqlite is *not* in bundled mode; we use the bundled feature, so
# these are belt-and-braces — left in because Z2-proper's tfhe-rs
# build script links against libstdc++ and pulling pkg-config now
# avoids a surprise later.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        pkg-config libsqlite3-dev \
 && rm -rf /var/lib/apt/lists/*

# Manifest first so cargo's dep-graph layer caches across source edits.
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY src ./src

# `--locked` so a stale Cargo.lock blows up the build instead of
# silently re-resolving (matches our Node lockfile posture).
RUN cargo build --release --locked

# ─── Stage 2: runtime ────────────────────────────────────────────────
FROM debian:12-slim

# libsqlite3-0 is here for symmetry with Stage 1; the bundled feature
# statically links sqlite into the binary so this is technically
# optional. Kept so an operator who flips the bundled feature off
# doesn't immediately hit a missing-shared-lib failure.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        libsqlite3-0 ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=builder /build/target/release/fhe-sidecar /usr/local/bin/fhe-sidecar

# /var/run/murmur is the socket dir. Owned by the unprivileged UID
# the sidecar runs as so it can `bind(2)` without CAP_NET_BIND or a
# root-owned parent.
RUN mkdir -p /var/run/murmur \
 && chown 1000:1000 /var/run/murmur \
 && chmod 0700 /var/run/murmur

USER 1000:1000
ENV RUST_BACKTRACE=1 \
    RUST_LOG=info

# No CMD args — the binary reads its config from
# MURMUR_FHE_SIDECAR_SOCKET + MURMUR_VERDICT_DB_PATH. Compose / k8s
# can still pass `--socket /elsewhere.sock` if needed.
ENTRYPOINT ["/usr/local/bin/fhe-sidecar"]
