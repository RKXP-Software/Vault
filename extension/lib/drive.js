// Google Drive pela API REST (somente leitura). Mesmo cliente OAuth do app; escopo drive.file:
// só enxerga o arquivo que o próprio Vault criou. O que sai do Drive já está cifrado.

import { GOOGLE } from '../config.js'

const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const API = 'https://www.googleapis.com/drive/v3'
const FILE_NAME = 'cofre.vault'
const MAX_BYTES = 64 * 1024 * 1024

export const REVOKED = 'O acesso ao Google Drive foi revogado ou expirou. Pareie de novo com um código novo do computador.'

let cached = null // { token, until }

async function accessToken(refreshToken) {
  if (cached && Date.now() < cached.until) return cached.token
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    body: new URLSearchParams({
      client_id: GOOGLE.clientId,
      client_secret: GOOGLE.clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  }).catch(() => {
    throw new Error('Sem conexão com o Google.')
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    if (json.error === 'invalid_grant') throw new Error(REVOKED)
    throw new Error(`O Google recusou o acesso: ${json.error_description || json.error || res.status}`)
  }
  cached = { token: json.access_token, until: Date.now() + Math.max(60, (json.expires_in || 3600) - 120) * 1000 }
  return cached.token
}

async function api(refreshToken, path, init) {
  const token = await accessToken(refreshToken)
  const res = await fetch(`${API}${path}`, { ...init, headers: { Authorization: `Bearer ${token}` } }).catch(() => {
    throw new Error('Sem conexão com o Google Drive.')
  })
  if (res.status === 401) cached = null
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(`Google Drive respondeu ${res.status}: ${body?.error?.message || 'erro'}`)
  }
  return res
}

export async function userEmail(refreshToken) {
  const res = await api(refreshToken, '/about?fields=user(emailAddress)')
  return (await res.json()).user?.emailAddress || ''
}

/** Baixa o cofre (bytes cifrados). Devolve null se ainda não existe no Drive. */
export async function downloadVault(refreshToken) {
  const q = `appProperties has { key='app' and value='vault' } and name='${FILE_NAME}' and trashed=false`
  const list = await api(
    refreshToken,
    `/files?q=${encodeURIComponent(q)}&fields=${encodeURIComponent('files(id)')}&orderBy=createdTime&pageSize=10&spaces=drive`,
  )
  const id = (await list.json()).files?.[0]?.id
  if (!id) return null
  const res = await api(refreshToken, `/files/${encodeURIComponent(id)}?alt=media`)
  const buf = await res.arrayBuffer()
  if (buf.byteLength > MAX_BYTES) throw new Error('Arquivo no Drive grande demais para ser um cofre.')
  const bytes = new Uint8Array(buf)
  // "PVLT" = assinatura do arquivo de cofre.
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x56 || bytes[2] !== 0x4c || bytes[3] !== 0x54) {
    throw new Error('O arquivo no Drive não é um cofre do Vault.')
  }
  return bytes
}
