import { api, type Keys, type Status } from '../api'
import { clear, copySecret, errText, h } from '../dom'
import { strength, strengthLabel } from '../gen'
import { loginPasteBox } from './login-paste'
import { showPairInput } from './pair'

type Done = () => void

function card(root: HTMLElement, title: string, subtitle: string, ...body: (Node | null)[]): HTMLElement {
  clear(root)
  const c = h(
    'div',
    { class: 'auth-card' },
    h('div', { class: 'brand' }, h('img', { class: 'brand-icon', src: '/icon.svg', alt: '' }), h('span', { text: 'Vault' })),
    h('h1', { text: title }),
    h('p', { class: 'muted', text: subtitle }),
    ...body,
  )
  root.append(h('div', { class: 'auth' }, c))
  return c
}

function field(label: string, input: HTMLInputElement, hint?: string): HTMLElement {
  return h('label', { class: 'field' }, h('span', { class: 'lbl', text: label }), input, hint ? h('span', { class: 'hint', text: hint }) : null)
}

function meter(): { el: HTMLElement; update(p: string): void } {
  const bar = h('div', { class: 'meter-bar' })
  const txt = h('span', { class: 'meter-txt' })
  return {
    el: h('div', { class: 'meter' }, bar, txt),
    update(p) {
      const s = strength(p)
      bar.style.setProperty('--lvl', String(s))
      bar.dataset.lvl = String(s)
      txt.textContent = p ? strengthLabel[s] : ''
    },
  }
}

function errorBox(): { el: HTMLElement; show(m: string): void } {
  const el = h('div', { class: 'form-error', role: 'alert', hidden: true })
  return {
    el,
    show(m) {
      el.hidden = !m
      el.textContent = m
    },
  }
}

async function submitWith(btn: HTMLButtonElement, err: { show(m: string): void }, fn: () => Promise<void>) {
  err.show('')
  btn.disabled = true
  const old = btn.textContent
  btn.textContent = 'Aguarde…'
  try {
    await fn()
  } catch (e) {
    err.show(errText(e))
    btn.disabled = false
    btn.textContent = old
  }
}

/** Aparelho novo: entra na conta Google e baixa o cofre que já existe no Drive. */
async function pullFromDrive(link: HTMLButtonElement, err: { show(m: string): void }, pulled: Done): Promise<void> {
  err.show('')
  let paste: HTMLElement | null = null
  try {
    const info = await api.driveInfo()
    if (!info.available) return err.show('Este build não tem o Google Drive configurado.')
    link.disabled = true
    link.textContent = 'Aguardando o navegador…'
    if (!info.connected) {
      paste = loginPasteBox()
      link.after(paste)
      await api.driveConnect()
      paste.remove()
    }
    await api.drivePull()
    pulled()
  } catch (e) {
    paste?.remove()
    err.show(errText(e))
    link.disabled = false
    link.textContent = 'Já tenho um cofre no Google Drive'
  }
}

export function showSetup(root: HTMLElement, done: Done, pulled: Done): void {
  const pw = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: 10 })
  const pw2 = h('input', { type: 'password', autocomplete: 'new-password', required: true })
  const remember = h('input', { type: 'checkbox', checked: true })
  const m = meter()
  const err = errorBox()
  const btn = h('button', { class: 'btn primary', type: 'submit', text: 'Criar cofre' })
  // Caminho mais fácil para o celular: escanear o QR mostrado pelo computador que já sincroniza.
  const qrLink = h('button', {
    class: 'link',
    type: 'button',
    text: 'Entrar com QR do computador',
    onclick: () => showPairInput((pulled) => (pulled ? pulledDone() : done())),
  })
  const pulledDone = pulled
  const existing = h('button', {
    class: 'link',
    type: 'button',
    text: 'Já tenho um cofre no Google Drive',
    onclick: () => void pullFromDrive(existing, err, pulled),
  })
  pw.addEventListener('input', () => m.update(pw.value))
  const form = h(
    'form',
    { class: 'form', novalidate: true },
    field('Senha mestra', pw, 'Use uma frase longa (5 palavras ou mais). É a proteção que mais pesa.'),
    m.el,
    field('Repita a senha mestra', pw2),
    h('label', { class: 'check' }, remember, h('span', { text: 'Lembrar a chave secreta neste aparelho (protegida pelo sistema)' })),
    err.el,
    btn,
    qrLink,
    existing,
  )
  form.addEventListener('submit', (ev) => {
    ev.preventDefault()
    if (pw.value.length < 10) return err.show('A senha mestra precisa ter pelo menos 10 caracteres.')
    if (pw.value !== pw2.value) return err.show('As senhas não conferem.')
    void submitWith(btn, err, async () => {
      const keys = await api.createVault(pw.value, remember.checked)
      showKeys(root, keys, 'Cofre criado', true, done)
    })
  })
  card(root, 'Criar seu cofre', 'Tudo é cifrado neste aparelho. Ninguém — nem o servidor onde o arquivo for guardado — consegue ler sem a sua senha e a chave secreta.', form)
  pw.focus()
}

