use serde::{Deserialize, Serialize};
use uuid::Uuid;
use zeroize::{Zeroize, ZeroizeOnDrop};

/// Dados editáveis de um registro. Todos os campos são opcionais (podem ficar vazios).
#[derive(Clone, Default, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
pub struct EntryInput {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub notes: String,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Entry {
    pub id: Uuid,
    pub data: EntryInput,
    pub created_at: u64,
    pub updated_at: u64,
    /// Marca de exclusão (tombstone), necessária para o merge entre dispositivos.
    pub deleted: bool,
}

impl std::fmt::Debug for Entry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Entry").field("id", &self.id).field("title", &self.data.title).finish()
    }
}
