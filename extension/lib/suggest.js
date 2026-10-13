// Responde aos pedidos do menu em linha (content.js). Roda no service worker.
//
// Regras de segurança:
//  - só aceita mensagens da própria extensão, vindas do frame principal de uma aba;
//  - o endereço usado para casar vem do NAVEGADOR (sender), nunca do que a página/conteúdo informa;
//  - só oferece registros cujo domínio registrável é o da página, e só em páginas seguras (https);
//  - a senha só sai com um pedido explícito (`credential`) por um registro que casa com a página.

import init, { WasmVault } from '../wasm/vault_wasm.js'
import { isSecurePage, matchesUrl } from './match.js'
import * as store from './store.js'

const ready = init()

/** Abre o cofre com a chave da sessão (instantâneo). Devolve null se estiver bloqueado. */
async function openVault() {
  await ready
  const key = await store.getSessionKey()
  const saved = await store.getVaultBytes()
  if (!key || !saved) return null
  try {
    return WasmVault.openWithKey(saved.bytes, key)
  } catch {
    await store.clearSession() // chave de sessão não abre mais o arquivo (senha trocada em outro aparelho)
    return null
  }
}

export async function handleRequest(msg, sender) {
  if (sender?.id !== chrome.runtime.id || !sender.tab || sender.frameId !== 0) return { state: 'none' }
  const url = sender.url || sender.tab.url
  if (!isSecurePage(url)) return { state: 'none' }

  const vault = await openVault()
  if (!vault) return { state: 'locked' }

  const matching = JSON.parse(vault.listJson()).filter((i) => i.url && matchesUrl(i.url, url))

  if (msg.type === 'suggest') {
    return {
      state: matching.length ? 'ok' : 'none',
      items: matching.map(({ id, title, username, email }) => ({ id, title, username, email })),
    }
  }

  if (msg.type === 'credential') {
    if (!matching.some((i) => i.id === msg.id)) return { error: 'Este registro não é deste site.' }
    const full = JSON.parse(vault.getJson(msg.id))
    return { username: full.username || full.email, password: full.password }
  }

  return { state: 'none' }
}
