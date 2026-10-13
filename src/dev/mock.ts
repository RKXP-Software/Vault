// Backend falso para desenvolver a interface no navegador. Não cifra nada — nunca vai para o app real.
import type { Entry, EntryData } from '../api'

const state = {
  exists: false,
  unlocked: false,
  password: '',
  remember: false,
  entries: new Map<string, Entry>(),
}
const drive = { connected: false }
const bio = { enabled: false }
const SECRET ='ABCDE-FGHIJ-KLMNO-PQRST-UV'
const RECOVERY = 'AAAAA-BBBBB-CCCCC-DDDDD-EEEEE-FFFFF-GGGGG-HHHHH-IIIII-JJJJJ-KKKKK'

function seed() {
  const now = Math.floor(Date.now() / 1000)
  const mk = (data: Partial<EntryData>) => {
    const id = crypto.randomUUID()
    state.entries.set(id, {
      id,
      data: { title: '', url: '', email: '', username: '', password: '', notes: '', ...data },
      created_at: now,
      updated_at: now,
    })
  }
  mk({ title: 'Google Drive', email: 'abc@123.com', password: 'senha-falsa-1', notes: 'teste 123' })
  mk({ title: 'GitHub', url: 'https://github.com', username: 'pedro', email: 'eu@exemplo.com', password: 'senha-falsa-2' })
}

export async function mockInvoke(cmd: string, a: Record<string, unknown> = {}): Promise<unknown> {
  await new Promise((r) => setTimeout(r, 120))
  switch (cmd) {
    case 'status':
      return { exists: state.exists, unlocked: state.unlocked, secret_on_device: state.remember }
    case 'create_vault':
      state.exists = state.unlocked = true
      state.password = a.password as string
      state.remember = a.remember as boolean
      seed()
      return { secret_key: SECRET, recovery_key: RECOVERY }
    case 'unlock':
      if (a.password !== state.password) throw 'senha mestra, chave secreta ou chave de recuperação incorretas, ou arquivo corrompido'
      state.unlocked = true
      return null
    case 'unlock_recovery':
      state.password = a.newPassword as string
      state.unlocked = true
      return SECRET
    case 'lock':
      state.unlocked = false
      return null
    case 'forget_device_key':
      state.remember = false
      return null
    case 'list_entries': {
      const q = (a.query as string).toLowerCase()
      return [...state.entries.values()]
        .filter((e) => !q || [e.data.title, e.data.url, e.data.email, e.data.username].some((f) => f.toLowerCase().includes(q)))
        .sort((x, y) => x.data.title.localeCompare(y.data.title))
        .map((e) => ({ id: e.id, ...e.data, updated_at: e.updated_at }))
    }
    case 'get_entry':
      return state.entries.get(a.id as string)
    case 'save_entry': {
      const now = Math.floor(Date.now() / 1000)
      const id = (a.id as string | null) ?? crypto.randomUUID()
      const old = state.entries.get(id)
      state.entries.set(id, { id, data: a.data as EntryData, created_at: old?.created_at ?? now, updated_at: now })
      return id
    }
    case 'delete_entry':
      state.entries.delete(a.id as string)
      return null
    case 'change_password':
      if (a.current !== state.password) throw 'Senha atual ou chave secreta incorreta.'
      state.password = a.newPassword as string
      return null
    case 'bio_info':
      return { available: true, enabled: bio.enabled }
    case 'bio_enable':
      bio.enabled = true
      return null
    case 'bio_unlock':
      if (!bio.enabled) throw 'A biometria não está ativada.'
      state.unlocked = true
      return null
    case 'bio_disable':
      bio.enabled = false
      return null
    case 'drive_info':
      return { available: true, connected: drive.connected, email: drive.connected ? 'demo@exemplo.com' : '' }
    case 'drive_connect':
      drive.connected = true
      return 'demo@exemplo.com'
    case 'pair_code':
      return {
        code: 'vault1:DEMO',
        expires_in: 600,
        svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 9 9" width="280" height="280"><rect width="9" height="9" fill="#fff"/><path d="M1 1h3v3H1zM5 1h3v3H5zM1 5h3v3H1zM5 5h1v1H5zM7 6h1v2H7zM5 7h1v1H5z" fill="#000"/></svg>',
      }
    case 'pair_apply':
      return { pulled: false }
    case 'drive_cancel':
    case 'drive_paste_login':
      return null
    case 'drive_disconnect':
      drive.connected = false
      return null
    case 'drive_pull':
      throw 'Nenhum cofre do Vault foi encontrado neste Google Drive.'
    case 'sync_now':
      if (!drive.connected) throw 'Conecte o Google Drive primeiro.'
      return { credentials_changed: false, at: Math.floor(Date.now() / 1000) }
  }
  throw `comando desconhecido: ${cmd}`
}
