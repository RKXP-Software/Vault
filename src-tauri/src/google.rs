// Google: login OAuth (loopback + PKCE, pelo navegador) e a API do Drive para um único arquivo.
//
// Escopo `drive.file`: o Vault só enxerga o que ele mesmo criou. O ID e a chave do cliente OAuth
// vêm de src-tauri/google.secret.json no build (fora do git). O arquivo na nuvem já vai cifrado
// pelo núcleo; o Google nunca vê o conteúdo.

use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64URL;
use base64::Engine;
use rand::RngCore;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::time::{Duration, Instant};

const SCOPE: &str = "https://www.googleapis.com/auth/drive.file";
const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const REVOKE_URL: &str = "https://oauth2.googleapis.com/revoke";
const API: &str = "https://www.googleapis.com/drive/v3";
const UPLOAD: &str = "https://www.googleapis.com/upload/drive/v3";

/// Nome e marca do arquivo na nuvem. O arquivo fica dentro de uma pasta "Vault" criada pelo app.
const FILE_NAME: &str = "cofre.vault";
const FOLDER_NAME: &str = "Vault";
const FOLDER_MIME: &str = "application/vnd.google-apps.folder";
const FOLDER_PROP_VALUE: &str = "vault-folder";
const PROP_KEY: &str = "app";
const PROP_VALUE: &str = "vault";
/// Teto de download: um cofre de senhas nunca chega perto disso.
const MAX_DOWNLOAD: u64 = 64 * 1024 * 1024;

pub const LOGIN_CANCELLED: &str = "Login cancelado.";
pub const REVOKED: &str = "O acesso ao Google Drive foi revogado ou expirou. Conecte de novo.";

#[derive(Clone)]
pub struct OAuthClient {
    pub id: String,
    pub secret: String,
}

/// Credenciais embutidas no build (None se `google.secret.json` não existia).
pub fn client() -> Option<OAuthClient> {
    let id = option_env!("VAULT_GOOGLE_CLIENT_ID")?.trim();
    let secret = option_env!("VAULT_GOOGLE_CLIENT_SECRET")?.trim();
    (!id.is_empty() && !secret.is_empty()).then(|| OAuthClient { id: id.into(), secret: secret.into() })
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(10)).timeout(Duration::from_secs(60)).build()
}

