//! Read-only sqlite view of the daemon's FHE tables.
//!
//! The daemon (Node, via better-sqlite3) is the sole writer of
//! `fhe_keysets` and `fhe_circuits` — Z0 seeds rows on boot and Z2-proper
//! will flip them from `pending` to `active` once the sidecar reports a
//! real keygen. The sidecar only ever READS from these tables. Keeping
//! the writer single-sourced means we don't need a cross-process lock
//! protocol; SQLite's own WAL serialization is enough.
//!
//! Schema (mirrors `src/verdict/db.ts` MIGRATION_023):
//!
//! ```sql
//! CREATE TABLE fhe_keysets (
//!     keyset_id        TEXT PRIMARY KEY,
//!     provider         TEXT NOT NULL,    -- 'zama_local' for us
//!     public_key_blob  BLOB NOT NULL,
//!     public_key_hash  TEXT NOT NULL,
//!     status           TEXT NOT NULL,    -- 'pending' | 'active' | ...
//!     vector_max_len   INTEGER NOT NULL,
//!     created_at       TEXT NOT NULL,
//!     activated_at     TEXT,
//!     suspended_at     TEXT,
//!     notes            TEXT
//! );
//! CREATE TABLE fhe_circuits (
//!     circuit_id       TEXT PRIMARY KEY,
//!     name             TEXT NOT NULL,    -- 'half_l1_distance_*'
//!     description      TEXT,
//!     vector_max_len   INTEGER NOT NULL,
//!     compiled_at      TEXT NOT NULL,
//!     provider         TEXT NOT NULL,
//!     handle           TEXT NOT NULL,
//!     UNIQUE (provider, name, vector_max_len)
//! );
//! ```

use anyhow::{Context, Result};
use rusqlite::{Connection, OpenFlags};
use std::path::Path;

/// One row from `fhe_keysets`. Only the columns the sidecar actually
/// uses are surfaced — `notes` and the lifecycle timestamps stay
/// behind the abstraction.
///
/// `status` and `vector_max_len` are unused in Z2-prep (the handler
/// already filters by `status='active'`, and the daemon enforces
/// `vector_max_len` at submission time). Z2-proper will read them when
/// validating ciphertext shapes before invoking the circuit, so they're
/// surfaced now to lock the row layout.
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct KeysetRow {
    pub keyset_id: String,
    pub provider: String,
    pub public_key_blob: Vec<u8>,
    pub public_key_hash: String,
    pub status: String,
    pub vector_max_len: i64,
}

/// One row from `fhe_circuits`.
#[derive(Debug, Clone)]
pub struct CircuitRow {
    pub circuit_id: String,
    pub name: String,
    pub vector_max_len: i64,
    pub handle: String,
}

/// Read-only keystore handle. Cheap to clone — internally just a path;
/// every query opens a fresh connection so we can't accidentally hold
/// a write lock that blocks the daemon's seeder.
pub struct Keystore {
    db_path: std::path::PathBuf,
}

impl Keystore {
    /// Opens (does not create) the daemon's verdict DB in read-only
    /// mode. If the file does not exist yet we still succeed — the
    /// daemon may boot a fraction of a second after the sidecar and
    /// the first query will simply return `None`. Z2-proper adds a
    /// startup wait-loop; the prep scaffold tolerates the race.
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let p = path.as_ref().to_path_buf();
        // Touch a connection to surface obvious failures (path is a
        // directory, permissions, etc.) at boot rather than at first
        // request. SQLite happily returns "unable to open" for missing
        // files only when the OpenFlags include CREATE, which we don't.
        if p.exists() {
            let _conn = Connection::open_with_flags(
                &p,
                OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )
            .with_context(|| format!("opening sqlite RO at {}", p.display()))?;
        }
        Ok(Self { db_path: p })
    }

    fn connect(&self) -> Result<Connection> {
        Connection::open_with_flags(
            &self.db_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .with_context(|| format!("opening sqlite RO at {}", self.db_path.display()))
    }

    /// Returns the single `status='active'` keyset for `provider`,
    /// or `None` if there isn't one yet. The daemon is responsible
    /// for the invariant that at most one keyset is active per
    /// provider; this query orders by `activated_at DESC` defensively
    /// so a duplicate row doesn't crash us mid-rollout.
    pub fn get_active_keyset(&self, provider: &str) -> Result<Option<KeysetRow>> {
        if !self.db_path.exists() {
            return Ok(None);
        }
        let conn = self.connect()?;
        let row = conn
            .query_row(
                "SELECT keyset_id, provider, public_key_blob, public_key_hash,
                        status, vector_max_len
                 FROM fhe_keysets
                 WHERE provider = ?1 AND status = 'active'
                 ORDER BY activated_at DESC NULLS LAST
                 LIMIT 1",
                [provider],
                |r| {
                    Ok(KeysetRow {
                        keyset_id: r.get(0)?,
                        provider: r.get(1)?,
                        public_key_blob: r.get(2)?,
                        public_key_hash: r.get(3)?,
                        status: r.get(4)?,
                        vector_max_len: r.get(5)?,
                    })
                },
            )
            .ok();
        Ok(row)
    }

    /// Returns the compiled-circuit row for `(provider, name,
    /// vector_max_len)`. `None` if not yet registered.
    pub fn get_circuit(
        &self,
        provider: &str,
        name: &str,
        vector_max_len: i64,
    ) -> Result<Option<CircuitRow>> {
        if !self.db_path.exists() {
            return Ok(None);
        }
        let conn = self.connect()?;
        let row = conn
            .query_row(
                "SELECT circuit_id, name, vector_max_len, handle
                 FROM fhe_circuits
                 WHERE provider = ?1 AND name = ?2 AND vector_max_len = ?3
                 ORDER BY compiled_at DESC
                 LIMIT 1",
                rusqlite::params![provider, name, vector_max_len],
                |r| {
                    Ok(CircuitRow {
                        circuit_id: r.get(0)?,
                        name: r.get(1)?,
                        vector_max_len: r.get(2)?,
                        handle: r.get(3)?,
                    })
                },
            )
            .ok();
        Ok(row)
    }
}
