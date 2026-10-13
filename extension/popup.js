import init, { WasmVault } from './wasm/vault_wasm.js'
import * as drive from './lib/drive.js'
import { hostOf, isSecurePage, matchesUrl } from './lib/match.js'
import { parsePairCode } from './lib/pair.js'
import * as store from './lib/store.js'

const app = document.getElementById('app')
const wasmReady = init()
const AUTO_SYNC_MS = 10 * 60 * 1000

let vault = null // WasmVault aberto (só existe enquanto o popup está aberto)
let tab = null // aba atual
let rollbackWarning = false

// ---------------------------------------------------------------- utilidades

/** Cria elementos sem innerHTML: nada que venha do cofre ou do Drive é interpretado como HTML. */
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue
    if (k === 'class') el.className = v
    else if (k === 'text') el.textContent = v
    else if (k === 'value') el.value = v
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
    else el.setAttribute(k, v === true ? '' : v)
  }
  for (const kid of kids) if (kid != null && kid !== false) el.append(kid)
  return el
}

const errText = (e) => (e instanceof Error ? e.message : String(e))
const touch = () => chrome.runtime.sendMessage({ type: 'session-touch' }).catch(() => {})
const paint = () => new Promise((r) => setTimeout(r, 30)) // deixa a tela atualizar antes de um trabalho pesado

function render(...nodes) {
  // `replaceChildren(null)` escreveria o texto "null": ignora os itens vazios.
  app.replaceChildren(...nodes.filter(Boolean))
}

function topBar(...actions) {
  return h(
    'div',
    { class: 'top' },
    h('img', { src: 'icons/48.png', alt: '' }),
    h('span', { class: 'title', text: 'Vault' }),
    h('span', { class: 'spacer' }),
    ...actions,
  )
}

function message(kind, text) {
  return h('div', { class: `msg ${kind}`, role: kind === 'err' ? 'alert' : 'status', text })
}

async function currentTab() {
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true })
  return t ?? null
}

/**
 * Abas abertas antes de instalar/recarregar a extensão não têm o script do menu em linha. Ao abrir o popup
 * (gesto do usuário, que concede `activeTab`) injeta o script, sem precisar recarregar a página.
 */
async function ensureContentScript(t) {
  if (!t?.id || !/^https?:/.test(t.url || '')) return
  try {
    await chrome.tabs.sendMessage(t.id, { type: 'ping' })
  } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['content.js'] })
    } catch {
      /* página restrita (loja de extensões, etc.): não há o que fazer */
    }
  }
}

/** Pede à página para preencher. Se o script ainda não está nela (aba aberta antes de instalar), injeta e repete. */
async function sendFill(tabId, payload) {
  const msg = { type: 'fill', ...payload }
  try {
    return await chrome.tabs.sendMessage(tabId, msg)
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] })
    return await chrome.tabs.sendMessage(tabId, msg)
  }
}

// ---------------------------------------------------------------- sincronização (somente leitura)

/** Baixa o cofre do Drive e guarda a cópia local (que já é cifrada). Devolve true se mudou. */
async function syncDown() {
  const pair = await store.getPair()
  const bytes = await drive.downloadVault(pair.refreshToken)
  if (!bytes) throw new Error('Nenhum cofre do Vault foi encontrado neste Google Drive.')
  const saved = await store.getVaultBytes()
  const changed = !saved || saved.bytes.length !== bytes.length || saved.bytes.some((b, i) => b !== bytes[i])
  await store.setVaultBytes(bytes)
  return changed
}

// ---------------------------------------------------------------- telas

function showLoading(text) {
  render(topBar(), h('div', { class: 'view' }, h('p', { class: 'muted', text })))
}

function showFatal(text) {
  render(
    topBar(),
    h(
      'div',
      { class: 'view' },
      message('err', text),
      h('button', { class: 'btn primary', text: 'Tentar de novo', onclick: () => void boot() }),
      ' ',
      h('button', { class: 'link', text: 'Desparear', onclick: () => void unpair() }),
    ),
  )
}

function showPair(initialError = '') {
  const code = h('textarea', { placeholder: 'vault1:…', spellcheck: 'false', 'aria-label': 'Código de pareamento' })
  const err = h('div', { hidden: !initialError })
  if (initialError) err.replaceChildren(message('err', initialError))
  const btn = h('button', { class: 'btn primary', text: 'Parear' })
  btn.addEventListener('click', async () => {
    err.replaceChildren()
    err.hidden = true
    btn.disabled = true
    btn.textContent = 'Pareando…'
    try {
      const { refreshToken, secretKey } = parsePairCode(code.value)
      const email = await drive.userEmail(refreshToken)
      await store.setPair({ refreshToken, secretKey, email })
      showLoading('Baixando o cofre…')
      await syncDown()
      await boot()
    } catch (e) {
      await store.clearAll() // não deixa um pareamento pela metade
      showPair(errText(e))
    }
  })
  render(
    topBar(),
    h(
      'div',
      { class: 'view' },
      h('h1', { text: 'Parear com o seu cofre' }),
      h('p', {
        class: 'muted',
        text: 'No app do Vault no computador, abra ☁ Nuvem → Parear celular (QR) → Copiar código, e cole aqui. O código vale 10 minutos.',
      }),
      h('div', { class: 'field' }, code),
      err,
      btn,
    ),
  )
  code.focus()
}

