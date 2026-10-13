import { api, type DriveInfo } from '../api'
import { errText, h, toast } from '../dom'
import { loginPasteBox } from './login-paste'
import { showPairCode, showPairInput } from './pair'

const AUTO_DELAY_MS = 2_000
const FOCUS_MIN_GAP_MS = 60_000

export interface Sync {
  /** Sincroniza agora. `manual` mostra avisos de sucesso/erro; o automático fica silencioso. */
  run(manual?: boolean): Promise<void>
  /** Agenda uma sincronização logo após uma alteração. */
  schedule(): void
  openDialog(): void
  dispose(): void
}

/** Controla o sync com o Google Drive e o texto de estado na barra inferior. */
export function createSync(statusEl: HTMLElement, onRemoteCredentials: () => void): Sync {
  let info: DriveInfo = { available: false, connected: false, email: '' }
  let running = false
  let timer = 0
  let lastRun = 0
  let lastOk = 0
  let lastError = ''
  let disposed = false

  const paint = (busy = false) => {
    if (!info.available) statusEl.textContent = ''
    else if (!info.connected) statusEl.textContent = '☁ Nuvem desconectada'
    else if (busy) statusEl.textContent = '☁ Sincronizando…'
    else if (lastError) statusEl.textContent = '☁ Falha ao sincronizar'
    else if (lastOk) statusEl.textContent = `☁ Sincronizado às ${new Date(lastOk * 1000).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`
    else statusEl.textContent = '☁ Conectado'
    statusEl.title = lastError || info.email
  }

  const refreshInfo = async () => {
    try {
      info = await api.driveInfo()
    } catch {
      /* mantém o último estado */
    }
    paint()
  }

  async function run(manual = false): Promise<void> {
    if (running || disposed) return
    await refreshInfo()
    if (!info.available || !info.connected) {
      if (manual) toast(info.available ? 'Conecte o Google Drive em "Nuvem".' : 'Este build não tem o Google Drive configurado.', 'err')
      return
    }
    running = true
    paint(true)
    try {
      const r = await api.syncNow()
      lastRun = Date.now()
      lastOk = r.at
      lastError = ''
      if (r.credentials_changed) {
        toast('A senha mestra foi trocada em outro aparelho. Entre com a nova senha e chave secreta.', 'err')
        onRemoteCredentials()
        return
      }
      if (manual) toast('Sincronizado')
    } catch (e) {
      lastError = errText(e)
      if (manual) toast(lastError, 'err')
    } finally {
      running = false
      if (!disposed) paint()
    }
  }

  const onFocus = () => {
    if (Date.now() - lastRun > FOCUS_MIN_GAP_MS) void run()
  }
  window.addEventListener('focus', onFocus)

  void refreshInfo()

  return {
    run,
    schedule() {
      clearTimeout(timer)
      timer = window.setTimeout(() => void run(), AUTO_DELAY_MS)
    },
    openDialog() {
      void showDialog()
    },
    dispose() {
      disposed = true
      clearTimeout(timer)
      window.removeEventListener('focus', onFocus)
    },
  }

  async function showDialog(): Promise<void> {
    await refreshInfo()
    const overlay = h('div', { class: 'overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Nuvem' })
    const close = () => {
      overlay.remove()
      void refreshInfo()
    }
    const box = h('div', { class: 'dialog' })
    overlay.append(box)
    overlay.addEventListener('click', (e) => e.target === overlay && close())
    const render = () => {
      box.replaceChildren(h('h2', { text: 'Google Drive' }))
      const err = h('div', { class: 'form-error', role: 'alert', hidden: true })
      const fail = (m: string) => {
        err.hidden = false
        err.textContent = m
      }
      if (!info.available) {
        box.append(h('p', { class: 'muted', text: 'Este build não tem as credenciais do Google Drive (arquivo google.secret.json).' }))
      } else if (info.connected) {
        const sync = h('button', {
          class: 'btn primary',
          text: 'Sincronizar agora',
          onclick: async () => {
            await run(true)
            render()
          },
        })
        box.append(
          h('p', {}, 'Conectado como ', h('strong', { text: info.email || 'sua conta Google' }), '.'),
          h('p', { class: 'muted', text: 'O arquivo do cofre, já cifrado, fica na pasta "Vault" do seu Drive. O Vault acessa apenas o que ele mesmo criou.' }),
          ...(lastError ? [h('div', { class: 'form-error', text: lastError })] : []),
          h(
            'div',
            { class: 'actions wrap' },
            sync,
            h('button', { class: 'btn', text: '📱 Parear celular (QR)', onclick: () => void showPairCode() }),
            h('button', {
              class: 'btn danger',
              text: 'Desconectar',
              onclick: async () => {
                if (!confirm('Desconectar do Google Drive? O arquivo na nuvem não é apagado.')) return
                try {
                  await api.driveDisconnect()
                  await refreshInfo()
                  lastOk = 0
                  lastError = ''
                  render()
                } catch (e) {
                  fail(errText(e))
                }
              },
            }),
          ),
        )
      } else {
        const btn = h('button', { class: 'btn primary', text: 'Conectar ao Google Drive' })
        btn.addEventListener('click', async () => {
          err.hidden = true
          btn.disabled = true
          btn.textContent = 'Aguardando o navegador…'
          const cancel = h('button', { class: 'btn', text: 'Cancelar', onclick: () => void api.driveCancel() })
          const paste = loginPasteBox()
          btn.after(cancel)
          box.insertBefore(paste, err)
          try {
            await api.driveConnect()
            await refreshInfo()
            void run(true)
            render()
          } catch (e) {
            fail(errText(e))
            btn.disabled = false
            btn.textContent = 'Conectar ao Google Drive'
            cancel.remove()
            paste.remove()
          }
        })
        box.append(
          h('p', { class: 'muted', text: 'Sincroniza o cofre entre o computador e o celular. Uma janela do navegador vai abrir para você entrar na sua conta Google.' }),
          h('div', { class: 'actions wrap' }, btn),
          h('button', {
            class: 'link',
            type: 'button',
            text: 'Entrar com QR do computador',
            onclick: () =>
              showPairInput(async () => {
                await refreshInfo()
                void run(true)
                render()
              }),
          }),
        )
      }
      box.append(err, h('div', { class: 'actions end' }, h('button', { class: 'btn', text: 'Fechar', onclick: close })))
    }
    render()
    document.body.append(overlay)
  }
}
