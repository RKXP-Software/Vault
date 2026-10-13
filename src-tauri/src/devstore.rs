//! Guarda segredos no aparelho, protegidos pelo sistema.
//! - Windows: DPAPI (só o mesmo usuário do Windows consegue ler).
//! - Android: chave do Android Keystore (plugin em plugins/keystore), não exportável.
//!
//! Também expõe o desbloqueio por biometria (só Android por enquanto).

use std::sync::OnceLock;
use tauri::AppHandle;

static APP: OnceLock<AppHandle> = OnceLock::new();

/// Guarda o handle do app (o plugin do Keystore é acessado por ele no Android).
pub fn init(app: AppHandle) {
    let _ = APP.set(app);
}

// ------------------------------------------------------------------ Windows

#[cfg(windows)]
pub fn protect(data: &[u8]) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CRYPT_INTEGER_BLOB};
    unsafe {
        let input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
        let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
        let ok = CryptProtectData(
            &input,
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            0,
            &mut out,
        );
        if ok == 0 {
            return Err("falha ao proteger a chave neste aparelho".into());
        }
        let v = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
        LocalFree(out.pbData as _);
        Ok(v)
    }
}

#[cfg(windows)]
pub fn unprotect(data: &[u8]) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptUnprotectData, CRYPT_INTEGER_BLOB};
    unsafe {
        let input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
        let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
        let ok = CryptUnprotectData(
            &input,
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            0,
            &mut out,
        );
        if ok == 0 {
            return Err("não foi possível ler a chave guardada neste aparelho".into());
        }
        let v = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
        LocalFree(out.pbData as _);
        Ok(v)
    }
}

// ------------------------------------------------------------------ Android

#[cfg(target_os = "android")]
fn with_keystore<T>(
    f: impl FnOnce(&tauri_plugin_vault_keystore::Keystore<tauri::Wry>) -> Result<T, String>,
) -> Result<T, String> {
    use tauri::Manager;
    let app = APP.get().ok_or("Keystore ainda não inicializado")?;
    let ks = app.state::<tauri_plugin_vault_keystore::Keystore<tauri::Wry>>();
    f(&ks)
}

#[cfg(target_os = "android")]
pub fn protect(data: &[u8]) -> Result<Vec<u8>, String> {
    with_keystore(|k| k.protect(data))
}

#[cfg(target_os = "android")]
pub fn unprotect(data: &[u8]) -> Result<Vec<u8>, String> {
    with_keystore(|k| k.unprotect(data))
}

/// Biometria forte cadastrada no aparelho?
#[cfg(target_os = "android")]
pub fn bio_available() -> bool {
    with_keystore(|k| Ok(k.bio_available())).unwrap_or(false)
}

/// Pede a biometria e cifra `data` com a chave biométrica. Bloqueia: chame fora da thread principal.
#[cfg(target_os = "android")]
pub fn bio_seal(data: &[u8]) -> Result<Vec<u8>, String> {
    with_keystore(|k| k.bio_seal(data))
}

/// Pede a biometria e decifra. Erro com `[invalidated]` = a biometria do aparelho mudou.
#[cfg(target_os = "android")]
pub fn bio_open(blob: &[u8]) -> Result<Vec<u8>, String> {
    with_keystore(|k| k.bio_open(blob))
}

#[cfg(target_os = "android")]
pub fn bio_remove() {
    let _ = with_keystore(|k| {
        k.bio_remove();
        Ok(())
    });
}

// ------------------------------------------------------------------ Outros sistemas (sem proteção do SO)

#[cfg(not(any(windows, target_os = "android")))]
pub fn protect(data: &[u8]) -> Result<Vec<u8>, String> {
    Ok(data.to_vec())
}

#[cfg(not(any(windows, target_os = "android")))]
pub fn unprotect(data: &[u8]) -> Result<Vec<u8>, String> {
    Ok(data.to_vec())
}

#[cfg(not(target_os = "android"))]
pub fn bio_available() -> bool {
    false
}

#[cfg(not(target_os = "android"))]
pub fn bio_seal(_data: &[u8]) -> Result<Vec<u8>, String> {
    Err("Desbloqueio por biometria indisponível neste aparelho.".into())
}

#[cfg(not(target_os = "android"))]
pub fn bio_open(_blob: &[u8]) -> Result<Vec<u8>, String> {
    Err("Desbloqueio por biometria indisponível neste aparelho.".into())
}

#[cfg(not(target_os = "android"))]
pub fn bio_remove() {}
