import { api } from './api'
import { clear } from './dom'
import { showSetup, showUnlock } from './ui/auth'
import { mountVault } from './ui/vault-view'

const root = document.getElementById('app')!
const IDLE_MINUTES = 5

// Tema: segue o sistema; o botão alterna e a escolha fica salva neste aparelho.
function applyTheme(dark: boolean): void {
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
}
function initialTheme(): boolean {
  try {
    const v = localStorage.getItem('theme')
    if (v) return v === 'dark'
  } catch {
    /* sem armazenamento: segue o sistema */
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}
applyTheme(initialTheme())
function toggleTheme(): void {
  const dark = document.documentElement.dataset.theme !== 'dark'
  applyTheme(dark)
  try {
    localStorage.setItem('theme', dark ? 'dark' : 'light')
  } catch {
    /* ignora */
  }
}

// Bloqueio automático por inatividade.
let idleTimer = 0
let unlocked = false
const resetIdle = () => {
  clearTimeout(idleTimer)
  if (unlocked) idleTimer = window.setTimeout(() => void lockNow(), IDLE_MINUTES * 60_000)
}
for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart']) window.addEventListener(ev, resetIdle, { passive: true })
document.addEventListener('visibilitychange', () => {
  // Ao sair do app, encurta a espera para 1 min.
  if (document.hidden && unlocked) {
    clearTimeout(idleTimer)
    idleTimer = window.setTimeout(() => void lockNow(), 60_000)
  } else resetIdle()
})

let unmount: (() => void) | null = null

async function lockNow(): Promise<void> {
  unlocked = false
  clearTimeout(idleTimer)
  unmount?.()
  unmount = null
  await api.lock()
  clear(root)
  await boot()
}

function enter(): void {
  unlocked = true
  resetIdle()
  unmount?.()
  unmount = mountVault(root, {
    onLock: () => void lockNow(),
    onRemoteCredentials: () => void lockNow(),
    toggleTheme,
    idleMinutes: IDLE_MINUTES,
  })
}

async function boot(): Promise<void> {
  const st = await api.status()
  if (!st.exists) showSetup(root, enter, () => void boot())
  else if (!st.unlocked) showUnlock(root, st, enter)
  else enter()
}

// Fora do Tauri (só no `npm run dev` em navegador) o backend é um mock: avisa para não confundir com o app real.
if (!('__TAURI_INTERNALS__' in window)) {
  const b = document.createElement('div')
  b.className = 'demo-banner'
  b.textContent = 'MODO DEMONSTRAÇÃO — dados falsos, nada é cifrado nem salvo. Use "npm run tauri dev" para o app real.'
  document.body.prepend(b)
}

void boot()
