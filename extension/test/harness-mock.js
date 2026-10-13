// API `chrome` simulada para testar o popup e o menu em linha fora do navegador.
// Lê o cofre de teste em fixtures/ (dados falsos: gere com o exemplo make_vault do núcleo).
// Parâmetros da URL: ?tab=<endereço da "aba">  ?session=1 (cofre já desbloqueado).

import { handleRequest } from '../lib/suggest.js'

const EXT_ID = 'test-ext'
const params = new URLSearchParams(location.search)
const tabUrl = params.get('tab') || 'https://github.com/login'
const session = params.get('session') === '1'

const bytes = new Uint8Array(await (await fetch('./fixtures/teste.vault')).arrayBuffer())
const creds = await (await fetch('./fixtures/creds.json')).json()

function toBase64(u8) {
  let s = ''
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000))
  return btoa(s)
}

const area = (initial = {}) => {
  let data = { ...initial }
  return {
    async get(key) {
      return key == null ? { ...data } : { [key]: data[key] }
    },
    async set(obj) {
      Object.assign(data, obj)
    },
    async remove(key) {
      delete data[key]
    },
    async clear() {
      data = {}
    },
  }
}

const listeners = []
window.__sent = []

function loadContentScript() {
  const s = document.createElement('script')
  s.src = '../content.js'
  document.head.append(s)
}

window.chrome = {
  storage: {
    local: area({
      pair: { refreshToken: 'fake', secretKey: creds.secret, email: 'demo@exemplo.com' },
      vault: { b64: toBase64(bytes), syncedAt: Date.now(), revision: 0 },
    }),
    session: area(),
  },
  tabs: {
    query: async () => [{ id: 1, url: tabUrl }],
    // Entrega a mensagem ao script de conteúdo (se ele estiver carregado), como o navegador faria.
    sendMessage: (_tabId, msg) =>
      new Promise((resolve, reject) => {
        if (!listeners.length) return reject(new Error('Receiving end does not exist'))
        for (const fn of listeners) fn(msg, { id: EXT_ID }, resolve)
      }),
  },
  scripting: {
    async executeScript({ files }) {
      if (files?.includes('content.js')) loadContentScript()
    },
  },
  runtime: {
    id: EXT_ID,
    onMessage: { addListener: (fn) => listeners.push(fn) },
    // Pedidos do menu em linha vão para a mesma lógica do service worker; o resto só é registrado.
    async sendMessage(msg) {
      window.__sent.push(msg)
      if (msg?.type === 'suggest' || msg?.type === 'credential') {
        return handleRequest(msg, { id: EXT_ID, tab: { url: tabUrl }, frameId: 0, url: tabUrl })
      }
    },
  },
}

window.__creds = creds
if (session) {
  const { WasmVault, default: init } = await import('../wasm/vault_wasm.js')
  await init()
  const v = WasmVault.open(bytes, creds.password, creds.secret)
  await chrome.storage.session.set({ session: toBase64(v.unlockKey()) })
}

// A página de teste do menu em linha (content-harness.html) pede o script de conteúdo.
if (document.body.dataset.content !== undefined) loadContentScript()
// A página de teste do popup (harness.html) só inicia o popup depois que `chrome` existe (no navegador real já existe).
if (document.body.dataset.popup !== undefined) await import('../popup.js')
