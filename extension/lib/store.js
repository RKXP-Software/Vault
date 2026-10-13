// Armazenamento da extensão.
//  - chrome.storage.local (disco): pareamento (acesso ao Drive + chave secreta) e a cópia do cofre, que já é cifrada.
//  - chrome.storage.session (só memória; some ao fechar o navegador): a chave de dados da sessão desbloqueada.
// O navegador não tem DPAPI/Keystore: a chave secreta guardada aqui protege tanto quanto o perfil do navegador.
// A senha mestra nunca é guardada.

function toBase64(u8) {
  let s = ''
  const step = 0x8000
  for (let i = 0; i < u8.length; i += step) s += String.fromCharCode.apply(null, u8.subarray(i, i + step))
  return btoa(s)
}

function fromBase64(str) {
  const bin = atob(str)
  const u8 = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i)
  return u8
}

export async function getPair() {
  return (await chrome.storage.local.get('pair')).pair ?? null
}

export async function setPair(pair) {
  await chrome.storage.local.set({ pair })
}

export async function getVaultBytes() {
  const { vault } = await chrome.storage.local.get('vault')
  return vault ? { bytes: fromBase64(vault.b64), syncedAt: vault.syncedAt, revision: vault.revision ?? 0 } : null
}

/** Guarda a cópia baixada. A maior revisão já vista é mantida (detecta arquivo antigo no Drive). */
export async function setVaultBytes(bytes) {
  const { vault: prev } = await chrome.storage.local.get('vault')
  await chrome.storage.local.set({ vault: { b64: toBase64(bytes), syncedAt: Date.now(), revision: prev?.revision ?? 0 } })
}

export async function setRevision(revision) {
  const { vault } = await chrome.storage.local.get('vault')
  if (vault) await chrome.storage.local.set({ vault: { ...vault, revision } })
}

export async function getSessionKey() {
  const { session } = await chrome.storage.session.get('session')
  return session ? fromBase64(session) : null
}

export async function setSessionKey(key) {
  await chrome.storage.session.set({ session: toBase64(key) })
}

export async function clearSession() {
  await chrome.storage.session.remove('session')
}

/** Desfaz o pareamento: apaga acesso, chave secreta, cópia do cofre e sessão. */
export async function clearAll() {
  await chrome.storage.local.clear()
  await chrome.storage.session.clear()
}
