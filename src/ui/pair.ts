import { api } from '../api'
import { copySecret, errText, h, toast } from '../dom'

const isAndroid = () => /android/i.test(navigator.userAgent)

function makeOverlay(label: string): { box: HTMLElement; close: () => void; mount: () => void } {
  const overlay = h('div', { class: 'overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': label })
  const box = h('div', { class: 'dialog' })
  overlay.append(box)
  const close = () => overlay.remove()
  overlay.addEventListener('click', (e) => e.target === overlay && close())
  return { box, close, mount: () => document.body.append(overlay) }
}

/** Computador: mostra o QR code para o celular escanear. Some sozinho quando o código expira. */
export async function showPairCode(): Promise<void> {
  let info
  try {
    info = await api.pairCode()
  } catch (e) {
    toast(errText(e), 'err')
    return
  }
  const { box, close, mount } = makeOverlay('Parear celular')
  const svg = new DOMParser().parseFromString(info.svg, 'image/svg+xml').documentElement
  const qr = h('div', { class: 'qr' })
  qr.append(document.importNode(svg, true))

  let left = info.expires_in
  const timer = h('p', { class: 'hint center' })
  const paint = () => {
    const m = Math.floor(left / 60)
    const s = String(left % 60).padStart(2, '0')
    timer.textContent = `Expira em ${m}:${s}`
  }
  paint()
  const tick = window.setInterval(() => {
    left -= 1
    if (left <= 0) {
      clearInterval(tick)
      close()
      toast('O código expirou. Gere outro se precisar.')
      return
    }
    paint()
  }, 1000)
  const closeAll = () => {
    clearInterval(tick)
    close()
  }

  box.append(
    h('h2', { text: 'Parear celular' }),
    h('p', { class: 'muted', text: 'No celular, abra o Vault, toque em "Entrar com QR do computador" e aponte a câmera para o código.' }),
    qr,
    timer,
    h('div', {
      class: 'form-error',
      text: 'Este código dá acesso ao seu cofre no Drive e inclui a chave secreta (a senha mestra não vai nele). Não tire print nem mostre a ninguém.',
    }),
    h(
      'div',
      { class: 'actions end' },
      h('button', { class: 'btn', text: 'Copiar código', onclick: () => copySecret(info.code, 'Código') }),
      h('button', { class: 'btn primary', text: 'Fechar', onclick: closeAll }),
    ),
  )
  mount()
}

async function scanQr(): Promise<string> {
  const scanner = await import('@tauri-apps/plugin-barcode-scanner')
  let perm = await scanner.checkPermissions()
  if (perm !== 'granted') perm = await scanner.requestPermissions()
  if (perm !== 'granted') throw 'Sem permissão da câmera. Libere nas configurações do Android ou cole o código.'
  const result = await scanner.scan({ windowed: false, formats: [scanner.Format.QRCode] })
  return result.content
}

/**
 * Celular: escaneia o QR do computador ou aceita o código colado.
 * `onApplied(pulled)`: pulled=true quando o cofre foi baixado e falta só a senha mestra.
 */
export function showPairInput(onApplied: (pulled: boolean) => void): void {
  const { box, close, mount } = makeOverlay('Entrar com QR do computador')
  const input = h('input', { type: 'text', placeholder: 'vault1:…', autocomplete: 'off', spellcheck: false, 'aria-label': 'Código de pareamento' })
  const err = h('div', { class: 'form-error', role: 'alert', hidden: true })
  const fail = (m: string) => {
    err.hidden = false
    err.textContent = m
  }

  async function apply(code: string): Promise<void> {
    err.hidden = true
    busy(true)
    try {
      const r = await api.pairApply(code)
      close()
      toast('Pareado com o computador')
      onApplied(r.pulled)
    } catch (e) {
      fail(errText(e))
      busy(false)
    }
  }

  const scan = h('button', { class: 'btn primary', type: 'button', text: '📷 Escanear QR do computador' })
  const send = h('button', { class: 'btn', type: 'button', text: 'Usar código colado' })
  const busy = (on: boolean) => {
    scan.disabled = on
    send.disabled = on
  }
  scan.addEventListener('click', async () => {
    err.hidden = true
    try {
      await apply(await scanQr())
    } catch (e) {
      const m = errText(e)
      if (!/cancel/i.test(m)) fail(m)
    }
  })
  send.addEventListener('click', () => {
    const code = input.value.trim()
    if (!code) return fail('Cole o código de pareamento.')
    void apply(code)
  })

  box.append(
    h('h2', { text: 'Entrar com QR do computador' }),
    h('p', { class: 'muted', text: 'No computador, abra o Vault, vá em ☁ Nuvem → "Parear celular" e escaneie o código que aparecer.' }),
    ...(isAndroid() ? [h('div', { class: 'actions' }, scan)] : []),
    h('label', { class: 'field' }, h('span', { class: 'lbl', text: isAndroid() ? 'Ou cole o código' : 'Cole o código do outro aparelho' }), input),
    err,
    h('div', { class: 'actions end' }, send, h('button', { class: 'btn', text: 'Cancelar', onclick: close })),
  )
  mount()
}
