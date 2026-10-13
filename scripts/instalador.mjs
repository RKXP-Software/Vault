// Instalador do Windows (NSIS): compila o app em modo release e copia o .exe para distribuicao/v<versão>/.
// Uso: npm run instalador
// Requisito: src-tauri/google.secret.json (as credenciais do Google ficam embutidas no programa).

import { execSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const version = JSON.parse(readFileSync('package.json', 'utf8')).version

if (!existsSync(join('src-tauri', 'google.secret.json'))) {
  console.error('Falta src-tauri/google.secret.json: sem ele o instalador sai sem o login do Google Drive.')
  process.exit(1)
}

execSync('npx tauri build', { stdio: 'inherit' })

const built = join('src-tauri', 'target', 'release', 'bundle', 'nsis', `Vault_${version}_x64-setup.exe`)
if (!existsSync(built)) {
  console.error(`Instalador não encontrado em ${built}`)
  process.exit(1)
}
const dest = join('distribuicao', `v${version}`)
mkdirSync(dest, { recursive: true })
const out = join(dest, `Vault-${version}-Windows-Instalador.exe`)
copyFileSync(built, out)
console.log(`\nInstalador pronto: ${out}`)