export function showKeys(root: HTMLElement, keys: Partial<Keys>, title: string, withRecovery: boolean, done: Done): void {
  const row = (label: string, value: string, desc: string) =>
    h(
      'div',
      { class: 'keybox' },
      h('div', { class: 'lbl', text: label }),
      h('code', { class: 'key', text: value }),
      h('div', { class: 'hint', text: desc }),
      h('button', { class: 'btn small no-print', type: 'button', text: 'Copiar', onclick: () => copySecret(value, label) }),
    )
  const ack = h('input', { type: 'checkbox' })
  const go = h('button', { class: 'btn primary', type: 'button', text: 'Continuar', disabled: true, onclick: done })
  ack.addEventListener('change', () => (go.disabled = !ack.checked))
  card(
    root,
    title,
    'Anote estas chaves agora. Elas não serão mostradas de novo.',
    keys.secret_key ? row('Chave secreta', keys.secret_key, 'Necessária (junto com a senha) para abrir o cofre em outro aparelho.') : null,
    withRecovery && keys.recovery_key
      ? row('Chave de recuperação', keys.recovery_key, 'Única forma de entrar se você esquecer a senha mestra. Sem ela e sem a senha, não há recuperação.')
      : null,
    h(
      'div',
      { class: 'actions no-print' },
      h('button', { class: 'btn', type: 'button', text: 'Imprimir', onclick: () => window.print() }),
    ),
    h('label', { class: 'check no-print' }, ack, h('span', { text: 'Guardei as chaves em um lugar seguro, fora deste computador.' })),
    h('div', { class: 'no-print' }, go),
  )
}

export function showUnlock(root: HTMLElement, st: Status, done: Done): void {
  const pw = h('input', { type: 'password', autocomplete: 'current-password', required: true })
  const secret = h('input', { type: 'text', autocomplete: 'off', spellcheck: false, placeholder: 'XXXXX-XXXXX-…' })
  const remember = h('input', { type: 'checkbox', checked: true })
  const err = errorBox()
  const btn = h('button', { class: 'btn primary', type: 'submit', text: 'Desbloquear' })
  // Biometria (Android): aparece só se o usuário a ativou, e já pede a digital ao abrir a tela.
  const bioBtn = h('button', { class: 'btn', type: 'button', text: '🔓 Desbloquear com biometria', hidden: true })
  const tryBio = async () => {
    err.show('')
    bioBtn.disabled = true
    try {
      await api.bioUnlock()
      done()
    } catch (e) {
      const m = errText(e)
      if (m !== 'cancelled') err.show(m)
      bioBtn.disabled = false
    }
  }
  bioBtn.addEventListener('click', () => void tryBio())
  void api
    .bioInfo()
    .then((b) => {
      if (!b.enabled) return
      bioBtn.hidden = false
      void tryBio()
    })
    .catch(() => {})
  const form = h(
    'form',
    { class: 'form' },
    bioBtn,
    h('div', { class: 'spacer-sm' }),
    field('Senha mestra', pw),
    st.secret_on_device ? null : field('Chave secreta', secret, 'Aparece só em aparelhos novos.'),
    st.secret_on_device ? null : h('label', { class: 'check' }, remember, h('span', { text: 'Lembrar neste aparelho' })),
    err.el,
    btn,
    h('button', { class: 'link', type: 'button', text: 'Esqueci a senha mestra', onclick: () => showRecovery(root, st, done) }),
  )
  form.addEventListener('submit', (ev) => {
    ev.preventDefault()
    void submitWith(btn, err, async () => {
      await api.unlock(pw.value, st.secret_on_device ? null : secret.value, st.secret_on_device || remember.checked)
      done()
    })
  })
  card(root, 'Cofre bloqueado', 'Digite a senha mestra para continuar.', form)
  pw.focus()
}

function showRecovery(root: HTMLElement, st: Status, done: Done): void {
  const rec = h('input', { type: 'text', autocomplete: 'off', spellcheck: false, required: true })
  const pw = h('input', { type: 'password', autocomplete: 'new-password', required: true })
  const m = meter()
  const err = errorBox()
  const btn = h('button', { class: 'btn primary', type: 'submit', text: 'Recuperar acesso' })
  pw.addEventListener('input', () => m.update(pw.value))
  const form = h(
    'form',
    { class: 'form' },
    field('Chave de recuperação', rec),
    field('Nova senha mestra', pw),
    m.el,
    err.el,
    btn,
    h('button', { class: 'link', type: 'button', text: 'Voltar', onclick: () => showUnlock(root, st, done) }),
  )
  form.addEventListener('submit', (ev) => {
    ev.preventDefault()
    if (pw.value.length < 10) return err.show('A senha mestra precisa ter pelo menos 10 caracteres.')
    void submitWith(btn, err, async () => {
      const secret = await api.unlockRecovery(rec.value, pw.value, true)
      showKeys(root, { secret_key: secret }, 'Acesso recuperado', false, done)
    })
  })
  card(root, 'Recuperar acesso', 'Informe a chave de recuperação e escolha uma nova senha. Será gerada uma nova chave secreta — atualize seus outros aparelhos.', form)
  rec.focus()
}