/// Codifica para URL (RFC 3986; caracteres não reservados ficam).
fn enc(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn dec(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        let hex = (b[i] == b'%' && i + 2 < b.len())
            .then(|| std::str::from_utf8(&b[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()))
            .flatten();
        match (b[i], hex) {
            (_, Some(v)) => {
                out.push(v);
                i += 2;
            }
            (b'+', None) => out.push(b' '),
            (c, None) => out.push(c),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn random_token(bytes: usize) -> String {
    let mut b = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut b);
    B64URL.encode(b)
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: Option<String>,
    expires_in: Option<u64>,
    refresh_token: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

/// Repete chamadas que falharam por rede (DNS/conexão), não por resposta do servidor. No Android, logo
/// que o app volta do navegador a rede ainda está bloqueada por alguns segundos.
fn retry_net<T>(mut f: impl FnMut() -> Result<T, ureq::Error>) -> Result<T, ureq::Error> {
    const ATTEMPTS: u32 = 8;
    let mut last = None;
    for i in 0..ATTEMPTS {
        match f() {
            Err(e @ ureq::Error::Transport(_)) => {
                last = Some(e);
                if i + 1 < ATTEMPTS {
                    std::thread::sleep(Duration::from_secs(2));
                }
            }
            other => return other,
        }
    }
    Err(last.expect("pelo menos uma tentativa"))
}

fn token_request(form: &[(&str, &str)]) -> Result<TokenResponse, String> {
    let resp = match retry_net(|| agent().post(TOKEN_URL).send_form(form)) {
        Ok(r) => r,
        Err(ureq::Error::Status(_, r)) => r,
        Err(e) => return Err(format!("Sem conexão com o Google: {e}")),
    };
    let t: TokenResponse = resp.into_json().map_err(|e| format!("Resposta inválida do Google: {e}"))?;
    if let Some(err) = &t.error {
        if err == "invalid_grant" {
            return Err(REVOKED.into());
        }
        return Err(format!("Google recusou o login: {}", t.error_description.as_deref().unwrap_or(err)));
    }
    Ok(t)
}

/// Login pelo navegador. `open` abre a URL; `cancelled` é consultado durante a espera.
/// Devolve o refresh token.
pub fn authorize(
    client: &OAuthClient,
    open: impl Fn(&str) -> Result<(), String>,
    cancelled: impl Fn() -> bool,
    pasted: impl Fn() -> Option<String>,
) -> Result<String, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| format!("Não foi possível abrir a porta local: {e}"))?;
    let redirect = format!("http://127.0.0.1:{}", listener.local_addr().map_err(|e| e.to_string())?.port());
    let verifier = random_token(48);
    let challenge = B64URL.encode(Sha256::digest(verifier.as_bytes()));
    let state = random_token(16);
    let url = format!(
        "{AUTH_URL}?client_id={}&redirect_uri={}&response_type=code&scope={}&code_challenge={challenge}&code_challenge_method=S256&state={state}&access_type=offline&prompt=consent",
        enc(&client.id),
        enc(&redirect),
        enc(SCOPE)
    );
    open(&url)?;

    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let deadline = Instant::now() + Duration::from_secs(300);
    let (code, returned_state) = loop {
        if Instant::now() > deadline {
            return Err("O login não foi concluído a tempo. Tente de novo.".into());
        }
        if cancelled() {
            return Err(LOGIN_CANCELLED.into());
        }
        // Alternativa para quando o navegador não consegue falar com o app (no Android o sistema
        // pausa o app enquanto o navegador está na frente): o usuário cola o endereço da página de erro.
        if let Some(text) = pasted() {
            let query = text.trim().split_once('?').map(|(_, q)| q).unwrap_or(text.trim());
            let params: BTreeMap<String, String> =
                query.split('&').filter_map(|kv| kv.split_once('=')).map(|(k, v)| (dec(k), dec(v))).collect();
            match params.get("code") {
                Some(code) => break (code.clone(), params.get("state").cloned().unwrap_or_default()),
                None => return Err("O endereço colado não tem o código de login. Copie a barra de endereço inteira.".into()),
            }
        }
        let mut stream = match listener.accept() {
            Ok((s, _)) => s,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(150));
                continue;
            }
            Err(e) => return Err(e.to_string()),
        };
        let _ = stream.set_nonblocking(false);
        let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
        let mut line = String::new();
        let _ = BufReader::new(&mut stream).read_line(&mut line);
        let query = line.split_whitespace().nth(1).and_then(|p| p.split_once('?')).map(|(_, q)| q.to_string());
        let Some(query) = query else {
            let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
            continue;
        };
        let params: BTreeMap<String, String> =
            query.split('&').filter_map(|kv| kv.split_once('=')).map(|(k, v)| (dec(k), dec(v))).collect();
        let ok = params.contains_key("code");
        let page = if ok {
            "<h2>Vault conectado ao Google Drive.</h2><p>Pode fechar esta aba e voltar ao Vault.</p>"
        } else {
            "<h2>Login cancelado.</h2><p>Pode fechar esta aba.</p>"
        };
        let body = format!("<!doctype html><meta charset=utf-8><title>Vault</title><body style=\"font-family:sans-serif;padding:40px\">{page}</body>");
        let _ = stream.write_all(
            format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len())
                .as_bytes(),
        );
        if !ok {
            return Err("Login cancelado no navegador.".into());
        }
        break (params["code"].clone(), params.get("state").cloned().unwrap_or_default());
    };
    if returned_state != state {
        return Err("Resposta de login inválida (state). Tente de novo.".into());
    }
    let t = token_request(&[
        ("code", &code),
        ("client_id", &client.id),
        ("client_secret", &client.secret),
        ("redirect_uri", &redirect),
        ("grant_type", "authorization_code"),
        ("code_verifier", &verifier),
    ])?;
    t.refresh_token.ok_or_else(|| "O Google não devolveu acesso permanente. Tente de novo.".into())
}