async function showUnlock(initialError = '') {
  const pair = await store.getPair()
  const saved = await store.getVaultBytes()
  const pw = h('input', { type: 'password', autocomplete: 'current-password', 'aria-label': 'Senha mestra' })
  const err = h('div')
  if (initialError) err.append(message('err', initialError))
  const btn = h('button', { class: 'btn primary', type: 'submit', text: 'Desbloquear' })
  const form = h(
    'form',
    { class: 'view' },
    h('h1', { text: 'Cofre bloqueado' }),
    h('p', { class: 'muted', text: pair.email ? `Conta Google: ${pair.email}` : 'Digite a senha mestra.' }),
    h('div', { class: 'field' }, h('span', { class: 'lbl', text: 'Senha mestra' }), pw),
    err,
    btn,
    ' ',
    h('button', { class: 'link', type: 'button', text: 'Desparear este navegador', onclick: () => void unpair() }),
  )
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault()
    err.replaceChildren()
    btn.disabled = true
    btn.textContent = 'Desbloqueando…'
    await paint()
    try {
      vault = WasmVault.open(saved.bytes, pw.value, pair.secretKey)
      await store.setSessionKey(vault.unlockKey())
      touch()
      await showMain()
    } catch (e) {
      err.append(message('err', errText(e)))
      btn.disabled = false
      btn.textContent = 'Desbloquear'
      pw.select()
    }
  })
  render(topBar(), form)
  pw.focus()
}

async function lock() {
  vault = null
  await store.clearSession()
  await showUnlock()
}

async function unpair() {
  if (!confirm('Desparear este navegador? A cópia do cofre e a chave secreta guardadas aqui serão apagadas. O cofre no Drive não é alterado.')) return
  await store.clearAll()
  vault = null
  showPair()
}

