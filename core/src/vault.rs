use crate::crypto::{self, KdfParams, KEY_LEN, NONCE_LEN, SALT_LEN, WRAPPED_LEN};
use crate::entry::{Entry, EntryInput};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};
use thiserror::Error;
use uuid::Uuid;
use zeroize::Zeroizing;

const MAGIC: &[u8; 4] = b"PVLT";
const VERSION: u8 = 2;
const SECRET_LEN: usize = 16;
const RECOVERY_LEN: usize = 32;

// Layout do arquivo:
//   magic(4) versão(1) m_kib(4) t(4) p(4) | salt(16)          -> PREFIX; os 17 primeiros bytes são o AAD dos slots
//   (o sal fica fora do AAD dos slots para poder trocar a senha sem mexer no slot de recuperação)
//   slot_senha(72) slot_recuperação(72)
//   nonce_corpo(24)                                            -> HEADER termina aqui (AAD do corpo)
//   corpo cifrado com a chave de dados
const SLOT_AAD_LEN: usize = 4 + 1 + 12;
const PREFIX_LEN: usize = SLOT_AAD_LEN + SALT_LEN;
const SLOT_PW: usize = PREFIX_LEN;
const SLOT_REC: usize = SLOT_PW + WRAPPED_LEN;
const NONCE_AT: usize = SLOT_REC + WRAPPED_LEN;
const HEADER_LEN: usize = NONCE_AT + NONCE_LEN;

#[derive(Debug, Error)]
pub enum VaultError {
    #[error("arquivo de cofre inválido")]
    InvalidFormat,
    #[error("senha mestra, chave secreta ou chave de recuperação incorretas, ou arquivo corrompido")]
    Decrypt,
    #[error("chave em formato inválido")]
    BadKey,
    #[error("falha ao derivar a chave")]
    Kdf,
    #[error("registro não encontrado")]
    NotFound,
}

#[derive(Serialize, Deserialize, Default)]
struct Body {
    /// Aumenta a cada gravação; permite detectar um arquivo que "voltou no tempo".
    revision: u64,
    /// Aumenta a cada troca de senha/chave. No merge, vence o cabeçalho (slots) da versão maior,
    /// para uma troca de senha feita num aparelho não ser desfeita por outro.
    #[serde(default)]
    slots_version: u64,
    entries: HashMap<Uuid, Entry>,
}

/// Resultado de `Vault::create`: as chaves aparecem uma única vez e devem ser anotadas.
/// Resultado de `Vault::merge_remote`.
pub struct MergeOutcome {
    /// A senha mestra/chave secreta mudou em outro aparelho: o cofre precisa ser reaberto com as novas.
    pub credentials_changed: bool,
}

pub struct NewVault {
    pub vault: Vault,
    /// Chave secreta (necessária junto com a senha em cada novo dispositivo).
    pub secret_key: String,
    /// Chave de recuperação (abre o cofre sem a senha mestra).
    pub recovery_key: String,
}

pub struct Vault {
    body: Body,
    data_key: Zeroizing<[u8; KEY_LEN]>,
    salt: [u8; SALT_LEN],
    kdf: KdfParams,
    /// Conhecida só se o cofre foi aberto com senha + chave secreta.
    secret: Option<Zeroizing<[u8; SECRET_LEN]>>,
    pw_slot: [u8; WRAPPED_LEN],
    rec_slot: [u8; WRAPPED_LEN],
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn prefix(kdf: KdfParams, salt: &[u8; SALT_LEN]) -> Vec<u8> {
    let mut p = Vec::with_capacity(PREFIX_LEN);
    p.extend_from_slice(MAGIC);
    p.push(VERSION);
    for v in [kdf.m_kib, kdf.t, kdf.p] {
        p.extend_from_slice(&v.to_le_bytes());
    }
    p.extend_from_slice(salt);
    p
}

impl Vault {
    pub fn create(master_password: &str) -> Result<NewVault, VaultError> {
        Self::create_with(master_password, KdfParams::DEFAULT)
    }

