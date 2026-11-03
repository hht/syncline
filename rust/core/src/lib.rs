//! Syncline device core: local database, local writes, pending writes, applying cloud changes, and sync state machines.
//! Does not perform networking or timing, which are driven by outer layers.
//! Exposes only modules required by outer layers (wasm and native modules), keeping the rest crate-private so unused code is flagged by `dead_code`.

mod change;
mod changeset;
mod checksum;
pub mod client;
pub mod database;
mod declaration;
pub mod device;
pub mod effects;
pub mod error;
mod evolution;
pub mod internal;
mod keys;
pub mod limits;
mod owner;
mod protocol;
pub mod recorder;
mod rows;
mod savepoint;
mod shadow_tables;
pub mod shared_space;
mod sql;
mod stage;
mod staged_write;
mod statements;
mod sync;
mod synced_tables;
pub mod tables;
mod unknown_rows;
mod upload_queue;
mod validation;
pub mod values;
mod verifier;
