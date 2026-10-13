//! Núcleo do cofre: modelo de registros, criptografia e merge.
mod crypto;
mod entry;
mod vault;

pub use entry::{Entry, EntryInput};
pub use vault::{MergeOutcome, NewVault, Vault, VaultError};