    pub(crate) fn create_with(master_password: &str, kdf: KdfParams) -> Result<NewVault, VaultError> {
        let salt = crypto::random::<SALT_LEN>();
        let secret = Zeroizing::new(crypto::random::<SECRET_LEN>());
        let recovery = Zeroizing::new(crypto::random::<RECOVERY_LEN>());
        let data_key = Zeroizing::new(crypto::random::<KEY_LEN>());
        let pre = prefix(kdf, &salt);
        let kek = crypto::derive_key(master_password.as_bytes(), &*secret, &salt, kdf).map_err(|_| VaultError::Kdf)?;
        let vault = Vault {
            body: Body::default(),
            pw_slot: crypto::wrap(&kek, &pre[..SLOT_AAD_LEN], &data_key),
            rec_slot: crypto::wrap(&recovery, &pre[..SLOT_AAD_LEN], &data_key),
            data_key,
            salt,
            kdf,
            secret: Some(secret.clone()),
        };
        Ok(NewVault {
            vault,
            secret_key: crypto::encode_key(&*secret),
            recovery_key: crypto::encode_key(&*recovery),
        })
    }

    fn parse_header(bytes: &[u8]) -> Result<(KdfParams, [u8; SALT_LEN]), VaultError> {
        if bytes.len() < HEADER_LEN + 16 || &bytes[..4] != MAGIC || bytes[4] != VERSION {
            return Err(VaultError::InvalidFormat);
        }
        let u32_at = |o: usize| u32::from_le_bytes(bytes[o..o + 4].try_into().unwrap());
        let kdf = KdfParams { m_kib: u32_at(5), t: u32_at(9), p: u32_at(13) };
        // Evita DoS por cabeçalho adulterado com custo absurdo.
        if kdf.m_kib > 1024 * 1024 || kdf.t > 20 || kdf.p > 16 {
            return Err(VaultError::InvalidFormat);
        }
        Ok((kdf, bytes[17..17 + SALT_LEN].try_into().unwrap()))
    }

    fn finish_open(
        bytes: &[u8],
        data_key: Zeroizing<[u8; KEY_LEN]>,
        kdf: KdfParams,
        salt: [u8; SALT_LEN],
        secret: Option<Zeroizing<[u8; SECRET_LEN]>>,
    ) -> Result<Self, VaultError> {
        let plain = crypto::decrypt(&data_key, &bytes[NONCE_AT..HEADER_LEN], &bytes[..HEADER_LEN], &bytes[HEADER_LEN..])
            .map_err(|_| VaultError::Decrypt)?;
        let body: Body = serde_json::from_slice(&plain).map_err(|_| VaultError::InvalidFormat)?;
        Ok(Self {
            body,
            data_key,
            salt,
            kdf,
            secret,
            pw_slot: bytes[SLOT_PW..SLOT_REC].try_into().unwrap(),
            rec_slot: bytes[SLOT_REC..NONCE_AT].try_into().unwrap(),
        })
    }

    /// Abre com senha mestra + chave secreta.
    pub fn open(bytes: &[u8], master_password: &str, secret_key: &str) -> Result<Self, VaultError> {
        let (kdf, salt) = Self::parse_header(bytes)?;
        let secret_v = crypto::decode_key(secret_key, SECRET_LEN).ok_or(VaultError::BadKey)?;
        let mut secret = Zeroizing::new([0u8; SECRET_LEN]);
        secret.copy_from_slice(&secret_v);
        let kek = crypto::derive_key(master_password.as_bytes(), &*secret, &salt, kdf).map_err(|_| VaultError::Kdf)?;
        let data_key = crypto::unwrap(&kek, &bytes[..SLOT_AAD_LEN], &bytes[SLOT_PW..SLOT_REC]).map_err(|_| VaultError::Decrypt)?;
        Self::finish_open(bytes, data_key, kdf, salt, Some(secret))
    }

