// Código de pareamento gerado pelo app do computador (☁ Nuvem → Parear celular): "vault1:" + base64url(JSON).
// O JSON tem o acesso ao Drive (rt) e a chave secreta (sk). A senha mestra nunca vai nele.

const PREFIX = 'vault1:'
const TTL_SECONDS = 600

function fromBase64Url(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))
}

/** Valida e decodifica o código. Lança Error com mensagem pronta para mostrar ao usuário. */
export function parsePairCode(code) {
  const text = String(code || '').trim()
  if (!text.startsWith(PREFIX)) throw new Error('Código de pareamento inválido.')
  let data
  try {
    data = JSON.parse(fromBase64Url(text.slice(PREFIX.length)))
  } catch {
    throw new Error('Código de pareamento inválido.')
  }
  if (!data || typeof data.rt !== 'string' || typeof data.sk !== 'string' || typeof data.t !== 'number') {
    throw new Error('Código de pareamento inválido.')
  }
  if (Date.now() / 1000 - data.t > TTL_SECONDS) throw new Error('O código expirou. Gere um novo no computador.')
  return { refreshToken: data.rt, secretKey: data.sk }
}
