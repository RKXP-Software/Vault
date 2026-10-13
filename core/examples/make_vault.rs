//! Gera um cofre de teste (parâmetros reais do Argon2) para validar outras camadas, como o WebAssembly.
//! Uso: cargo run --example make_vault -- <arquivo.vault>
//! Imprime a senha e a chave secreta usadas (só dados de teste).

use vault_core::{EntryInput, Vault};

fn main() {
    let path = std::env::args().nth(1).expect("informe o caminho do arquivo de saída");
    let password = "frase de teste para o wasm 123";
    let mut nv = Vault::create(password).expect("criar cofre");

    let mut d = EntryInput::default();
    d.title = "Google Drive".into();
    d.url = "https://drive.google.com".into();
    d.email = "abc@123.com".into();
    d.password = "senha-falsa-1".into();
    d.notes = "teste 123".into();
    nv.vault.add(d);

    let mut d = EntryInput::default();
    d.title = "GitHub".into();
    d.url = "https://github.com/login".into();
    d.username = "pedro".into();
    d.password = "senha-falsa-2".into();
    nv.vault.add(d);

    std::fs::write(&path, nv.vault.save()).expect("gravar arquivo");
    println!("password={password}");
    println!("secret={}", nv.secret_key);
}