    /// Abre só com a chave de recuperação (senha esquecida).
    pub fn open_with_recovery(bytes: &[u8], recovery_key: &str) -> Result<Self, VaultError> {
        let (kdf, salt) = Self::parse_header(bytes)?;
        let rec = crypto::decode_key(recovery_key, RECOVERY_LEN).ok_or(VaultError::BadKey)?;
        let mut kek = Zeroizing::new([0u8; KEY_LEN]);
        kek.copy_from_slice(&rec);
        let data_key = crypto::unwrap(&kek, &bytes[..SLOT_AAD_LEN], &bytes[SLOT_REC..NONCE_AT]).map_err(|_| VaultError::Decrypt)?;
        Self::finish_open(bytes, data_key, kdf, salt, None)
    }

    /// Chave de dados em memória. Serve para o desbloqueio por biometria: o app a guarda cifrada
    /// por uma chave do hardware (Android Keystore) que só é liberada pela biometria.
    pub fn unlock_key(&self) -> Zeroizing<[u8; KEY_LEN]> {
        self.data_key.clone()
    }

    /// Abre com a chave de dados (desbloqueio por biometria). Não conhece a chave secreta.
    pub fn open_with_unlock_key(bytes: &[u8], key: &[u8; KEY_LEN]) -> Result<Self, VaultError> {
        let (kdf, salt) = Self::parse_header(bytes)?;
        Self::finish_open(bytes, Zeroizing::new(*key), kdf, salt, None)
    }

    /// Chave secreta no formato de anotar (XXXXX-XXXXX-…), se este cofre foi aberto com ela.
    /// Usada para parear outro aparelho por QR code.
    pub fn secret_key_string(&self) -> Option<String> {
        self.secret.as_ref().map(|s| crypto::encode_key(&s[..]))
    }

    /// Informa a chave secreta a um cofre aberto sem ela (biometria), para poder trocar a senha
    /// sem gerar uma chave secreta nova. O chamador deve ter verificado a senha e a chave antes.
    pub fn set_secret_key(&mut self, secret_key: &str) -> Result<(), VaultError> {
        let v = crypto::decode_key(secret_key, SECRET_LEN).ok_or(VaultError::BadKey)?;
        let mut s = Zeroizing::new([0u8; SECRET_LEN]);
        s.copy_from_slice(&v);
        self.secret = Some(s);
        Ok(())
    }

    /// Troca a senha mestra sem recifrar o corpo. Se a chave secreta não é conhecida
    /// (abertura por recuperação), gera uma nova e a devolve.
    pub fn change_password(&mut self, new_password: &str) -> Result<Option<String>, VaultError> {
        let (secret, fresh) = match &self.secret {
            Some(s) => (s.clone(), None),
            None => {
                let s = Zeroizing::new(crypto::random::<SECRET_LEN>());
                let enc = crypto::encode_key(&*s);
                (s, Some(enc))
            }
        };
        let salt = crypto::random::<SALT_LEN>();
        let kek = crypto::derive_key(new_password.as_bytes(), &*secret, &salt, self.kdf).map_err(|_| VaultError::Kdf)?;
        let pre = prefix(self.kdf, &salt);
        self.pw_slot = crypto::wrap(&kek, &pre[..SLOT_AAD_LEN], &self.data_key);
        self.salt = salt;
        self.secret = Some(secret);
        self.body.slots_version += 1;
        Ok(fresh)
    }

    /// Revisão gravada no último `save`. Compare com a última vista para detectar rollback.
    pub fn revision(&self) -> u64 {
        self.body.revision
    }

    /// Serializa e cifra. Usa um nonce novo a cada gravação e incrementa a revisão.
    pub fn save(&mut self) -> Vec<u8> {
        self.body.revision += 1;
        let nonce = crypto::random::<NONCE_LEN>();
        let mut out = prefix(self.kdf, &self.salt);
        out.extend_from_slice(&self.pw_slot);
        out.extend_from_slice(&self.rec_slot);
        out.extend_from_slice(&nonce);
        let plain = Zeroizing::new(serde_json::to_vec(&self.body).expect("serialize"));
        let ct = crypto::encrypt(&self.data_key, &nonce, &out, &plain);
        out.extend_from_slice(&ct);
        out
    }

