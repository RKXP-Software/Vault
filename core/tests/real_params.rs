use vault_core::{EntryInput, Vault};

#[test]
fn roundtrip_with_default_kdf_and_file_like_flow() {
    let mut nv = Vault::create("frase longa de teste 123").unwrap();
    let mut d = EntryInput::default();
    d.title = "Google Drive".into();
    d.password = "senha-falsa-1".into();
    let id = nv.vault.add(d);
    // Simula o app: grava no create, depois salva de novo após editar.
    let first = nv.vault.save();
    let second = nv.vault.save();
    for bytes in [&first, &second] {
        let v = Vault::open(bytes, "frase longa de teste 123", &nv.secret_key).unwrap();
        assert!(v.get(id).is_some());
        // Chave secreta como o usuário digitaria: minúscula e com espaços.
        let sloppy = format!(" {} ", nv.secret_key.to_lowercase());
        Vault::open(bytes, "frase longa de teste 123", &sloppy).unwrap();
    }
}