/// Desfaz o acesso no Google (o refresh token deixa de funcionar).
pub fn revoke(token: &str) {
    let _ = agent().post(REVOKE_URL).send_form(&[("token", token)]);
}

pub struct Drive {
    client: OAuthClient,
    refresh: String,
    access: Option<(String, Instant)>,
    agent: ureq::Agent,
}

#[derive(Deserialize)]
struct FileList {
    #[serde(default)]
    files: Vec<RemoteFile>,
}

#[derive(Deserialize)]
pub struct RemoteFile {
    pub id: String,
    /// Pastas onde o arquivo está (vazio/ausente = raiz do Drive).
    #[serde(default)]
    pub parents: Vec<String>,
}

impl Drive {
    pub fn new(client: OAuthClient, refresh: String) -> Self {
        Self { client, refresh, access: None, agent: agent() }
    }

    fn token(&mut self) -> Result<String, String> {
        if let Some((t, until)) = &self.access {
            if Instant::now() < *until {
                return Ok(t.clone());
            }
        }
        let t = token_request(&[
            ("client_id", &self.client.id),
            ("client_secret", &self.client.secret),
            ("refresh_token", &self.refresh),
            ("grant_type", "refresh_token"),
        ])?;
        let access = t.access_token.ok_or("O Google não devolveu um token de acesso.")?;
        let ttl = t.expires_in.unwrap_or(3600).saturating_sub(120);
        self.access = Some((access.clone(), Instant::now() + Duration::from_secs(ttl)));
        Ok(access)
    }

    /// Executa a chamada; se o token expirou (401), renova e tenta de novo uma vez.
    fn call(&mut self, f: impl Fn(&ureq::Agent, &str) -> Result<ureq::Response, ureq::Error>) -> Result<ureq::Response, String> {
        for attempt in 0..2 {
            let bearer = format!("Bearer {}", self.token()?);
            let agent = self.agent.clone();
            match retry_net(|| f(&agent, &bearer)) {
                Ok(r) => return Ok(r),
                Err(ureq::Error::Status(401, _)) if attempt == 0 => self.access = None,
                Err(ureq::Error::Status(code, r)) => {
                    let detail = r.into_string().unwrap_or_default();
                    let msg = serde_json::from_str::<serde_json::Value>(&detail)
                        .ok()
                        .and_then(|v| v["error"]["message"].as_str().map(String::from))
                        .unwrap_or(detail);
                    return Err(format!("Google Drive respondeu {code}: {msg}"));
                }
                Err(e) => return Err(format!("Sem conexão com o Google Drive: {e}")),
            }
        }
        Err(REVOKED.into())
    }

    pub fn user_email(&mut self) -> Result<String, String> {
        let r = self.call(|a, auth| a.get(&format!("{API}/about?fields=user(emailAddress)")).set("Authorization", auth).call())?;
        let v: serde_json::Value = r.into_json().map_err(|e| e.to_string())?;
        Ok(v["user"]["emailAddress"].as_str().unwrap_or_default().to_string())
    }

    /// Procura o arquivo do cofre criado por este app. Se por algum motivo houver mais de um,
    /// usa o primeiro (o mais antigo na ordem do Drive) — nunca apaga nada.
    pub fn find_vault(&mut self) -> Result<Option<RemoteFile>, String> {
        let q = format!("appProperties has {{ key='{PROP_KEY}' and value='{PROP_VALUE}' }} and name='{FILE_NAME}' and trashed=false");
        let url = format!(
            "{API}/files?q={}&fields={}&orderBy=createdTime&pageSize=10&spaces=drive",
            enc(&q),
            enc("files(id,parents)")
        );
        let r = self.call(|a, auth| a.get(&url).set("Authorization", auth).call())?;
        let list: FileList = r.into_json().map_err(|e| e.to_string())?;
        Ok(list.files.into_iter().next())
    }