    pub fn add(&mut self, data: EntryInput) -> Uuid {
        let id = Uuid::new_v4();
        let t = now();
        self.body.entries.insert(id, Entry { id, data, created_at: t, updated_at: t, deleted: false });
        id
    }

    pub fn update(&mut self, id: Uuid, data: EntryInput) -> Result<(), VaultError> {
        let e = self.body.entries.get_mut(&id).filter(|e| !e.deleted).ok_or(VaultError::NotFound)?;
        e.data = data;
        e.updated_at = now();
        Ok(())
    }

    pub fn delete(&mut self, id: Uuid) -> Result<(), VaultError> {
        let e = self.body.entries.get_mut(&id).filter(|e| !e.deleted).ok_or(VaultError::NotFound)?;
        e.data = EntryInput::default();
        e.deleted = true;
        e.updated_at = now();
        Ok(())
    }

    pub fn get(&self, id: Uuid) -> Option<&Entry> {
        self.body.entries.get(&id).filter(|e| !e.deleted)
    }

    pub fn list(&self) -> Vec<&Entry> {
        let mut v: Vec<_> = self.body.entries.values().filter(|e| !e.deleted).collect();
        v.sort_by(|a, b| a.data.title.to_lowercase().cmp(&b.data.title.to_lowercase()));
        v
    }

    /// Busca por título, URL, e-mail ou usuário (nunca na senha/observações).
    pub fn search(&self, q: &str) -> Vec<&Entry> {
        let q = q.to_lowercase();
        self.list()
            .into_iter()
            .filter(|e| {
                [&e.data.title, &e.data.url, &e.data.email, &e.data.username]
                    .iter()
                    .any(|f| f.to_lowercase().contains(&q))
            })
            .collect()
    }

    /// Une com outra versão do cofre (mesma chave de dados): o item mais recente vence.
    pub fn merge(&mut self, other: &Vault) {
        self.merge_body(&other.body);
    }

    fn merge_body(&mut self, other: &Body) {
        for (id, theirs) in &other.entries {
            match self.body.entries.get(id) {
                Some(mine) if mine.updated_at >= theirs.updated_at => {}
                _ => {
                    self.body.entries.insert(*id, theirs.clone());
                }
            }
        }
        self.body.revision = self.body.revision.max(other.revision);
    }

