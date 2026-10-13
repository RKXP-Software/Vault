//! Ponte entre o núcleo do Vault e o JavaScript da extensão.
//!
//! Só leitura: abrir o cofre (com senha + chave secreta, ou com a chave de dados da sessão),
//! listar e ler registros. Gravar e sincronizar ficam para depois.

use serde::Serialize;
use vault_core::Vault;
use wasm_bindgen::prelude::*;

fn js_err<E: std::fmt::Display>(e: E) -> JsError {
    JsError::new(&e.to_string())
}

#[wasm_bindgen]
pub struct WasmVault {
    inner: Vault,
}

/// Dados de um registro para listas e busca: nunca inclui a senha nem as observações.
#[derive(Serialize)]
struct Item<'a> {
    id: String,
    title: &'a str,
    url: &'a str,
    email: &'a str,
    username: &'a str,
}

/// Registro completo, pedido só no momento de preencher ou copiar.
#[derive(Serialize)]
struct Full<'a> {
    id: String,
    title: &'a str,
    url: &'a str,
    email: &'a str,
    username: &'a str,
    password: &'a str,
    notes: &'a str,
}

#[wasm_bindgen]
impl WasmVault {
    /// Abre com a senha mestra e a chave secreta (Argon2id: leva alguns segundos).
    pub fn open(bytes: &[u8], password: &str, secret_key: &str) -> Result<WasmVault, JsError> {
        Vault::open(bytes, password, secret_key).map(|inner| WasmVault { inner }).map_err(js_err)
    }

    /// Abre com a chave de dados guardada na sessão do navegador (instantâneo, sem Argon2).
    #[wasm_bindgen(js_name = openWithKey)]
    pub fn open_with_key(bytes: &[u8], key: &[u8]) -> Result<WasmVault, JsError> {
        let key: [u8; 32] = key.try_into().map_err(|_| JsError::new("chave de sessão inválida"))?;
        Vault::open_with_unlock_key(bytes, &key).map(|inner| WasmVault { inner }).map_err(js_err)
    }

    /// Chave de dados, para a extensão guardar só na memória da sessão e não pedir a senha de novo.
    #[wasm_bindgen(js_name = unlockKey)]
    pub fn unlock_key(&self) -> Vec<u8> {
        self.inner.unlock_key().to_vec()
    }

    /// Lista (JSON) sem senhas, ordenada por título.
    #[wasm_bindgen(js_name = listJson)]
    pub fn list_json(&self) -> Result<String, JsError> {
        let entries = self.inner.list();
        let items: Vec<Item> = entries
            .iter()
            .map(|e| Item {
                id: e.id.to_string(),
                title: &e.data.title,
                url: &e.data.url,
                email: &e.data.email,
                username: &e.data.username,
            })
            .collect();
        serde_json::to_string(&items).map_err(js_err)
    }

    /// Um registro completo (JSON), incluindo a senha.
    #[wasm_bindgen(js_name = getJson)]
    pub fn get_json(&self, id: &str) -> Result<String, JsError> {
        let uuid = id.parse().map_err(|_| JsError::new("identificador inválido"))?;
        let e = self.inner.get(uuid).ok_or_else(|| JsError::new("registro não encontrado"))?;
        let full = Full {
            id: e.id.to_string(),
            title: &e.data.title,
            url: &e.data.url,
            email: &e.data.email,
            username: &e.data.username,
            password: &e.data.password,
            notes: &e.data.notes,
        };
        serde_json::to_string(&full).map_err(js_err)
    }

    /// Revisão do arquivo (cresce a cada gravação em qualquer aparelho).
    pub fn revision(&self) -> f64 {
        self.inner.revision() as f64
    }
}
