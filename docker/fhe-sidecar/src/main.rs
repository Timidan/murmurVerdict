//! `fhe-sidecar` — Murmur Verdict FHE compute coprocessor.
//!
//! Z2-prep scope: stand up the IPC surface and keystore reader so
//! Z2-proper only has to fill in the TFHE-rs handlers. See
//! `docker/fhe-sidecar/README.md` for the operator-facing description.
//!
//! Lifecycle:
//!   1. Parse `--socket` and `--db` (or fall back to
//!      `MURMUR_FHE_SIDECAR_SOCKET` / `MURMUR_VERDICT_DB_PATH`).
//!   2. Open the keystore read-only (best-effort; missing DB at boot
//!      is tolerated — first request just returns `no_active_keyset`).
//!   3. Bind the Unix listener (unlink stale path first; we own it).
//!   4. Accept connections forever, one task per peer. Each peer
//!      drives a request/response loop on the same socket so the
//!      daemon can keep a persistent IPC channel.
//!   5. Shut down cleanly on SIGINT/SIGTERM: drop the listener,
//!      unlink the socket path, let in-flight tasks finish.
//!
//! No global state, no shared cache. The keystore handle is cloneable
//! (it's just a path) and every query opens a fresh RO connection —
//! cheap, and avoids any "did the daemon mutate the row under us"
//! ambiguity.

mod handlers;
mod keystore;
mod protocol;

use anyhow::{Context, Result};
use clap::Parser;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::net::{UnixListener, UnixStream};
use tokio::signal::unix::{signal, SignalKind};

use crate::keystore::Keystore;
use crate::protocol::{read_frame, write_frame, Response};

/// CLI surface. Env vars are the primary configuration channel
/// (matches the daemon's `MURMUR_*` convention); flags exist for
/// operator overrides and local smoke runs.
#[derive(Debug, Parser)]
#[command(
    name = "fhe-sidecar",
    version,
    about = "Murmur Verdict FHE compute coprocessor (Zama TFHE-rs sidecar)"
)]
struct Cli {
    /// Path to bind the Unix-domain listener on. Stale files at this
    /// path are unlinked at startup; ensure the parent directory is
    /// 0700 and owned by the sidecar UID in production.
    #[arg(
        long,
        env = "MURMUR_FHE_SIDECAR_SOCKET",
        default_value = "/var/run/murmur/fhe.sock"
    )]
    socket: PathBuf,

    /// Path to the daemon's verdict sqlite DB. The sidecar opens this
    /// read-only; the daemon (better-sqlite3) is the sole writer.
    #[arg(
        long,
        env = "MURMUR_VERDICT_DB_PATH",
        default_value = "/data/verdict.db"
    )]
    db: PathBuf,
}

#[tokio::main]
async fn main() -> Result<()> {
    // env_logger so the operator can tune `RUST_LOG=fhe_sidecar=info`
    // without us bundling a full tracing stack for a scaffold.
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    let cli = Cli::parse();
    log::info!(
        "fhe-sidecar starting; socket={} db={}",
        cli.socket.display(),
        cli.db.display()
    );

    let keystore = Arc::new(
        Keystore::open(&cli.db).with_context(|| format!("opening keystore at {}", cli.db.display()))?,
    );

    // Unlink stale socket if a previous run died without cleanup.
    // We deliberately do NOT check whether someone else is bound —
    // the Docker compose unit owns this path exclusively.
    if cli.socket.exists() {
        std::fs::remove_file(&cli.socket)
            .with_context(|| format!("removing stale socket {}", cli.socket.display()))?;
    }
    if let Some(parent) = cli.socket.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("ensuring socket parent dir {}", parent.display()))?;
    }

    let listener = UnixListener::bind(&cli.socket)
        .with_context(|| format!("binding {}", cli.socket.display()))?;
    log::info!("listening on {}", cli.socket.display());

    // SIGTERM/SIGINT → graceful shutdown. We don't bother joining the
    // per-connection tasks; tokio's runtime drop sends them cancels
    // and the OS reaps the socket path via the explicit remove below.
    let mut sigterm = signal(SignalKind::terminate()).context("install SIGTERM handler")?;
    let mut sigint = signal(SignalKind::interrupt()).context("install SIGINT handler")?;

    loop {
        tokio::select! {
            biased;
            _ = sigterm.recv() => {
                log::info!("SIGTERM received, shutting down");
                break;
            }
            _ = sigint.recv() => {
                log::info!("SIGINT received, shutting down");
                break;
            }
            accept = listener.accept() => {
                match accept {
                    Ok((stream, _addr)) => {
                        let ks = Arc::clone(&keystore);
                        tokio::spawn(async move {
                            if let Err(e) = serve_connection(stream, ks).await {
                                log::warn!("connection ended with error: {e:#}");
                            }
                        });
                    }
                    Err(e) => {
                        log::error!("accept failed: {e:#}");
                    }
                }
            }
        }
    }

    let _ = std::fs::remove_file(&cli.socket);
    Ok(())
}

/// Per-connection request/response loop. Each peer keeps the socket
/// open across multiple requests so the daemon can amortize the
/// connect cost — there's no protocol-level concept of a "session",
/// just sequential frames.
async fn serve_connection(mut stream: UnixStream, keystore: Arc<Keystore>) -> Result<()> {
    let (read_half, mut write_half) = stream.split();
    let mut reader = tokio::io::BufReader::new(read_half);
    loop {
        let req = match read_frame(&mut reader).await {
            Ok(Some(req)) => req,
            Ok(None) => return Ok(()), // clean EOF
            Err(e) => {
                // Best-effort: tell the peer what happened, then drop
                // the connection. Framing errors are unrecoverable
                // because we don't know where the next frame starts.
                let resp = Response::err("frame_error", format!("{e}"));
                let _ = write_frame(&mut write_half, &resp).await;
                return Err(e.into());
            }
        };

        let resp = handlers::dispatch(&keystore, &req);
        write_frame(&mut write_half, &resp).await?;
    }
}
