// Os comandos são chamados só pelo Rust do app (não pelo JavaScript), então não há permissões a declarar.
const COMMANDS: &[&str] = &[];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).android_path("android").build();
}