    /// Junta os bytes de um arquivo de cofre vindo da nuvem usando a chave de dados já em memória.
    /// Falha com `Decrypt` se for outro cofre (outra chave de dados) ou se estiver adulterado.
    pub fn merge_remote(&mut self, bytes: &[u8]) -> Result<MergeOutcome, VaultError> {
        let (kdf, salt) = Self::parse_header(bytes)?;
        let plain = crypto::decrypt(&self.data_key, &bytes[NONCE_AT..HEADER_LEN], &bytes[..HEADER_LEN], &bytes[HEADER_LEN..])
            .map_err(|_| VaultError::Decrypt)?;
        let remote: Body = serde_json::from_slice(&plain).map_err(|_| VaultError::InvalidFormat)?;
        self.merge_body(&remote);
        let mut credentials_changed = false;
        if remote.slots_version > self.body.slots_version {
            self.pw_slot = bytes[SLOT_PW..SLOT_REC].try_into().unwrap();
            self.rec_slot = bytes[SLOT_REC..NONCE_AT].try_into().unwrap();
            self.salt = salt;
            self.kdf = kdf;
            self.secret = None;
            self.body.slots_version = remote.slots_version;
            credentials_changed = true;
        }
        Ok(MergeOutcome { credentials_changed })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FAST: KdfParams = KdfParams { m_kib: 8, t: 1, p: 1 };

    fn entry(title: &str, email: &str, user: &str, pass: &str, notes: &str) -> EntryInput {
        let mut d = EntryInput::default();
        d.title = title.into();
        d.email = email.into();
        d.username = user.into();
        d.password = pass.into();
        d.notes = notes.into();
        d
    }

    fn new_vault() -> NewVault {
        Vault::create_with("mestra", FAST).unwrap()
    }

    #[test]
    fn roundtrip_keeps_all_fields() {
        let mut n = new_vault();
        let id = n.vault.add(entry("GitHub", "eu@exemplo.com", "pedro", "s3nh@", "2FA no app"));
        let bytes = n.vault.save();
        let v2 = Vault::open(&bytes, "mestra", &n.secret_key).unwrap();
        let e = v2.get(id).unwrap();
        assert_eq!(e.data.email, "eu@exemplo.com");
        assert_eq!(e.data.username, "pedro");
        assert_eq!(e.data.password, "s3nh@");
        assert_eq!(e.data.notes, "2FA no app");
    }

    #[test]
    fn entry_with_empty_username() {
        let mut n = new_vault();
        let id = n.vault.add(entry("Google Drive", "abc@123.com", "", "senha-falsa-1", "teste 123"));
        let bytes = n.vault.save();
        let v2 = Vault::open(&bytes, "mestra", &n.secret_key).unwrap();
        let e = v2.get(id).unwrap();
        assert_eq!(e.data.title, "Google Drive");
        assert_eq!(e.data.username, "");
        assert_eq!(e.data.notes, "teste 123");
    }

    #[test]
    fn needs_password_and_secret_key() {
        let mut n = new_vault();
        let bytes = n.vault.save();
        assert!(matches!(Vault::open(&bytes, "errada", &n.secret_key), Err(VaultError::Decrypt)));
        let other = crypto::encode_key(&crypto::random::<SECRET_LEN>());
        assert!(matches!(Vault::open(&bytes, "mestra", &other), Err(VaultError::Decrypt)));
        assert!(matches!(Vault::open(&bytes, "mestra", "lixo"), Err(VaultError::BadKey)));
    }

    #[test]
    fn tamper_anywhere_fails() {
        let mut n = new_vault();
        n.vault.add(entry("x", "", "", "p", ""));
        let bytes = n.vault.save();
        for i in [6, 20, 30, SLOT_PW + 30, SLOT_REC + 30, NONCE_AT + 1, bytes.len() - 1] {
            let mut b = bytes.clone();
            b[i] ^= 1;
            assert!(Vault::open(&b, "mestra", &n.secret_key).is_err(), "byte {i}");
        }
    }

    #[test]
    fn file_has_no_plaintext() {
        let mut n = new_vault();
        n.vault.add(entry("GitHub", "", "", "s3nh@", ""));
        let s = String::from_utf8_lossy(&n.vault.save()).to_string();
        assert!(!s.contains("GitHub") && !s.contains("s3nh@"));
    }

    #[test]
    fn recovery_key_opens_without_password() {
        let mut n = new_vault();
        let id = n.vault.add(entry("A", "", "", "p", ""));
        let bytes = n.vault.save();
        let v = Vault::open_with_recovery(&bytes, &n.recovery_key).unwrap();
        assert!(v.get(id).is_some());
    }

    #[test]
    fn change_password_via_recovery_issues_new_secret() {
        let mut n = new_vault();
        let id = n.vault.add(entry("A", "", "", "p", ""));
        let bytes = n.vault.save();
        let mut v = Vault::open_with_recovery(&bytes, &n.recovery_key).unwrap();
        let new_secret = v.change_password("nova").unwrap().expect("nova chave secreta");
        let bytes2 = v.save();
        let v2 = Vault::open(&bytes2, "nova", &new_secret).unwrap();
        assert!(v2.get(id).is_some());
        assert!(Vault::open(&bytes2, "mestra", &n.secret_key).is_err());
    }

    #[test]
    fn revision_increases_and_update_delete_search() {
        let mut n = new_vault();
        let v = &mut n.vault;
        let id = v.add(entry("GitHub", "", "pedro", "s3nh@", ""));
        assert_eq!(v.search("PEDRO").len(), 1);
        assert_eq!(v.search("s3nh@").len(), 0);
        v.update(id, entry("GitLab", "", "pedro", "x", "")).unwrap();
        assert_eq!(v.get(id).unwrap().data.title, "GitLab");
        v.delete(id).unwrap();
        assert!(v.get(id).is_none() && v.list().is_empty());
        v.save();
        let r1 = v.revision();
        v.save();
        assert_eq!(v.revision(), r1 + 1);
    }

    #[test]
    fn merge_latest_wins_and_adds_new() {
        let mut a = new_vault();
        let id = a.vault.add(entry("A", "", "", "velha", ""));
        let bytes = a.vault.save();
        let mut b = Vault::open(&bytes, "mestra", &a.secret_key).unwrap();
        let new_id = b.add(entry("Novo", "", "", "", ""));
        b.body.entries.get_mut(&id).unwrap().data.password = "nova".into();
        b.body.entries.get_mut(&id).unwrap().updated_at += 10;
        a.vault.merge(&b);
        assert_eq!(a.vault.get(id).unwrap().data.password, "nova");
        assert!(a.vault.get(new_id).is_some());
    }

    #[test]
    fn key_encoding_roundtrip() {
        let k = crypto::random::<RECOVERY_LEN>();
        let s = crypto::encode_key(&k);
        assert_eq!(&**crypto::decode_key(&s.to_lowercase(), RECOVERY_LEN).unwrap(), &k[..]);
    }

    #[test]
    fn merge_remote_combines_entries_between_devices() {
        let mut a = new_vault();
        let id_a = a.vault.add(entry("A", "", "", "1", ""));
        let base = a.vault.save();
        // Aparelho B abre o mesmo arquivo e cria um item; A cria outro depois.
        let mut b = Vault::open(&base, "mestra", &a.secret_key).unwrap();
        let id_b = b.add(entry("B", "", "", "2", ""));
        let from_b = b.save();
        let id_a2 = a.vault.add(entry("A2", "", "", "3", ""));
        let out = a.vault.merge_remote(&from_b).unwrap();
        assert!(!out.credentials_changed);
        assert!(a.vault.get(id_a).is_some() && a.vault.get(id_b).is_some() && a.vault.get(id_a2).is_some());
    }

    #[test]
    fn merge_remote_rejects_other_vault() {
        let mut a = new_vault();
        let mut other = Vault::create_with("outra", FAST).unwrap();
        let bytes = other.vault.save();
        assert!(matches!(a.vault.merge_remote(&bytes), Err(VaultError::Decrypt)));
    }

    #[test]
    fn password_change_on_one_device_is_not_undone_by_the_other() {
        let mut a = new_vault();
        a.vault.add(entry("X", "", "", "p", ""));
        let base = a.vault.save();
        let mut b = Vault::open(&base, "mestra", &a.secret_key).unwrap();
        b.change_password("senha nova do B").unwrap();
        let from_b = b.save();
        // A ainda tem a senha antiga; ao juntar, adota os slots de B e avisa.
        let out = a.vault.merge_remote(&from_b).unwrap();
        assert!(out.credentials_changed);
        let merged = a.vault.save();
        assert!(Vault::open(&merged, "senha nova do B", &a.secret_key).is_ok());
        assert!(Vault::open(&merged, "mestra", &a.secret_key).is_err());
    }

    #[test]
    fn unlock_key_opens_without_password_and_keeps_secret_for_password_change() {
        let mut n = new_vault();
        let id = n.vault.add(entry("A", "", "", "p", ""));
        let bytes = n.vault.save();
        let key = n.vault.unlock_key();
        let mut v = Vault::open_with_unlock_key(&bytes, &key).unwrap();
        assert!(v.get(id).is_some());
        assert!(v.secret_key_string().is_none()); // aberto por biometria: não conhece a chave secreta
        assert_eq!(Vault::open(&bytes, "mestra", &n.secret_key).unwrap().secret_key_string().as_deref(), Some(n.secret_key.as_str()));
        // Sem a chave secreta, trocar a senha geraria uma nova; informando-a, ela é mantida.
        v.set_secret_key(&n.secret_key).unwrap();
        assert!(v.change_password("outra senha").unwrap().is_none());
        let bytes2 = v.save();
        assert!(Vault::open(&bytes2, "outra senha", &n.secret_key).is_ok());
        let wrong = [7u8; 32];
        assert!(Vault::open_with_unlock_key(&bytes, &wrong).is_err());
    }
}
