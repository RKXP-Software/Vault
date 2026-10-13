mod devstore;
mod google;

use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::{
    fs,
    path::PathBuf,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;
use uuid::Uuid;
use vault_core::{Entry, EntryInput, Vault};

const MIN_PASSWORD: usize = 10;

struct AppState {
    vault: Mutex<Option<Vault>>,
    dir: PathBuf,
    /// Pedido de cancelamento do login do Google (botão Cancelar).
    login_cancel: AtomicBool,
    /// Endereço de retorno do login colado pelo usuário (quando o navegador não alcança o app).
    pasted_login: Mutex<Option<String>>,
    /// Impede duas sincronizações ao mesmo tempo.
    syncing: AtomicBool,
}

impl AppState {
    fn vault_path(&self) -> PathBuf {
        self.dir.join("cofre.vault")
    }
    fn device_key_path(&self) -> PathBuf {
        self.dir.join("aparelho.key")
    }
    fn drive_token_path(&self) -> PathBuf {
        self.dir.join("drive.token")
    }
    fn drive_email_path(&self) -> PathBuf {
        self.dir.join("drive.email")
    }
}

#[derive(Serialize)]
struct Status {
    exists: bool,
    unlocked: bool,
    secret_on_device: bool,
}

#[derive(Serialize)]
struct Keys {
    secret_key: String,
    recovery_key: String,
}

#[derive(Serialize)]
struct Item {
    id: String,
    title: String,
    url: String,
    email: String,
    username: String,
    updated_at: u64,
}

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn parse_id(id: &str) -> Result<Uuid, String> {
    Uuid::parse_str(id).map_err(|_| "identificador inválido".to_string())
}

/// Grava de forma atômica, mantendo a versão anterior em `.bak`.
fn write_vault(state: &AppState, vault: &mut Vault) -> Result<Vec<u8>, String> {
    let bytes = vault.save();
    let path = state.vault_path();
    let tmp = path.with_extension("vault.tmp");
    fs::write(&tmp, &bytes).map_err(err)?;
    if path.exists() {
        let _ = fs::copy(&path, path.with_extension("vault.bak"));
    }
    fs::rename(&tmp, &path).map_err(err)?;
    Ok(bytes)
}

fn store_secret(state: &AppState, secret: &str) -> Result<(), String> {
    fs::write(state.device_key_path(), devstore::protect(secret.as_bytes())?).map_err(err)
}

fn load_secret(state: &AppState) -> Option<String> {
    let raw = fs::read(state.device_key_path()).ok()?;
    String::from_utf8(devstore::unprotect(&raw).ok()?).ok()
}

fn with_vault<T>(state: &AppState, f: impl FnOnce(&mut Vault) -> Result<T, String>) -> Result<T, String> {
    let mut guard = state.vault.lock().map_err(|_| "estado corrompido".to_string())?;
    let v = guard.as_mut().ok_or("cofre bloqueado")?;
    f(v)
}

#[tauri::command]
fn status(state: State<'_, AppState>) -> Status {
    Status {
        exists: state.vault_path().exists(),
        unlocked: state.vault.lock().map(|g| g.is_some()).unwrap_or(false),
        secret_on_device: state.device_key_path().exists(),
    }
}

#[tauri::command]
async fn create_vault(state: State<'_, AppState>, password: String, remember: bool) -> Result<Keys, String> {
    if state.vault_path().exists() {
        return Err("já existe um cofre neste aparelho".into());
    }
    if password.chars().count() < MIN_PASSWORD {
        return Err(format!("a senha mestra precisa ter pelo menos {MIN_PASSWORD} caracteres"));
    }
    let mut nv = Vault::create(&password).map_err(err)?;
    write_vault(&state, &mut nv.vault)?;
    if remember {
        store_secret(&state, &nv.secret_key)?;
    }
    *state.vault.lock().map_err(err)? = Some(nv.vault);
    Ok(Keys { secret_key: nv.secret_key, recovery_key: nv.recovery_key })
}

#[tauri::command]
async fn unlock(
    state: State<'_, AppState>,
    password: String,
    secret_key: Option<String>,
    remember: bool,
) -> Result<(), String> {
    let secret = match secret_key.filter(|s| !s.trim().is_empty()) {
        Some(s) => s,
        None => load_secret(&state).ok_or("informe a chave secreta")?,
    };
    let bytes = fs::read(state.vault_path()).map_err(err)?;
    let v = Vault::open(&bytes, &password, &secret).map_err(err)?;
    if remember {
        store_secret(&state, &secret)?;
    }
    *state.vault.lock().map_err(err)? = Some(v);
    Ok(())
}

/// Senha esquecida: abre com a chave de recuperação, define nova senha e emite nova chave secreta.
#[tauri::command]
async fn unlock_recovery(
    state: State<'_, AppState>,
    recovery_key: String,
    new_password: String,
    remember: bool,
) -> Result<String, String> {
    if new_password.chars().count() < MIN_PASSWORD {
        return Err(format!("a senha mestra precisa ter pelo menos {MIN_PASSWORD} caracteres"));
    }
    let bytes = fs::read(state.vault_path()).map_err(err)?;
    let mut v = Vault::open_with_recovery(&bytes, &recovery_key).map_err(err)?;
    let secret = v.change_password(&new_password).map_err(err)?.ok_or("chave secreta não renovada")?;
    write_vault(&state, &mut v)?;
    if remember {
        store_secret(&state, &secret)?;
    } else {
        let _ = fs::remove_file(state.device_key_path());
    }
    *state.vault.lock().map_err(err)? = Some(v);
    Ok(secret)
}

#[tauri::command]
fn lock(state: State<'_, AppState>) {
    if let Ok(mut g) = state.vault.lock() {
        *g = None; // Vault zera a chave ao ser descartado.
    }
}

#[tauri::command]
fn forget_device_key(state: State<'_, AppState>) {
    let _ = fs::remove_file(state.device_key_path());
}

#[tauri::command]
fn list_entries(state: State<'_, AppState>, query: String) -> Result<Vec<Item>, String> {
    with_vault(&state, |v| {
        let rows = if query.trim().is_empty() { v.list() } else { v.search(query.trim()) };
        Ok(rows
            .into_iter()
            .map(|e| Item {
                id: e.id.to_string(),
                title: e.data.title.clone(),
                url: e.data.url.clone(),
                email: e.data.email.clone(),
                username: e.data.username.clone(),
                updated_at: e.updated_at,
            })
            .collect())
    })
}

#[tauri::command]
fn get_entry(state: State<'_, AppState>, id: String) -> Result<Entry, String> {
    let id = parse_id(&id)?;
    with_vault(&state, |v| v.get(id).cloned().ok_or_else(|| "registro não encontrado".to_string()))
}

#[tauri::command]
fn save_entry(state: State<'_, AppState>, id: Option<String>, data: EntryInput) -> Result<String, String> {
    with_vault(&state, |v| {
        let id = match id {
            Some(s) => {
                let id = parse_id(&s)?;
                v.update(id, data).map_err(err)?;
                id
            }
            None => v.add(data),
        };
        write_vault(&state, v)?;
        Ok(id.to_string())
    })
}

#[tauri::command]
fn delete_entry(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let id = parse_id(&id)?;
    with_vault(&state, |v| {
        v.delete(id).map_err(err)?;
        write_vault(&state, v).map(|_| ())
    })
}

/// Troca a senha mestra. Pede a senha atual e a chave secreta (a guardada no aparelho, se houver)
/// de novo: é uma ação sensível e o cofre pode ter sido aberto só pela biometria.
#[tauri::command]
async fn change_password(
    state: State<'_, AppState>,
    current: String,
    new_password: String,
    secret_key: Option<String>,
) -> Result<(), String> {
    if new_password.chars().count() < MIN_PASSWORD {
        return Err(format!("a senha mestra precisa ter pelo menos {MIN_PASSWORD} caracteres"));
    }
    let secret = match secret_key.filter(|s| !s.trim().is_empty()) {
        Some(s) => s,
        None => load_secret(&state).ok_or("informe a chave secreta")?,
    };
    let bytes = fs::read(state.vault_path()).map_err(err)?;
    Vault::open(&bytes, &current, &secret).map_err(|_| "Senha atual ou chave secreta incorreta.".to_string())?;
    with_vault(&state, |v| {
        v.set_secret_key(&secret).map_err(err)?; // mantém a chave secreta (não gera outra)
        v.change_password(&new_password).map_err(err)?;
        write_vault(&state, v).map(|_| ())
    })
}

// ---------------------------------------------------------------- Biometria (Android)

#[derive(Serialize)]
struct BioInfo {
    /// O aparelho tem biometria forte cadastrada.
    available: bool,
    /// O usuário ativou o desbloqueio por biometria neste cofre.
    enabled: bool,
}

impl AppState {
    fn bio_blob_path(&self) -> PathBuf {
        self.dir.join("biometria.blob")
    }
}

/// Tira o marcador `[tipo]` das mensagens do plugin; cancelamento vira a palavra "cancelled".
fn bio_error(e: String) -> String {
    if e.contains("[cancelled]") {
        return "cancelled".into();
    }
    match e.strip_prefix('[').and_then(|r| r.split_once(']')) {
        Some((_, msg)) => msg.trim().to_string(),
        None => e,
    }
}

#[tauri::command]
async fn bio_info(app: AppHandle) -> BioInfo {
    let available = tauri::async_runtime::spawn_blocking(devstore::bio_available).await.unwrap_or(false);
    let enabled = available && app.state::<AppState>().bio_blob_path().exists();
    BioInfo { available, enabled }
}

/// Ativa: a chave de dados do cofre é cifrada por uma chave do Keystore que só abre com a biometria.
#[tauri::command]
async fn bio_enable(app: AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let key = {
        let g = state.vault.lock().map_err(|_| "estado corrompido".to_string())?;
        g.as_ref().ok_or("cofre bloqueado")?.unlock_key()
    };
    let blob = tauri::async_runtime::spawn_blocking(move || devstore::bio_seal(&key[..]))
        .await
        .map_err(err)?
        .map_err(bio_error)?;
    fs::write(state.bio_blob_path(), blob).map_err(err)
}

#[tauri::command]
async fn bio_unlock(app: AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let blob = fs::read(state.bio_blob_path()).map_err(|_| "A biometria não está ativada.".to_string())?;
    let opened = tauri::async_runtime::spawn_blocking(move || devstore::bio_open(&blob)).await.map_err(err)?;
    let plain = match opened {
        Ok(p) => zeroize::Zeroizing::new(p),
        Err(e) => {
            if e.contains("[invalidated]") {
                // A biometria do aparelho mudou: o blob não serve mais. Volta para a senha.
                let _ = fs::remove_file(state.bio_blob_path());
                devstore::bio_remove();
            }
            return Err(bio_error(e));
        }
    };
    let key: [u8; 32] = plain.as_slice().try_into().map_err(|_| "chave biométrica inválida".to_string())?;
    let bytes = fs::read(state.vault_path()).map_err(err)?;
    let v = Vault::open_with_unlock_key(&bytes, &key).map_err(err)?;
    *state.vault.lock().map_err(err)? = Some(v);
    Ok(())
}

#[tauri::command]
fn bio_disable(state: State<'_, AppState>) {
    let _ = fs::remove_file(state.bio_blob_path());
    devstore::bio_remove();
}

// ---------------------------------------------------------------- Google Drive

#[derive(Serialize)]
struct DriveInfo {
    /// O build tem as credenciais OAuth (google.secret.json).
    available: bool,
    connected: bool,
    email: String,
}

#[derive(Serialize)]
struct SyncResult {
    /// A senha/chave foi trocada em outro aparelho: o cofre foi trancado, entre com as novas.
    credentials_changed: bool,
    at: u64,
}

fn load_refresh(state: &AppState) -> Option<String> {
    let raw = fs::read(state.drive_token_path()).ok()?;
    String::from_utf8(devstore::unprotect(&raw).ok()?).ok()
}

fn drive_creds(state: &AppState) -> Result<(google::OAuthClient, String), String> {
    let client = google::client().ok_or("Este build não tem as credenciais do Google Drive (google.secret.json).")?;
    let refresh = load_refresh(state).ok_or("Conecte o Google Drive primeiro.")?;
    Ok((client, refresh))
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

#[tauri::command]
fn drive_info(state: State<'_, AppState>) -> DriveInfo {
    DriveInfo {
        available: google::client().is_some(),
        connected: load_refresh(&state).is_some(),
        email: fs::read_to_string(state.drive_email_path()).unwrap_or_default(),
    }
}

/// Abre o navegador para o login e guarda o acesso (protegido pelo sistema). Devolve o e-mail da conta.
#[tauri::command]
async fn drive_connect(app: AppHandle) -> Result<String, String> {
    let client = google::client().ok_or("Este build não tem as credenciais do Google Drive (google.secret.json).")?;
    {
        let st = app.state::<AppState>();
        st.login_cancel.store(false, Ordering::Relaxed);
        if let Ok(mut p) = st.pasted_login.lock() {
            *p = None;
        };
    }
    let app2 = app.clone();
    let c2 = client.clone();
    let refresh = tauri::async_runtime::spawn_blocking(move || {
        let st = app2.state::<AppState>();
        let result = google::authorize(
            &c2,
            |url| app2.opener().open_url(url, None::<&str>).map_err(|e| e.to_string()),
            || st.login_cancel.load(Ordering::Relaxed),
            || {
                let mut guard = st.pasted_login.lock().ok()?;
                guard.take()
            },
        );
        result
    })
    .await
    .map_err(err)??;
    let r2 = refresh.clone();
    let email = tauri::async_runtime::spawn_blocking(move || google::Drive::new(client, r2).user_email())
        .await
        .map_err(err)??;
    let state = app.state::<AppState>();
    fs::write(state.drive_token_path(), devstore::protect(refresh.as_bytes())?).map_err(err)?;
    fs::write(state.drive_email_path(), &email).map_err(err)?;
    Ok(email)
}

/// O usuário colou o endereço da página em que o navegador parou depois do login.
#[tauri::command]
fn drive_paste_login(state: State<'_, AppState>, url: String) {
    if let Ok(mut p) = state.pasted_login.lock() {
        *p = Some(url);
    }
}

#[tauri::command]
fn drive_cancel(state: State<'_, AppState>) {
    state.login_cancel.store(true, Ordering::Relaxed);
}

/// Revoga o acesso no Google e apaga o token local. O arquivo no Drive não é apagado.
#[tauri::command]
async fn drive_disconnect(app: AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    if let Some(token) = load_refresh(&state) {
        let _ = tauri::async_runtime::spawn_blocking(move || google::revoke(&token)).await;
    }
    let _ = fs::remove_file(state.drive_token_path());
    let _ = fs::remove_file(state.drive_email_path());
    Ok(())
}

/// Aparelho novo: baixa o cofre que já está no Drive para depois desbloquear com senha + chave secreta.
#[tauri::command]
async fn drive_pull(app: AppHandle) -> Result<(), String> {
    pull_vault(&app.state::<AppState>()).await
}

async fn pull_vault(state: &AppState) -> Result<(), String> {
    if state.vault_path().exists() {
        return Err("Este aparelho já tem um cofre.".into());
    }
    let (client, refresh) = drive_creds(state)?;
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        let mut d = google::Drive::new(client, refresh);
        match d.find_vault()? {
            Some(f) => d.download(&f.id),
            None => Err("Nenhum cofre do Vault foi encontrado neste Google Drive.".to_string()),
        }
    })
    .await
    .map_err(err)??;
    if !bytes.starts_with(b"PVLT") {
        return Err("O arquivo no Drive não é um cofre do Vault.".into());
    }
    fs::write(state.vault_path(), bytes).map_err(err)
}

