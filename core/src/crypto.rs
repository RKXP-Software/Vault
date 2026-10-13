use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    XChaCha20Poly1305, XNonce,
};
use rand::{rngs::OsRng, RngCore};
use zeroize::Zeroizing;

pub const SALT_LEN: usize = 16;
pub const NONCE_LEN: usize = 24;
pub const KEY_LEN: usize = 32;
/// Chave de dados cifrada (32) + tag (16).
pub const WRAPPED_LEN: usize = NONCE_LEN + KEY_LEN + 16;

#[derive(Clone, Copy)]
pub struct KdfParams {
    pub m_kib: u32,
    pub t: u32,
    pub p: u32,
}

impl KdfParams {
    pub const DEFAULT: KdfParams = KdfParams { m_kib: 64 * 1024, t: 3, p: 4 };
}

/// Argon2id com a chave secreta como "pepper" (parâmetro `secret` do Argon2).
pub fn derive_key(password: &[u8], secret: &[u8], salt: &[u8], k: KdfParams) -> Result<Zeroizing<[u8; KEY_LEN]>, ()> {
    let params = Params::new(k.m_kib, k.t, k.p, Some(KEY_LEN)).map_err(|_| ())?;
    let mut key = Zeroizing::new([0u8; KEY_LEN]);
    Argon2::new_with_secret(secret, Algorithm::Argon2id, Version::V0x13, params)
        .map_err(|_| ())?
        .hash_password_into(password, salt, key.as_mut())
        .map_err(|_| ())?;
    Ok(key)
}

pub fn random<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    OsRng.fill_bytes(&mut b);
    b
}

pub fn encrypt(key: &[u8; KEY_LEN], nonce: &[u8; NONCE_LEN], aad: &[u8], plain: &[u8]) -> Vec<u8> {
    XChaCha20Poly1305::new(key.into())
        .encrypt(XNonce::from_slice(nonce), Payload { msg: plain, aad })
        .expect("encrypt")
}

pub fn decrypt(key: &[u8; KEY_LEN], nonce: &[u8], aad: &[u8], ct: &[u8]) -> Result<Zeroizing<Vec<u8>>, ()> {
    XChaCha20Poly1305::new(key.into())
        .decrypt(XNonce::from_slice(nonce), Payload { msg: ct, aad })
        .map(Zeroizing::new)
        .map_err(|_| ())
}

/// Cifra a chave de dados com uma chave-mestra de slot: `nonce || ciphertext`.
pub fn wrap(kek: &[u8; KEY_LEN], aad: &[u8], data_key: &[u8; KEY_LEN]) -> [u8; WRAPPED_LEN] {
    let nonce = random::<NONCE_LEN>();
    let ct = encrypt(kek, &nonce, aad, data_key);
    let mut out = [0u8; WRAPPED_LEN];
    out[..NONCE_LEN].copy_from_slice(&nonce);
    out[NONCE_LEN..].copy_from_slice(&ct);
    out
}

pub fn unwrap(kek: &[u8; KEY_LEN], aad: &[u8], slot: &[u8]) -> Result<Zeroizing<[u8; KEY_LEN]>, ()> {
    let plain = decrypt(kek, &slot[..NONCE_LEN], aad, &slot[NONCE_LEN..])?;
    let mut k = Zeroizing::new([0u8; KEY_LEN]);
    if plain.len() != KEY_LEN {
        return Err(());
    }
    k.copy_from_slice(&plain);
    Ok(k)
}

const ALPHABET: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/// Base32 (RFC 4648, sem padding) em grupos de 5 separados por '-', para anotar/ditar.
pub fn encode_key(bytes: &[u8]) -> String {
    let mut out = String::new();
    let (mut buf, mut bits) = (0u32, 0u32);
    for &b in bytes {
        buf = (buf << 8) | b as u32;
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(ALPHABET[((buf >> bits) & 31) as usize] as char);
        }
    }
    if bits > 0 {
        out.push(ALPHABET[((buf << (5 - bits)) & 31) as usize] as char);
    }
    out.as_bytes().chunks(5).map(|c| std::str::from_utf8(c).unwrap()).collect::<Vec<_>>().join("-")
}

pub fn decode_key(s: &str, expected_len: usize) -> Option<Zeroizing<Vec<u8>>> {
    let (mut buf, mut bits) = (0u32, 0u32);
    let mut out = Zeroizing::new(Vec::with_capacity(expected_len));
    for c in s.chars().filter(|c| !c.is_whitespace() && *c != '-') {
        let v = ALPHABET.iter().position(|&a| a as char == c.to_ascii_uppercase())? as u32;
        buf = (buf << 5) | v;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push(((buf >> bits) & 0xff) as u8);
        }
    }
    (out.len() == expected_len).then_some(out)
}
