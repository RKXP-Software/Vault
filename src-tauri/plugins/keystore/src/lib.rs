//! Android Keystore + biometria. Só existe no Android; no desktop o app usa o DPAPI (src/devstore.rs).
//!
//! - `protect`/`unprotect`: cifra com uma chave do Keystore presa ao aparelho (não exportável).
//! - `bio_seal`/`bio_open`: cifra com uma chave do Keystore que só opera depois da biometria
//!   (BiometricPrompt com CryptoObject). A chave é invalidada se uma nova digital/rosto for cadastrado.

#![cfg(target_os = "android")]

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::{
    plugin::{Builder, PluginHandle, TauriPlugin},
    Manager, Runtime,
};

const PLUGIN_IDENTIFIER: &str = "com.rkxp.vault.keystore";

pub struct Keystore<R: Runtime>(PluginHandle<R>);

#[derive(Serialize)]
struct Blob<'a> {
    data: &'a str,
}

#[derive(Deserialize)]
struct BlobOut {
    data: String,
}

#[derive(Deserialize)]
struct Status {
    available: bool,
}

impl<R: Runtime> Keystore<R> {
    fn blob(&self, command: &str, bytes: &[u8]) -> Result<Vec<u8>, String> {
        let encoded = B64.encode(bytes);
        let out: BlobOut = self
            .0
            .run_mobile_plugin(command, Blob { data: &encoded })
            .map_err(|e| e.to_string())?;
        B64.decode(out.data).map_err(|e| e.to_string())
    }

    /// Cifra com a chave do aparelho (sem biometria).
    pub fn protect(&self, data: &[u8]) -> Result<Vec<u8>, String> {
        self.blob("protect", data)
    }

    pub fn unprotect(&self, data: &[u8]) -> Result<Vec<u8>, String> {
        self.blob("unprotect", data)
    }

    /// O aparelho tem biometria forte cadastrada?
    pub fn bio_available(&self) -> bool {
        self.0.run_mobile_plugin::<Status>("bioStatus", ()).map(|s| s.available).unwrap_or(false)
    }

    /// Mostra o prompt de biometria e cifra `data` com a chave biométrica (cria a chave).
    /// Bloqueia até o usuário responder: chame fora da thread principal.
    pub fn bio_seal(&self, data: &[u8]) -> Result<Vec<u8>, String> {
        self.blob("bioSeal", data)
    }

    /// Mostra o prompt de biometria e decifra. Erros marcados com `[invalidated]` indicam que a
    /// biometria do aparelho mudou e o blob não serve mais.
    pub fn bio_open(&self, blob: &[u8]) -> Result<Vec<u8>, String> {
        self.blob("bioOpen", blob)
    }

    pub fn bio_remove(&self) {
        let _ = self.0.run_mobile_plugin::<serde_json::Value>("bioRemove", ());
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("vault-keystore")
        .setup(|app, api| {
            let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "KeystorePlugin")?;
            app.manage(Keystore(handle));
            Ok(())
        })
        .build()
}
