import { api } from '../api'
import { errText, h, toast } from '../dom'
import { strength, strengthLabel } from '../gen'

function field(label: string, input: HTMLInputElement, hint?: string): HTMLElement {
  return h('label', { class: 'field' }, h('span', { class: 'lbl', text: label }), input, hint ? h('span', { class: 'hint', text: hint }) : null)
}

/** Diálogo "Segurança": desbloqueio por biometria (Android) e troca da senha mestra. */
export async function showSecurityDialog(onPasswordChanged: () => void, toggleTheme: () => void): Promise<void> {
  const [bio, status] = await Promise.all([api.bioInfo().catch(() => ({ available: false, enabled: false })), api.status()])

  const overlay = h('div', { class: 'overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Segurança' })
  const box = h('div', { class: 'dialog' })
  overlay.append(box)
  const close = () => overlay.remove()
  overlay.addEventListener('click', (e) => e.target === overlay && close())

  const sections: HTMLElement[] = [h('h2', { text: 'Segurança' })]

  // ---- Biometria ----
  if (bio.available) {
    let enabled = bio.enabled
    const state = h('p', { class: 'muted' })
    const err = h('div', { class: 'form-error', role: 'alert', hidden: true })
    const btn = h('button', { class: 'btn' })
    const paint = () => {
      state.textContent = enabled
        ? 'Ativado: você pode abrir o cofre com a biometria do aparelho, sem digitar a senha mestra.'
        : 'Abra o cofre com a sua digital ou rosto. A chave fica no hardware do aparelho e só é liberada pela biometria.'
      btn.textContent = enabled ? 'Desativar biometria' : 'Ativar biometria'
      btn.classList.toggle('danger', enabled)
    }
    btn.addEventListener('click', async () => {
      err.hidden = true
      btn.disabled = true
      try {
        if (enabled) await api.bioDisable()
        else await api.bioEnable()
        enabled = !enabled
        paint()
      } catch (e) {
        const m = errText(e)
        if (m !== 'cancelled') {
          err.hidden = false
          err.textContent = m
        }
      } finally {
        btn.disabled = false
      }
    })
    paint()
    sections.push(h('h3', { text: 'Desbloqueio por biometria' }), state, err, h('div', { class: 'actions' }, btn))
  }

  // ---- Trocar senha mestra ----
  const cur = h('input', { type: 'password', autocomplete: 'current-password', required: true })
  const secret = h('input', { type: 'text', autocomplete: 'off', spellcheck: false, placeholder: 'XXXXX-XXXXX-…' })
  const next = h('input', { type: 'password', autocomplete: 'new-password', required: true })
  const next2 = h('input', { type: 'password', autocomplete: 'new-password', required: true })
  const bar = h('div', { class: 'meter-bar' })
  const barTxt = h('span', { class: 'meter-txt' })
  next.addEventListener('input', () => {
    const s = strength(next.value)
    bar.dataset.lvl = String(s)
    bar.style.setProperty('--lvl', String(s))
    barTxt.textContent = next.value ? strengthLabel[s] : ''
  })
  const err = h('div', { class: 'form-error', role: 'alert', hidden: true })
  const save = h('button', { class: 'btn primary', type: 'submit', text: 'Trocar senha mestra' })
  const form = h(
    'form',
    { class: 'form' },
    h('h3', { text: 'Trocar a senha mestra' }),
    field('Senha atual', cur),
    status.secret_on_device ? null : field('Chave secreta', secret, 'Necessária porque não está guardada neste aparelho.'),
    field('Nova senha mestra', next, 'Use uma frase longa (5 palavras ou mais).'),
    h('div', { class: 'meter' }, bar, barTxt),
    field('Repita a nova senha', next2),
    err,
    save,
  )
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault()
    err.hidden = true
    const fail = (m: string) => {
      err.hidden = false
      err.textContent = m
    }
    if (next.value.length < 10) return fail('A nova senha precisa ter pelo menos 10 caracteres.')
    if (next.value !== next2.value) return fail('As senhas novas não conferem.')
    save.disabled = true
    save.textContent = 'Aguarde…'
    try {
      await api.changePassword(cur.value, next.value, status.secret_on_device ? null : secret.value)
      toast('Senha mestra alterada')
      onPasswordChanged()
      close()
    } catch (e) {
      fail(errText(e))
      save.disabled = false
      save.textContent = 'Trocar senha mestra'
    }
  })
  sections.push(form, h('p', { class: 'hint', text: 'Em outros aparelhos, a nova senha passa a valer depois que eles sincronizarem.' }))

  sections.push(
    h('h3', { text: 'Aparência' }),
    h('div', { class: 'actions' }, h('button', { class: 'btn', text: '◐ Alternar tema claro/escuro', onclick: toggleTheme })),
  )

  box.append(...sections, h('div', { class: 'actions end' }, h('button', { class: 'btn', text: 'Fechar', onclick: close })))
  document.body.append(overlay)
}
