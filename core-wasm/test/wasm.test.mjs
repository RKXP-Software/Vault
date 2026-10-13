// Teste de ponta a ponta do WebAssembly: abre, no Node, um cofre criado pelo núcleo nativo.
// Uso: node core-wasm/test/wasm.test.mjs <cofre.vault> <senha> <chave-secreta>
// (gere o cofre com: cargo run --manifest-path core/Cargo.toml --example make_vault -- <cofre.vault>)

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const [, , vaultPath, password, secretKey] = process.argv
if (!vaultPath || !password || !secretKey) {
  console.error('uso: node wasm.test.mjs <cofre.vault> <senha> <chave-secreta>')
  process.exit(2)
}

const wasmDir = new URL('../../extension/wasm/', import.meta.url)
const { initSync, WasmVault } = await import(new URL('vault_wasm.js', wasmDir).href)
initSync({ module: readFileSync(fileURLToPath(new URL('vault_wasm_bg.wasm', wasmDir))) })

const bytes = new Uint8Array(readFileSync(vaultPath))

let t = performance.now()
const vault = WasmVault.open(bytes, password, secretKey)
console.log(`abriu com senha + chave secreta em ${Math.round(performance.now() - t)} ms`)

const list = JSON.parse(vault.listJson())
assert.equal(list.length, 2)
assert.ok(list.every((i) => !('password' in i) && !('notes' in i)), 'a lista não pode ter senha nem observações')
const drive = list.find((i) => i.title === 'Google Drive')
assert.ok(drive, 'registro "Google Drive" deve existir')
assert.equal(drive.email, 'abc@123.com')
assert.equal(drive.username, '', 'usuário vazio continua vazio')

const full = JSON.parse(vault.getJson(drive.id))
assert.equal(full.password, 'senha-falsa-1')
assert.equal(full.notes, 'teste 123')

// Sessão: a chave de dados abre o cofre sem Argon2.
const key = vault.unlockKey()
assert.equal(key.length, 32)
t = performance.now()
const again = WasmVault.openWithKey(bytes, key)
console.log(`abriu com a chave da sessão em ${Math.round(performance.now() - t)} ms`)
assert.equal(JSON.parse(again.listJson()).length, 2)

// Falhas esperadas.
assert.throws(() => WasmVault.open(bytes, 'senha errada', secretKey), /incorretas|corrompido/)
assert.throws(() => WasmVault.open(bytes, password, 'AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-A'), /incorretas|corrompido/) // 26 letras = tamanho válido, valor errado
assert.throws(() => WasmVault.open(bytes, password, 'lixo'), /formato inválido/)
assert.throws(() => WasmVault.openWithKey(bytes, new Uint8Array(32)), /incorretas|corrompido/)
const tampered = bytes.slice()
tampered[tampered.length - 1] ^= 1
assert.throws(() => WasmVault.open(tampered, password, secretKey))

console.log('revisão do arquivo:', vault.revision())
console.log('OK: o WebAssembly abre o cofre criado pelo núcleo nativo.')
