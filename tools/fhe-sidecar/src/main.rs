//! murmur-fhe-sidecar — real Zama TFHE-rs sidecar binary.
//!
//! Speaks the length-prefixed JSON protocol on a Unix-domain socket.
//! The TS daemon's `ZamaLocalFheProvider` connects to this binary one
//! request per FHE operation; see `src/verdict/fhe/sidecar-client.ts`
//! for the client side.
//!
//! Status: REAL implementation for `get_active_keyset`, `get_circuit`,
//! `encrypt_predicted`. `score_encrypted` + `decrypt_score` emit a
//! typed error (`score_not_yet_real` / `decrypt_not_yet_real`) until
//! the homomorphic abs-diff + sum + divide port lands. The daemon's
//! resolver handles those errors by leaving calls at pending_t1 and
//! retrying — same posture as a transient sidecar outage.
//!
//! Run:
//!   cargo run --release --bin murmur-fhe-sidecar -- \
//!     --socket /run/murmur/fhe-sidecar.sock
//!
//! Daemon configuration (env):
//!   MURMUR_FHE_PROVIDER=zama_local
//!   MURMUR_FHE_SIDECAR_SOCKET=/run/murmur/fhe-sidecar.sock

mod handlers;
mod keystore;
mod protocol;

use anyhow::{Context, Result};
use log::{error, info, warn};
use std::io::{Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::Arc;

use crate::keystore::Keystore;
use crate::protocol::{Request, Response};

const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;

fn main() -> Result<()> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    let socket_path = parse_socket_arg()?;
    if socket_path.exists() {
        std::fs::remove_file(&socket_path)
            .with_context(|| format!("removing stale socket at {:?}", socket_path))?;
    }
    if let Some(parent) = socket_path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating socket dir {:?}", parent))?;
    }
    info!("generating TFHE-rs keystore (this can take a few seconds…)");
    let keystore = Arc::new(Keystore::generate().context("generating keystore")?);
    info!(
        "keystore ready: keyset_id={}, server_key={} bytes",
        keystore.keyset_id,
        keystore.public_key_blob.len()
    );

    let listener = UnixListener::bind(&socket_path)
        .with_context(|| format!("binding UDS at {:?}", socket_path))?;
    info!("murmur-fhe-sidecar listening on {:?}", socket_path);

    for incoming in listener.incoming() {
        match incoming {
            Ok(stream) => {
                let ks = keystore.clone();
                std::thread::spawn(move || {
                    if let Err(err) = handle_connection(&ks, stream) {
                        warn!("connection error: {err:#}");
                    }
                });
            }
            Err(err) => error!("accept failed: {err}"),
        }
    }
    Ok(())
}

fn parse_socket_arg() -> Result<PathBuf> {
    let mut iter = std::env::args().skip(1);
    while let Some(arg) = iter.next() {
        if arg == "--socket" {
            let value = iter
                .next()
                .context("--socket requires a path argument")?;
            return Ok(PathBuf::from(value));
        }
    }
    Ok(PathBuf::from(
        std::env::var("MURMUR_FHE_SIDECAR_SOCKET")
            .unwrap_or_else(|_| "/run/murmur/fhe-sidecar.sock".to_string()),
    ))
}

fn handle_connection(keystore: &Keystore, mut stream: UnixStream) -> Result<()> {
    // One request per connection — matches the TS client's one-shot
    // posture in sidecar-client.ts.
    let mut len_buf = [0u8; 4];
    stream
        .read_exact(&mut len_buf)
        .context("reading request length prefix")?;
    let body_len = u32::from_be_bytes(len_buf) as usize;
    if body_len == 0 || body_len > MAX_FRAME_BYTES {
        return write_response(
            &mut stream,
            &Response::err("frame_invalid", format!("body_len={body_len}")),
        );
    }
    let mut body = vec![0u8; body_len];
    stream
        .read_exact(&mut body)
        .context("reading request body")?;
    let req: Request = match serde_json::from_slice(&body) {
        Ok(req) => req,
        Err(err) => {
            return write_response(
                &mut stream,
                &Response::err("parse_failed", err.to_string()),
            );
        }
    };
    let resp = handlers::handle(keystore, req);
    write_response(&mut stream, &resp)
}

fn write_response(stream: &mut UnixStream, resp: &Response) -> Result<()> {
    let body = serde_json::to_vec(resp).context("serializing response")?;
    if body.len() > MAX_FRAME_BYTES {
        anyhow::bail!("response body {} bytes exceeds cap", body.len());
    }
    let len_buf = (body.len() as u32).to_be_bytes();
    stream
        .write_all(&len_buf)
        .context("writing response length")?;
    stream.write_all(&body).context("writing response body")?;
    stream.flush().context("flushing response")?;
    Ok(())
}
