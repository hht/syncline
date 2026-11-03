//! Syncline 的设备一侧：本机库、本机写、待上传、收下云端的改动与同步的状态机。不做网络与计时，由外层驱动。
//! 只公开外层（wasm 与原生模块）要用的模块，其余在 crate 内：没人用的代码由编译器的 `dead_code` 报出。

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
