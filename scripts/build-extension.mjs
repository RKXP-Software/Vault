// Monta a extensão do navegador em extension/ (pronta para "Carregar sem compactação"):
//  1. extension/config.js  ← credenciais OAuth de src-tauri/google.secret.json (não versionar);
//  2. extension/wasm/      ← núcleo do Vault compilado para WebAssembly;
//  3. extension/icons/     ← ícones PNG a partir de icons-src/icon.svg.
// Requisitos: rustup target add wasm32-unknown-unknown  e  cargo install wasm-bindgen-cli.

import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Resvg } from '@resvg/resvg-js'

const root = fileURLToPath(new URL('../', import.meta.url))
const run = (cmd) => execSync(cmd, { stdio: 'inherit', cwd: root })

// 1. Configuração do Google
const secretPath = root + 'src-tauri/google.secret.json'
if (!existsSync(secretPath)) {
  console.error('Falta src-tauri/google.secret.json (credenciais OAuth do Google Cloud).')
  process.exit(1)
}
const raw = JSON.parse(readFileSync(secretPath, 'utf8'))
const c = raw.installed ?? raw.web ?? raw
if (!c.client_id || !c.client_secret) {
  console.error('google.secret.json sem client_id/client_secret.')
  process.exit(1)
}
writeFileSync(
  root + 'extension/config.js',
  `// Gerado por scripts/build-extension.mjs a partir de google.secret.json. Não versionar.\nexport const GOOGLE = ${JSON.stringify({ clientId: c.client_id, clientSecret: c.client_secret })}\n`,
)
console.log('config.js gerado')

// 2. WebAssembly
run('cargo build --release --target wasm32-unknown-unknown --manifest-path core-wasm/Cargo.toml')
run('wasm-bindgen core-wasm/target/wasm32-unknown-unknown/release/vault_wasm.wasm --out-dir extension/wasm --target web --no-typescript')

// 3. Ícones
mkdirSync(root + 'extension/icons', { recursive: true })
const svg = readFileSync(root + 'icons-src/icon.svg')
for (const size of [16, 32, 48, 128]) {
  writeFileSync(`${root}extension/icons/${size}.png`, new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng())
}
console.log('ícones gerados\n\nExtensão pronta em: ' + root + 'extension')
