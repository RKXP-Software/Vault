// Decide se um registro (campo "site") pertence à aba atual. Preencher no site errado entrega a senha
// a quem não deve, então a regra é conservadora: o domínio registrável tem que ser o mesmo.

// Sufixos de dois níveis comuns (não é a lista pública completa; o que faltar cai na regra de 2 rótulos).
const TWO_LEVEL = new Set([
  'com.br', 'net.br', 'org.br', 'gov.br', 'edu.br', 'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au',
  'org.au', 'co.jp', 'co.nz', 'com.ar', 'com.mx', 'co.in', 'com.cn', 'com.tr', 'co.za', 'com.pt',
])

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/

export function hostOf(url) {
  const text = String(url || '').trim()
  if (!text) return ''
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`).hostname.toLowerCase()
  } catch {
    return ''
  }
}

export function baseDomain(host) {
  const h = host.replace(/^www\./, '')
  if (!h.includes('.') || IPV4.test(h) || h.includes(':')) return h
  const parts = h.split('.')
  if (parts.length <= 2) return h
  return TWO_LEVEL.has(parts.slice(-2).join('.')) ? parts.slice(-3).join('.') : parts.slice(-2).join('.')
}

export function matchesUrl(entryUrl, tabUrl) {
  const e = hostOf(entryUrl)
  const t = hostOf(tabUrl)
  return Boolean(e && t && baseDomain(e) === baseDomain(t))
}

/** Só preenche automaticamente em páginas seguras (https) ou no próprio computador (desenvolvimento). */
export function isSecurePage(tabUrl) {
  try {
    const u = new URL(tabUrl)
    return u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname))
  } catch {
    return false
  }
}