// ---------------------------------------------------------------- Pareamento por QR code

/// Quanto tempo um código de pareamento vale.
const PAIR_TTL_SECS: u64 = 600;
const PAIR_PREFIX: &str = "vault1:";

#[derive(Serialize)]
struct PairCode {
    /// Texto do código (o mesmo que está no QR), para colar no outro aparelho.
    code: String,
    /// QR code em SVG.
    svg: String,
    expires_in: u64,
}

#[derive(Serialize)]
struct PairResult {
    /// O cofre foi baixado do Drive: falta só digitar a senha mestra.
    pulled: bool,
}

/// Gera o código/QR que o celular usa para entrar: contém o acesso ao Drive e a chave secreta
/// (nunca a senha mestra). Só no computador.
#[tauri::command]
fn pair_code(state: State<'_, AppState>) -> Result<PairCode, String> {
    use base64::Engine;
    let (_, refresh) = drive_creds(&state)?;
    let secret = state
        .vault
        .lock()
        .map_err(|_| "estado corrompido".to_string())?
        .as_ref()
        .and_then(|v| v.secret_key_string())
        .or_else(|| load_secret(&state))
        .ok_or("A chave secreta não está disponível aqui. Bloqueie e desbloqueie com a senha e a chave secreta.")?;
    let payload = serde_json::json!({ "v": 1, "t": now_secs(), "rt": refresh, "sk": secret });
    let code = format!("{PAIR_PREFIX}{}", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(payload.to_string()));
    Ok(PairCode { svg: qr_svg(&code)?, code, expires_in: PAIR_TTL_SECS })
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn qr_svg(text: &str) -> Result<String, String> {
    use qrcode::{render::svg, QrCode};
    let qr = QrCode::new(text.as_bytes()).map_err(|e| e.to_string())?;
    Ok(qr.render::<svg::Color>().min_dimensions(280, 280).quiet_zone(true).build())
}

#[cfg(any(target_os = "android", target_os = "ios"))]
fn qr_svg(_text: &str) -> Result<String, String> {
    Err("O QR code é gerado no computador.".into())
}

/// Recebe um código de pareamento (lido da câmera ou colado): guarda o acesso ao Drive e a chave
/// secreta protegidos pelo sistema e, se este aparelho ainda não tem cofre, baixa o da nuvem.
#[tauri::command]
async fn pair_apply(app: AppHandle, code: String) -> Result<PairResult, String> {
    use base64::Engine;
    let state = app.state::<AppState>();
    let encoded = code.trim().strip_prefix(PAIR_PREFIX).ok_or("Código de pareamento inválido.")?;
    let raw = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| "Código de pareamento inválido.".to_string())?;
    let v: serde_json::Value = serde_json::from_slice(&raw).map_err(|_| "Código de pareamento inválido.".to_string())?;
    let issued = v["t"].as_u64().ok_or("Código de pareamento inválido.")?;
    if now_secs().saturating_sub(issued) > PAIR_TTL_SECS {
        return Err("O código expirou. Gere um novo no computador.".into());
    }
    let refresh = v["rt"].as_str().ok_or("Código de pareamento inválido.")?.to_string();
    let secret = v["sk"].as_str().ok_or("Código de pareamento inválido.")?.to_string();

    // Confirma que o acesso funciona (e descobre a conta) antes de guardar qualquer coisa.
    let client = google::client().ok_or("Este build não tem as credenciais do Google Drive (google.secret.json).")?;
    let r2 = refresh.clone();
    let email = tauri::async_runtime::spawn_blocking(move || google::Drive::new(client, r2).user_email())
        .await
        .map_err(err)??;
    fs::write(state.drive_token_path(), devstore::protect(refresh.as_bytes())?).map_err(err)?;
    fs::write(state.drive_email_path(), &email).map_err(err)?;
    store_secret(&state, &secret)?;

    let pulled = if state.vault_path().exists() {
        false
    } else {
        pull_vault(&state).await?;
        true
    };
    Ok(PairResult { pulled })
}

