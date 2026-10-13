import { api, emptyData, type Entry, type EntryData, type Item } from '../api'
import { clear, copySecret, errText, h, toast } from '../dom'
import { defaultGen, generate, strength, strengthLabel, type GenOptions } from '../gen'
import { createSync } from './cloud'
import { showSecurityDialog } from './security'

interface Hooks {
  onLock(): void
  /** A senha mestra foi trocada em outro aparelho: o backend já trancou o cofre. */
  onRemoteCredentials(): void
  toggleTheme(): void
  idleMinutes: number
}

type Mode = { kind: 'empty' } | { kind: 'view'; entry: Entry } | { kind: 'edit'; entry: Entry | null }

/** Monta a tela do cofre. Devolve a função que desfaz timers e listeners ao bloquear. */
export function mountVault(root: HTMLElement, hooks: Hooks): () => void {
  let items: Item[] = []
  let selected: string | null = null
  let query = ''
  let mode: Mode = { kind: 'empty' }

  const search = h('input', { type: 'search', placeholder: 'Buscar…', 'aria-label': 'Buscar registros', autocomplete: 'off' })
  const list = h('div', { class: 'list', role: 'listbox', 'aria-label': 'Registros' })
  const detail = h('main', { class: 'detail' })
  const count = h('span', { id: 'st-count' })
  const cloud = h('span', { id: 'st-cloud' })
  const sync = createSync(cloud, hooks.onRemoteCredentials)
  const body = h('div', { id: 'body' }, h('aside', { id: 'sidebar' }, list), detail)

  const toolbar = h(
    'header',
    { class: 'toolbar', role: 'toolbar' },
    h('span', { class: 'tb-brand' }, h('img', { class: 'brand-icon', src: '/icon.svg', alt: '' }), 'Vault'),
    search,
    h('button', { class: 'btn primary', text: '+ Novo', onclick: () => startEdit(null) }),
    h('span', { class: 'spacer' }),
    h(
      'button',
      { class: 'btn', title: 'Sincronização com o Google Drive', onclick: () => sync.openDialog() },
      '☁',
      h('span', { class: 'btn-label', text: 'Nuvem' }),
    ),
    h('button', {
      class: 'btn icon',
      title: 'Segurança: biometria e senha mestra',
      'aria-label': 'Segurança',
      text: '⚙',
      onclick: () => void showSecurityDialog(() => sync.schedule(), hooks.toggleTheme),
    }),
    h('button', { class: 'btn', title: 'Bloquear agora', onclick: hooks.onLock }, '🔒', h('span', { class: 'btn-label', text: 'Bloquear' })),
  )
  const status = h(
    'footer',
    { class: 'statusbar' },
    count,
    cloud,
    h('span', { class: 'spacer' }),
    h(
      'span',
      { class: 'st-lock', title: `Bloqueia sozinho depois de ${hooks.idleMinutes} min sem uso` },
      h('span', { class: 'st-long', text: `Bloqueio automático: ${hooks.idleMinutes} min sem uso` }),
      h('span', { class: 'st-short', text: `🔒 ${hooks.idleMinutes} min` }),
    ),
  )
  clear(root)
  root.append(h('div', { id: 'app-main' }, toolbar, body, status))

  let t = 0
  search.addEventListener('input', () => {
    clearTimeout(t)
    t = window.setTimeout(() => {
      query = search.value
      void refresh()
    }, 120)
  })

  async function refresh(): Promise<void> {
    items = await api.list(query)
    count.textContent = `${items.length} ${items.length === 1 ? 'registro' : 'registros'}`
    renderList()
  }

  function renderList(): void {
    clear(list)
    if (!items.length) {
      list.append(h('div', { class: 'empty-list', text: query ? 'Nada encontrado.' : 'Nenhum registro ainda. Clique em "+ Novo".' }))
      return
    }
    for (const it of items) {
      const sub = it.username || it.email || it.url
      list.append(
        h(
          'button',
          { class: `row${it.id === selected ? ' active' : ''}`, role: 'option', 'aria-selected': it.id === selected, onclick: () => void open(it.id) },
          h('span', { class: 'avatar', text: (it.title || '?').trim().charAt(0).toUpperCase() || '?' }),
          h('span', { class: 'row-text' }, h('span', { class: 'row-title', text: it.title || '(sem título)' }), h('span', { class: 'row-sub', text: sub })),
        ),
      )
    }
  }

  function setMode(m: Mode): void {
    mode = m
    body.classList.toggle('show-detail', m.kind !== 'empty')
    renderDetail()
  }

  async function open(id: string): Promise<void> {
    try {
      const entry = await api.get(id)
      selected = id
      renderList()
      setMode({ kind: 'view', entry })
    } catch (e) {
      toast(errText(e), 'err')
    }
  }

  function startEdit(entry: Entry | null): void {
    selected = entry?.id ?? null
    renderList()
    setMode({ kind: 'edit', entry })
  }

  function backBtn(): HTMLElement {
    return h('button', {
      class: 'btn back',
      text: '← Voltar',
      onclick: () => {
        selected = null
        renderList()
        setMode({ kind: 'empty' })
      },
    })
  }

  function renderDetail(): void {
    clear(detail)
    if (mode.kind === 'empty') {
      detail.append(h('div', { class: 'empty' }, h('img', { class: 'empty-icon', src: '/icon.svg', alt: '' }), h('p', { text: 'Selecione um registro ou crie um novo.' })))
    } else if (mode.kind === 'view') {
      detail.append(backBtn(), viewPane(mode.entry))
    } else {
      detail.append(backBtn(), editPane(mode.entry))
    }
  }

  function viewRow(label: string, value: string, opts: { secret?: boolean; link?: boolean; multiline?: boolean } = {}): HTMLElement | null {
    if (!value) return null
    const shown = h('span', { class: `val${opts.multiline ? ' pre' : ''}${opts.secret ? ' mono' : ''}`, text: opts.secret ? '••••••••••••' : value })
    const actions = h('span', { class: 'row-actions' })
    if (opts.secret) {
      let visible = false
      actions.append(
        h('button', {
          class: 'btn small',
          text: 'Mostrar',
          onclick: (ev: Event) => {
            visible = !visible
            shown.textContent = visible ? value : '••••••••••••'
            ;(ev.currentTarget as HTMLElement).textContent = visible ? 'Ocultar' : 'Mostrar'
          },
        }),
      )
    }
    actions.append(h('button', { class: 'btn small', text: 'Copiar', onclick: () => copySecret(value, label) }))
    return h('div', { class: 'info' }, h('div', { class: 'lbl', text: label }), h('div', { class: 'info-line' }, shown, actions))
  }

  function viewPane(e: Entry): HTMLElement {
    const d = e.data
    return h(
      'section',
      { class: 'pane' },
      h(
        'div',
        { class: 'pane-head' },
        h('h2', { text: d.title || '(sem título)' }),
        h(
          'span',
          { class: 'row-actions' },
          h('button', { class: 'btn', text: 'Editar', onclick: () => startEdit(e) }),
          h('button', { class: 'btn danger', text: 'Excluir', onclick: () => void remove(e) }),
        ),
      ),
      viewRow('E-mail', d.email),
      viewRow('Usuário', d.username),
      viewRow('Senha', d.password, { secret: true }),
      viewRow('Site', d.url),
      viewRow('Observações', d.notes, { multiline: true }),
      h('div', { class: 'meta', text: `Atualizado em ${new Date(e.updated_at * 1000).toLocaleString('pt-BR')}` }),
    )
  }

  async function remove(e: Entry): Promise<void> {
    if (!confirm(`Excluir "${e.data.title || 'sem título'}"? Isso também apaga nos outros aparelhos.`)) return
    try {
      await api.remove(e.id)
      selected = null
      setMode({ kind: 'empty' })
      await refresh()
      sync.schedule()
      toast('Registro excluído')
    } catch (err) {
      toast(errText(err), 'err')
    }
  }

  function editPane(entry: Entry | null): HTMLElement {
    const d: EntryData = entry ? { ...entry.data } : emptyData()
    const inp = (key: keyof EntryData, label: string, extra: Record<string, unknown> = {}) => {
      const el = h('input', { type: 'text', value: d[key], autocomplete: 'off', spellcheck: false, ...extra })
      el.addEventListener('input', () => (d[key] = el.value))
      return { el, wrap: h('label', { class: 'field' }, h('span', { class: 'lbl', text: label }), el) }
    }
    const title = inp('title', 'Título', { placeholder: 'Ex.: Google Drive' })
    const email = inp('email', 'E-mail', { type: 'email', inputmode: 'email' })
    const user = inp('username', 'Usuário')
    const url = inp('url', 'Site', { placeholder: 'https://' })
    const pass = inp('password', 'Senha', { type: 'password', autocomplete: 'new-password' })
    const notes = h('textarea', { rows: 5, value: d.notes, spellcheck: false })
    notes.addEventListener('input', () => (d.notes = notes.value))

    const bar = h('div', { class: 'meter-bar' })
    const barTxt = h('span', { class: 'meter-txt' })
    const updateMeter = () => {
      const s = strength(d.password)
      bar.dataset.lvl = String(s)
      bar.style.setProperty('--lvl', String(s))
      barTxt.textContent = d.password ? strengthLabel[s] : ''
    }
    pass.el.addEventListener('input', updateMeter)
    updateMeter()

    const gen: GenOptions = { ...defaultGen }
    const lenOut = h('span', { class: 'gen-len', text: String(gen.length) })
    const range = h('input', { type: 'range', min: 8, max: 64, value: gen.length, 'aria-label': 'Tamanho da senha' })
    range.addEventListener('input', () => {
      gen.length = Number(range.value)
      lenOut.textContent = range.value
    })
    const opt = (k: 'lower' | 'upper' | 'digits' | 'symbols', label: string) => {
      const c = h('input', { type: 'checkbox', checked: gen[k] })
      c.addEventListener('change', () => (gen[k] = c.checked))
      return h('label', { class: 'check inline' }, c, h('span', { text: label }))
    }
    const fillGenerated = () => {
      const p = generate(gen)
      if (!p) return toast('Marque ao menos um tipo de caractere', 'err')
      d.password = p
      pass.el.value = p
      pass.el.type = 'text'
      updateMeter()
    }
    const genBox = h(
      'div',
      { class: 'gen' },
      h('div', { class: 'gen-row' }, range, lenOut),
      h('div', { class: 'gen-row wrap' }, opt('lower', 'a-z'), opt('upper', 'A-Z'), opt('digits', '0-9'), opt('symbols', '#$%')),
    )

    const err = h('div', { class: 'form-error', role: 'alert', hidden: true })
    const saveBtn = h('button', { class: 'btn primary', type: 'submit', text: 'Salvar' })
    const form = h(
      'form',
      { class: 'form pane', novalidate: true },
      h('div', { class: 'pane-head' }, h('h2', { text: entry ? 'Editar registro' : 'Novo registro' })),
      title.wrap,
      email.wrap,
      user.wrap,
      h(
        'div',
        { class: 'field' },
        pass.wrap,
        h('div', { class: 'meter' }, bar, barTxt),
        h(
          'div',
          { class: 'row-actions left' },
          h('button', { class: 'btn small', type: 'button', text: 'Gerar', onclick: fillGenerated }),
          h('button', {
            class: 'btn small',
            type: 'button',
            text: 'Mostrar/ocultar',
            onclick: () => (pass.el.type = pass.el.type === 'password' ? 'text' : 'password'),
          }),
        ),
        genBox,
      ),
      url.wrap,
      h('label', { class: 'field' }, h('span', { class: 'lbl', text: 'Observações' }), notes),
      err,
      h(
        'div',
        { class: 'actions' },
        saveBtn,
        h('button', {
          class: 'btn',
          type: 'button',
          text: 'Cancelar',
          onclick: () => (entry ? void open(entry.id) : setMode({ kind: 'empty' })),
        }),
      ),
    )
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault()
      if (!Object.values(d).some((v) => v.trim())) {
        err.hidden = false
        err.textContent = 'Preencha ao menos um campo.'
        return
      }
      saveBtn.disabled = true
      try {
        const id = await api.save(entry?.id ?? null, d)
        await refresh()
        await open(id)
        sync.schedule()
        toast('Salvo')
      } catch (e) {
        err.hidden = false
        err.textContent = errText(e)
        saveBtn.disabled = false
      }
    })
    queueMicrotask(() => title.el.focus())
    return form
  }

  renderDetail()
  void refresh().then(() => sync.run())
  return () => sync.dispose()
}