    /// Id da pasta "Vault" criada pelo app; cria se ainda não existir.
    pub fn ensure_folder(&mut self) -> Result<String, String> {
        let q = format!("appProperties has {{ key='{PROP_KEY}' and value='{FOLDER_PROP_VALUE}' }} and mimeType='{FOLDER_MIME}' and trashed=false");
        let url = format!(
            "{API}/files?q={}&fields={}&orderBy=createdTime&pageSize=10&spaces=drive",
            enc(&q),
            enc("files(id)")
        );
        let r = self.call(|a, auth| a.get(&url).set("Authorization", auth).call())?;
        let list: FileList = r.into_json().map_err(|e| e.to_string())?;
        if let Some(f) = list.files.into_iter().next() {
            return Ok(f.id);
        }
        let mut props = BTreeMap::new();
        props.insert(PROP_KEY, FOLDER_PROP_VALUE);
        let meta = serde_json::json!({ "name": FOLDER_NAME, "mimeType": FOLDER_MIME, "appProperties": props });
        let url = format!("{API}/files?fields=id");
        let r = self.call(|a, auth| a.post(&url).set("Authorization", auth).send_json(meta.clone()))?;
        let f: RemoteFile = r.into_json().map_err(|e| e.to_string())?;
        Ok(f.id)
    }

    pub fn download(&mut self, id: &str) -> Result<Vec<u8>, String> {
        let url = format!("{API}/files/{}?alt=media", enc(id));
        let r = self.call(|a, auth| a.get(&url).set("Authorization", auth).call())?;
        let mut data = Vec::new();
        r.into_reader().take(MAX_DOWNLOAD).read_to_end(&mut data).map_err(|e| e.to_string())?;
        Ok(data)
    }

    fn multipart(meta: &serde_json::Value, data: &[u8]) -> (String, Vec<u8>) {
        let boundary = format!("vault{}", random_token(12).replace(['-', '_'], "x"));
        let mut body = Vec::with_capacity(data.len() + 512);
        body.extend_from_slice(format!("--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{meta}\r\n").as_bytes());
        body.extend_from_slice(format!("--{boundary}\r\nContent-Type: application/octet-stream\r\n\r\n").as_bytes());
        body.extend_from_slice(data);
        body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
        (format!("multipart/related; boundary={boundary}"), body)
    }

    pub fn create(&mut self, folder: &str, data: &[u8]) -> Result<String, String> {
        let mut props = BTreeMap::new();
        props.insert(PROP_KEY, PROP_VALUE);
        let meta = serde_json::json!({ "name": FILE_NAME, "appProperties": props, "parents": [folder] });
        let (ctype, body) = Self::multipart(&meta, data);
        let url = format!("{UPLOAD}/files?uploadType=multipart&fields=id");
        let r = self.call(|a, auth| a.post(&url).set("Authorization", auth).set("Content-Type", &ctype).send_bytes(&body))?;
        let f: RemoteFile = r.into_json().map_err(|e| e.to_string())?;
        Ok(f.id)
    }

    /// Atualiza o conteúdo. Se o arquivo ainda está fora da pasta "Vault" (versões antigas o
    /// criavam na raiz), move para dentro dela na mesma chamada.
    pub fn update(&mut self, file: &RemoteFile, folder: &str, data: &[u8]) -> Result<(), String> {
        let (ctype, body) = Self::multipart(&serde_json::json!({}), data);
        let mut url = format!("{UPLOAD}/files/{}?uploadType=multipart&fields=id", enc(&file.id));
        if !file.parents.iter().any(|p| p == folder) {
            url.push_str(&format!("&addParents={}", enc(folder)));
            if !file.parents.is_empty() {
                url.push_str(&format!("&removeParents={}", enc(&file.parents.join(","))));
            }
        }
        self.call(|a, auth| a.request("PATCH", &url).set("Authorization", auth).set("Content-Type", &ctype).send_bytes(&body))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codificacao_de_url() {
        assert_eq!(enc("a b/ç?=&"), "a%20b%2F%C3%A7%3F%3D%26");
        assert_eq!(dec("a%20b%2F%C3%A7+x"), "a b/ç x");
        assert_eq!(dec("4%2F0A%"), "4/0A%");
    }
}