/// Baixa o cofre da nuvem, junta com o local (o registro mais recente vence), grava e envia de volta.
#[tauri::command]
async fn sync_now(app: AppHandle) -> Result<SyncResult, String> {
    let state = app.state::<AppState>();
    if state.syncing.swap(true, Ordering::SeqCst) {
        return Err("Sincronização já em andamento.".into());
    }
    let result = sync_inner(&state).await;
    state.syncing.store(false, Ordering::SeqCst);
    result
}

async fn sync_inner(state: &AppState) -> Result<SyncResult, String> {
    let (client, refresh) = drive_creds(state)?;

    // 1. Baixa a versão da nuvem (sem segurar o cofre durante a rede).
    let (c, r) = (client.clone(), refresh.clone());
    let (remote_id, remote_bytes) = tauri::async_runtime::spawn_blocking(move || {
        let mut d = google::Drive::new(c, r);
        let file = d.find_vault()?;
        let bytes = match &file {
            Some(f) => Some(d.download(&f.id)?),
            None => None,
        };
        Ok::<_, String>((file, bytes))
    })
    .await
    .map_err(err)??;

    // 2. Junta e grava localmente.
    let (out, credentials_changed) = {
        let mut guard = state.vault.lock().map_err(|_| "estado corrompido".to_string())?;
        let v = guard.as_mut().ok_or("cofre bloqueado")?;
        let mut changed = false;
        if let Some(b) = &remote_bytes {
            changed = v
                .merge_remote(b)
                .map_err(|e| match e {
                    vault_core::VaultError::Decrypt => {
                        "O arquivo no Drive é de outro cofre ou está corrompido. Nada foi alterado.".to_string()
                    }
                    other => other.to_string(),
                })?
                .credentials_changed;
        }
        (write_vault(state, v)?, changed)
    };

    // 3. Envia o resultado.
    tauri::async_runtime::spawn_blocking(move || {
        let mut d = google::Drive::new(client, refresh);
        let folder = d.ensure_folder()?;
        match remote_id {
            Some(file) => d.update(&file, &folder, &out),
            None => d.create(&folder, &out).map(|_| ()),
        }
    })
    .await
    .map_err(err)??;

    // 4. Senha/chave trocada em outro aparelho: a chave guardada aqui ficou inválida.
    if credentials_changed {
        let _ = fs::remove_file(state.device_key_path());
        if let Ok(mut g) = state.vault.lock() {
            *g = None;
        }
    }
    Ok(SyncResult { credentials_changed, at: now_secs() })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default().plugin(tauri_plugin_opener::init());
    #[cfg(target_os = "android")]
    let builder = builder
        .plugin(tauri_plugin_vault_keystore::init())
        .plugin(tauri_plugin_barcode_scanner::init());
    builder
        .setup(|app| {
            devstore::init(app.handle().clone());
            let dir = app.path().app_data_dir()?;
            fs::create_dir_all(&dir)?;
            app.manage(AppState {
                vault: Mutex::new(None),
                dir,
                login_cancel: AtomicBool::new(false),
                pasted_login: Mutex::new(None),
                syncing: AtomicBool::new(false),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            status,
            create_vault,
            unlock,
            unlock_recovery,
            lock,
            forget_device_key,
            list_entries,
            get_entry,
            save_entry,
            delete_entry,
            change_password,
            bio_info,
            bio_enable,
            bio_unlock,
            bio_disable,
            drive_info,
            drive_connect,
            drive_cancel,
            drive_paste_login,
            drive_disconnect,
            drive_pull,
            pair_code,
            pair_apply,
            sync_now,
        ])
        .run(tauri::generate_context!())
        .expect("erro ao iniciar o Vault");
}
