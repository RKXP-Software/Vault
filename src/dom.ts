type Child = Node | string | null | false | undefined

/** Cria um elemento. `class`, `text`, `on*` e `value` têm tratamento próprio; o resto vira atributo. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  ...kids: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue
    if (k === 'class') el.className = String(v)
    else if (k === 'text') el.textContent = String(v)
    else if (k === 'value') (el as unknown as HTMLInputElement).value = String(v)
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v as EventListener)
    else el.setAttribute(k, v === true ? '' : String(v))
  }
  for (const c of kids) if (c) el.append(c)
  return el
}

export function clear(el: Element): void {
  el.replaceChildren()
}

export function errText(e: unknown): string {
  return typeof e === 'string' ? e : e instanceof Error ? e.message : 'erro inesperado'
}

let toastTimer = 0
export function toast(msg: string, kind: 'ok' | 'err' = 'ok'): void {
  document.querySelector('.toast')?.remove()
  const t = h('div', { class: `toast ${kind}`, role: 'status', text: msg })
  document.body.append(t)
  clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => t.remove(), 2600)
}

const CLIPBOARD_CLEAR_MS = 30_000
let clipTimer = 0
/** Copia e limpa a área de transferência depois de 30 s. */
export async function copySecret(text: string, label: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    toast('Não foi possível copiar', 'err')
    return
  }
  toast(`${label} copiado — limpa em 30 s`)
  clearTimeout(clipTimer)
  clipTimer = window.setTimeout(() => navigator.clipboard.writeText('').catch(() => {}), CLIPBOARD_CLEAR_MS)
}