async function showMain(search = '') {
  const saved = await store.getVaultBytes()
  const items = JSON.parse(vault.listJson())

  // O arquivo no Drive não pode "voltar no tempo" (alguém restaurou uma versão antiga?).
  const rev = vault.revision()
  if (rev < saved.revision) rollbackWarning = true
  else if (rev > saved.revision) await store.setRevision(rev)

  const tabUrl = tab?.url ?? ''
  const host = hostOf(tabUrl)
  const forSite = items.filter((i) => i.url && tabUrl && matchesUrl(i.url, tabUrl))
  const q = search.trim().toLowerCase()
  const others = items.filter(
    (i) => !forSite.includes(i) && (!q || [i.title, i.url, i.email, i.username].some((f) => f.toLowerCase().includes(q))),
  )

  const status = h('div')
  const flash = (kind, text) => status.replaceChildren(message(kind, text))

  async function copy(text, label) {
    touch()
    try {
      await navigator.clipboard.writeText(text)
      chrome.runtime.sendMessage({ type: 'clip-clear' }).catch(() => {})
      flash('ok', `${label} copiado. A área de transferência é limpa em 30 s.`)
    } catch {
      flash('err', 'Não foi possível copiar.')
    }
  }

  async function fill(item, isMatch) {
    touch()
    if (!tab?.id || !tabUrl) return flash('err', 'Abra uma página de login e tente de novo.')
    if (!isMatch && !confirm(`Este registro é de "${item.url || 'sem site'}", mas a aba atual é ${host || 'outro site'}. Preencher mesmo assim?`)) return
    if (!isSecurePage(tabUrl) && !confirm('Esta página não usa HTTPS: quem estiver na rede pode ver a senha. Preencher mesmo assim?')) return
    try {
      const full = JSON.parse(vault.getJson(item.id))
      const result = await sendFill(tab.id, { username: full.username || full.email, password: full.password })
      if (result.filledPass || result.filledUser) {
        flash('ok', result.filledPass ? 'Preenchido.' : 'Usuário preenchido. Continue o login e abra a extensão de novo para a senha.')
        if (result.filledPass) setTimeout(() => window.close(), 600)
      } else {
        flash('err', 'Não encontrei o campo de login nesta página.')
      }
    } catch {
      flash('err', 'Não é possível preencher esta página (páginas do navegador e lojas de extensões são bloqueadas).')
    }
  }

  const row = (item, isMatch) =>
    h(
      'div',
      { class: 'entry' },
      h('span', { class: 'avatar', text: (item.title || '?').trim().charAt(0).toUpperCase() || '?' }),
      h(
        'span',
        { class: 'text' },
        h('div', { class: 'name', text: item.title || '(sem título)' }),
        h('div', { class: 'sub', text: item.username || item.email || item.url }),
      ),
      h(
        'span',
        { class: 'acts' },
        h('button', { class: 'btn small primary', text: 'Preencher', onclick: () => void fill(item, isMatch) }),
        item.username || item.email
          ? h('button', {
              class: 'btn small',
              title: 'Copiar usuário',
              'aria-label': 'Copiar usuário',
              text: '👤',
              onclick: () => void copy(item.username || item.email, 'Usuário'),
            })
          : null,
        h('button', {
          class: 'btn small',
          title: 'Copiar senha',
          'aria-label': 'Copiar senha',
          text: '🔑',
          onclick: () => void copy(JSON.parse(vault.getJson(item.id)).password, 'Senha'),
        }),
      ),
    )

  const searchBox = h('input', { type: 'search', placeholder: 'Buscar em todos os registros…', value: search, 'aria-label': 'Buscar' })
  searchBox.addEventListener('input', () => {
    clearTimeout(searchBox._t)
    searchBox._t = setTimeout(() => void showMain(searchBox.value), 150)
  })

  const syncBtn = h('button', { class: 'btn icon', title: 'Sincronizar com o Drive', 'aria-label': 'Sincronizar', text: '⟳' })
  syncBtn.addEventListener('click', () => void resync(true))

  render(
    topBar(syncBtn, h('button', { class: 'btn', text: '🔒 Bloquear', onclick: () => void lock() })),
    h('div', { class: 'search' }, searchBox),
    status,
    rollbackWarning ? message('warn', 'O arquivo no Drive parece mais antigo que o que você já viu. Alguém pode ter restaurado uma versão antiga.') : null,
    h('div', { class: 'section', text: host ? `Para ${host}` : 'Para esta página' }),
    ...(forSite.length ? forSite.map((i) => row(i, true)) : [h('div', { class: 'empty', text: 'Nenhum registro com o endereço deste site.' })]),
    h('div', { class: 'section', text: q ? 'Resultados' : 'Todos os registros' }),
    ...(others.length ? others.map((i) => row(i, false)) : [h('div', { class: 'empty', text: q ? 'Nada encontrado.' : 'Sem outros registros.' })]),
    h(
      'div',
      { class: 'foot' },
      `${items.length} ${items.length === 1 ? 'registro' : 'registros'} · sincronizado ${ago(saved.syncedAt)} · `,
      h('button', { class: 'link', text: 'Desparear', onclick: () => void unpair() }),
    ),
  )
  if (search) searchBox.focus()

  if (Date.now() - saved.syncedAt > AUTO_SYNC_MS) void resync(false)
}

function ago(ms) {
  const min = Math.round((Date.now() - ms) / 60000)
  return min < 1 ? 'agora' : min < 60 ? `há ${min} min` : `há ${Math.round(min / 60)} h`
}

/** Baixa de novo e reabre. `manual` mostra erros; o automático é silencioso. */
async function resync(manual) {
  try {
    await syncDown()
    const saved = await store.getVaultBytes()
    const key = await store.getSessionKey()
    if (!key) return await showUnlock()
    try {
      vault = WasmVault.openWithKey(saved.bytes, key)
    } catch {
      // A senha/chave foi trocada em outro aparelho: a chave da sessão não abre mais o arquivo novo.
      await store.clearSession()
      vault = null
      return await showUnlock('O cofre mudou em outro aparelho (senha ou chave trocada). Desbloqueie de novo; se não funcionar, pareie com um código novo.')
    }
    await showMain()
  } catch (e) {
    if (manual) {
      const status = app.querySelector('.msg')
      if (!status) app.querySelector('.search')?.after(message('err', errText(e)))
    }
  }
}

// ---------------------------------------------------------------- início

async function boot() {
  try {
    await wasmReady
    tab = await currentTab()
    void ensureContentScript(tab)
    const pair = await store.getPair()
    if (!pair) return showPair()

    let saved = await store.getVaultBytes()
    if (!saved) {
      showLoading('Baixando o cofre…')
      await syncDown()
      saved = await store.getVaultBytes()
    }
    const key = await store.getSessionKey()
    if (key) {
      try {
        vault = WasmVault.openWithKey(saved.bytes, key)
        touch()
        return await showMain()
      } catch {
        await store.clearSession()
      }
    }
    await showUnlock()
  } catch (e) {
    showFatal(errText(e))
  }
}

void boot()
