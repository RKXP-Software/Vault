// Menu de preenchimento em linha: ao focar um campo de login, mostra os registros do Vault para este
// site logo abaixo do campo. Script de conteúdo (clássico, sem módulos), injetado nas páginas.
//
// Segurança:
//  - a interface fica num Shadow DOM fechado (a página não enxerga nem altera);
//  - só preenche com um clique/tecla REAL do usuário (`isTrusted`): a página não consegue disparar o preenchimento;
//  - nunca guarda a senha: ela chega do segundo plano só no instante do clique e é descartada;
//  - o segundo plano decide o que oferecer, pelo endereço que o navegador informa (não por este script).

;(() => {
  // Injetado duas vezes (manifesto + popup): só uma instância viva. Depois que a extensão é recarregada, o
  // script antigo continua na aba mas "órfão" (sem conexão): nesse caso o novo precisa assumir.
  if (window.__vaultContentAlive) {
    try {
      if (window.__vaultContentAlive()) return
    } catch {
      /* contexto invalidado: segue e assume */
    }
  }
  window.__vaultContentAlive = () => Boolean(chrome.runtime && chrome.runtime.id)

  const USERNAME_HINT = /user|usu[aá]rio|e-?mail|login|cpf|celular|phone|telefone|conta|account/i
  const SVG_NS = 'http://www.w3.org/2000/svg'

  // ------------------------------------------------------------ campos

  const visible = (el) => {
    const r = el.getBoundingClientRect()
    const s = getComputedStyle(el)
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && !el.disabled && !el.readOnly
  }

  /** querySelectorAll que também entra nos Shadow DOMs abertos (muitos sites usam web components). */
  function deepAll(selector, root = document) {
    const found = [...root.querySelectorAll(selector)]
    for (const el of root.querySelectorAll('*')) if (el.shadowRoot) found.push(...deepAll(selector, el.shadowRoot))
    return found
  }

  /** Elemento realmente focado, mesmo dentro de Shadow DOM aberto. */
  function deepActive() {
    let a = document.activeElement
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement
    return a
  }

  const visiblePasswords = () => deepAll('input[type="password"]').filter(visible)

  const visibleTextFields = () =>
    deepAll('input').filter((el) => {
      const t = (el.getAttribute('type') || 'text').toLowerCase()
      return ['text', 'email', 'tel', 'search', ''].includes(t) && visible(el)
    })

  /** Parece um campo de login (usuário/e-mail/senha)? */
  function isLoginField(el) {
    if (!(el instanceof HTMLInputElement) || el.disabled || el.readOnly) return false
    const type = (el.getAttribute('type') || 'text').toLowerCase()
    if (type === 'password') return true
    if (!['text', 'email', 'tel', ''].includes(type)) return false
    const ac = (el.getAttribute('autocomplete') || '').toLowerCase()
    if (ac.includes('username') || ac.includes('email')) return true
    const label = el.labels && el.labels[0] ? el.labels[0].textContent : ''
    const hint = [el.name, el.id, el.placeholder, el.getAttribute('aria-label'), label].join(' ')
    if (USERNAME_HINT.test(hint)) return true
    // Mesmo formulário (ou mesmo Shadow DOM) que um campo de senha: é um login.
    const root = el.getRootNode()
    const scope = el.form || (root instanceof ShadowRoot ? root : null)
    if (scope && scope.querySelector('input[type="password"]')) return true
    return type === 'email'
  }

  function setValue(el, value) {
    el.focus()
    // Frameworks (React etc.) só notam a mudança se o valor for definido pelo setter nativo e houver eventos.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }

  /**
   * Preenche usuário e senha. `target` é o campo em que o usuário clicou (ou null, quando o pedido vem
   * do popup): se for um campo de usuário, é ele que recebe o usuário; se for a senha, procura o campo
   * de usuário que vem antes dela.
   */
  function fill({ username, password }, target) {
    const passwords = visiblePasswords()
    const text = visibleTextFields()
    let userField = null

    if (target && target.type !== 'password') {
      userField = target
    } else if (passwords.length) {
      const pw = passwords[0]
      // Em Shadow DOMs diferentes a ordem do documento não vale: nesse caso considera os campos da mesma "raiz".
      const sameRoot = text.filter((el) => el.getRootNode() === pw.getRootNode())
      const before = sameRoot.filter((el) => el.compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING)
      const sameForm = pw.form ? before.filter((el) => el.form === pw.form) : before
      userField = (sameForm.length ? sameForm : before).at(-1) || null
    } else {
      const hints =
        'input[autocomplete="username"], input[type="email"], input[name*="user" i], input[name*="email" i], input[name*="login" i], input[id*="email" i], input[id*="user" i]'
      userField = deepAll(hints).find(visible) || text[0] || null
    }

    let filledUser = false
    let filledPass = false
    if (username && userField) {
      setValue(userField, username)
      filledUser = true
    }
    if (password && passwords.length) {
      setValue(passwords[0], password)
      filledPass = true
    }
    return { filledUser, filledPass }
  }

  // ------------------------------------------------------------ comunicação

  async function ask(msg) {
    try {
      return (await chrome.runtime.sendMessage(msg)) || { state: 'none' }
    } catch {
      return { state: 'none' } // extensão recarregada/atualizada: este script ficou órfão
    }
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return
    if (msg?.type === 'ping') sendResponse({ ok: true }) // o popup confere se o menu em linha está ativo nesta aba
    else if (msg?.type === 'fill') sendResponse(fill({ username: msg.username, password: msg.password }, null))
  })

  // ------------------------------------------------------------ interface (Shadow DOM)

  const CSS = `
    :host { all: initial; }
    .layer { position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;
      font: 13px/1.35 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; }
    .icon { position: fixed; width: 26px; height: 26px; padding: 3px; margin: 0; border: 0; border-radius: 6px;
      background: #1e1b4b; cursor: pointer; pointer-events: auto; display: none; box-shadow: 0 1px 4px #0006; }
    .icon:hover { background: #312e81; }
    .icon svg { display: block; width: 20px; height: 20px; }
    .menu { position: fixed; display: none; min-width: 300px; max-width: 460px; padding: 6px; border-radius: 12px;
      background: #151b23; color: #e6edf3; border: 1px solid #3d444d; box-shadow: 0 10px 28px #000b;
      pointer-events: auto; box-sizing: border-box; font-size: 14px; }
    .item { display: flex; align-items: center; gap: 12px; width: 100%; padding: 10px 12px; margin: 0; border: 0;
      border-radius: 9px; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
    .item:hover, .item:focus { background: #262c36; outline: none; }
    .avatar { flex: none; width: 34px; height: 34px; border-radius: 9px; background: #4493f8; color: #fff;
      display: grid; place-items: center; font-size: 15px; font-weight: 700; }
    .text { flex: 1; min-width: 0; }
    .name { font-size: 14.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sub { color: #9198a1; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .note { padding: 12px; color: #9198a1; line-height: 1.5; }
    .brand { display: flex; align-items: center; gap: 6px; padding: 6px 12px 4px; color: #9198a1; font-size: 12px; font-weight: 600; letter-spacing: .03em; }
  `

  let host = null
  let ui = null // { layer, icon, menu }
  let current = null // { input, state, items }
  let dismissedFor = null // campo em que o usuário fechou o menu (Esc)

  function lockSvg() {
    const svg = document.createElementNS(SVG_NS, 'svg')
    svg.setAttribute('viewBox', '0 0 256 256')
    const mk = (tag, attrs) => {
      const n = document.createElementNS(SVG_NS, tag)
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v)
      svg.append(n)
    }
    mk('path', { d: 'M88 120V92a40 40 0 0 1 80 0v28', fill: 'none', stroke: '#e2e8f0', 'stroke-width': '20', 'stroke-linecap': 'round' })
    mk('rect', { x: '60', y: '112', width: '136', height: '108', rx: '20', fill: '#fbbf24' })
    mk('circle', { cx: '128', cy: '157', r: '16', fill: '#1e1b4b' })
    mk('path', { d: 'M119 164h18l5 32h-28z', fill: '#1e1b4b' })
    return svg
  }

  function ensureUi() {
    if (ui) return ui
    host = document.createElement('div')
    const shadow = host.attachShadow({ mode: 'closed' })
    // Folha construída por script (não por <style>): não depende do CSP da página.
    const sheet = new CSSStyleSheet()
    sheet.replaceSync(CSS)
    shadow.adoptedStyleSheets = [sheet]

    const layer = document.createElement('div')
    layer.className = 'layer'
    const icon = document.createElement('button')
    icon.className = 'icon'
    icon.type = 'button'
    icon.setAttribute('aria-label', 'Vault: preencher login')
    icon.append(lockSvg())
    const menu = document.createElement('div')
    menu.className = 'menu'
    menu.setAttribute('role', 'menu')
    layer.append(icon, menu)
    shadow.append(layer)

    // Clicar no menu não pode tirar o foco do campo (senão o menu some antes do clique).
    layer.addEventListener('mousedown', (e) => e.preventDefault())
    icon.addEventListener('click', (e) => {
      if (!e.isTrusted || !current) return
      menu.style.display === 'block' ? closeMenu() : openMenu()
    })

    document.documentElement.append(host)
    ui = { layer, icon, menu }
    return ui
  }

  /** `el` é ancestral de `node`, atravessando Shadow DOMs (elementsFromPoint devolve o hospedeiro, não o campo interno). */
  function isAncestor(el, node) {
    for (let n = node; n; n = n.parentNode || n.host) if (n === el) return true
    return false
  }

  function place() {
    if (!ui || !current) return
    const r = current.input.getBoundingClientRect()
    const onScreen = r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth
    if (!onScreen || !current.input.isConnected) return hideAll()

    const size = 26
    const top = Math.round(r.top + (r.height - size) / 2)
    let left = Math.round(r.right - size - 8)
    // Se outra coisa (ex.: ícone de outro gerenciador) já ocupa o canto do campo, desloca para a esquerda.
    for (let i = 0; i < 3; i++) {
      const cx = left + size / 2
      const cy = top + size / 2
      const el = document.elementsFromPoint(cx, cy).find((n) => n !== host)
      if (!el || el === current.input || isAncestor(el, current.input)) break
      left -= size + 6
    }
    ui.icon.style.cssText = `display:block;left:${Math.max(0, left)}px;top:${top}px`

    if (ui.menu.style.display === 'block') {
      const menuH = ui.menu.offsetHeight
      const below = r.bottom + 4
      const fitsBelow = below + menuH < innerHeight
      const topPos = fitsBelow ? below : Math.max(4, r.top - menuH - 4)
      const width = Math.max(300, Math.min(r.width, 460))
      ui.menu.style.left = `${Math.max(4, Math.min(r.left, innerWidth - width - 4))}px`
      ui.menu.style.top = `${topPos}px`
      ui.menu.style.width = `${width}px`
    }
  }

  let frame = 0
  function schedulePlace() {
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(place)
  }

  function hideAll() {
    if (!ui) return
    ui.icon.style.display = 'none'
    closeMenu()
  }

  function closeMenu() {
    if (ui) ui.menu.style.display = 'none'
  }

  function row(item) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'item'
    b.setAttribute('role', 'menuitem')
    const avatar = document.createElement('span')
    avatar.className = 'avatar'
    avatar.textContent = (item.title || '?').trim().charAt(0).toUpperCase() || '?'
    const text = document.createElement('span')
    text.className = 'text'
    const name = document.createElement('div')
    name.className = 'name'
    name.textContent = item.username || item.email || item.title || '(sem usuário)'
    const sub = document.createElement('div')
    sub.className = 'sub'
    sub.textContent = item.title || ''
    text.append(name, sub)
    b.append(avatar, text)
    b.addEventListener('click', (e) => {
      if (!e.isTrusted) return // a página não pode simular o clique
      void choose(item)
    })
    return b
  }

  function openMenu() {
    if (!ui || !current) return
    ui.menu.replaceChildren()
    if (current.state === 'locked') {
      const note = document.createElement('div')
      note.className = 'note'
      note.textContent = 'Vault bloqueado. Clique no ícone do Vault na barra do navegador e digite a senha mestra.'
      ui.menu.append(note)
    } else {
      const brand = document.createElement('div')
      brand.className = 'brand'
      brand.textContent = 'Vault'
      ui.menu.append(brand, ...current.items.map(row))
    }
    ui.menu.style.display = 'block'
    place()
  }

  async function choose(item) {
    const target = current && current.input
    const cred = await ask({ type: 'credential', id: item.id })
    if (cred.error || !cred.password) return
    fill({ username: cred.username, password: cred.password }, target)
    cred.password = '' // não deixa a senha viva neste script
    hideAll()
  }

  // ------------------------------------------------------------ eventos da página

  async function onFocus(input) {
    if (!isLoginField(input)) return
    if (dismissedFor === input) return
    const res = await ask({ type: 'suggest' })
    if (deepActive() !== input) return // o foco já saiu enquanto esperava a resposta
    if (res.state === 'none') return hideAll()
    // Bloqueado: só avisa em campos de senha (em outros campos seria ruído em qualquer site).
    if (res.state === 'locked' && input.type !== 'password') return hideAll()
    current = { input, state: res.state, items: res.items || [] }
    ensureUi()
    place()
    if (res.state === 'ok') openMenu()
  }

  document.addEventListener(
    'focusin',
    (e) => {
      // `composedPath()[0]` é o campo de verdade mesmo dentro de Shadow DOM aberto (e.target viraria o hospedeiro).
      const t = e.composedPath()[0]
      if (t instanceof HTMLInputElement) void onFocus(t)
    },
    true,
  )

  document.addEventListener(
    'focusout',
    () => {
      // Dá tempo de um clique no menu (que mantém o foco) antes de esconder.
      setTimeout(() => {
        if (current && deepActive() !== current.input) hideAll()
      }, 150)
    },
    true,
  )

  document.addEventListener(
    'keydown',
    (e) => {
      if (!e.isTrusted || !current) return
      if (e.key === 'Escape' && ui && ui.menu.style.display === 'block') {
        dismissedFor = current.input
        closeMenu()
      } else if (e.key === 'ArrowDown' && ui && ui.menu.style.display === 'block') {
        ui.menu.querySelector('.item')?.focus()
        e.preventDefault()
      }
    },
    true,
  )

  // Digitar no campo fecha o menu: o usuário escolheu escrever sozinho.
  document.addEventListener(
    'input',
    (e) => {
      if (e.isTrusted && current && e.composedPath()[0] === current.input) closeMenu()
    },
    true,
  )

  addEventListener('scroll', schedulePlace, true)
  addEventListener('resize', schedulePlace)

  // Campo que já nasce focado (ex.: página de login com autofoco): o navegador nem sempre dispara
  // "focusin" nesse caso (principalmente se a janela ainda não tem o foco). Confere de novo depois
  // do carregamento e quando a janela ganha o foco.
  const startupCheck = () => {
    const a = deepActive()
    if (a instanceof HTMLInputElement && !(current && current.input === a && ui && ui.icon.style.display === 'block')) void onFocus(a)
  }
  const afterLoad = () => {
    setTimeout(startupCheck, 300)
    setTimeout(startupCheck, 1200)
  }
  if (document.readyState === 'complete') afterLoad()
  else addEventListener('load', afterLoad, { once: true })
  addEventListener('focus', startupCheck)
})()
