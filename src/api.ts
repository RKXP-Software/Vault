// Ponte com o backend Rust. Fora do Tauri (só `npm run dev` no navegador) usa um mock em memória.

export interface Status {
  exists: boolean
  unlocked: boolean
  secret_on_device: boolean
}
export interface Keys {
  secret_key: string
  recovery_key: string
}
export interface Item {
  id: string
  title: string
  url: string
  email: string
  username: string
  updated_at: number
}
export interface EntryData {
  title: string
  url: string
  email: string
  username: string
  password: string
  notes: string
}
export interface Entry {
  id: string
  data: EntryData
  created_at: number
  updated_at: number
}

export interface BioInfo {
  /** O aparelho tem biometria forte cadastrada. */
  available: boolean
  /** O desbloqueio por biometria está ativo neste cofre. */
  enabled: boolean
}
export interface DriveInfo {
  available: boolean
  connected: boolean
  email: string
}
export interface PairCode {
  code: string
  svg: string
  expires_in: number
}
export interface SyncResult {
  credentials_changed: boolean
  at: number
}

export const emptyData = (): EntryData => ({ title: '', url: '', email: '', username: '', password: '', notes: '' })

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>

async function loadInvoke(): Promise<Invoke> {
  if ('__TAURI_INTERNALS__' in window) {
    const { invoke } = await import('@tauri-apps/api/core')
    return invoke as Invoke
  }
  if (import.meta.env.DEV) {
    const { mockInvoke } = await import('./dev/mock')
    return mockInvoke
  }
  throw new Error('backend indisponível')
}

let invokeP: Promise<Invoke> | null = null
async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  invokeP ??= loadInvoke()
  return (await (await invokeP)(cmd, args)) as T
}

export const api = {
  status: () => call<Status>('status'),
  createVault: (password: string, remember: boolean) => call<Keys>('create_vault', { password, remember }),
  unlock: (password: string, secretKey: string | null, remember: boolean) =>
    call<void>('unlock', { password, secretKey, remember }),
  unlockRecovery: (recoveryKey: string, newPassword: string, remember: boolean) =>
    call<string>('unlock_recovery', { recoveryKey, newPassword, remember }),
  lock: () => call<void>('lock'),
  forgetDeviceKey: () => call<void>('forget_device_key'),
  list: (query: string) => call<Item[]>('list_entries', { query }),
  get: (id: string) => call<Entry>('get_entry', { id }),
  save: (id: string | null, data: EntryData) => call<string>('save_entry', { id, data }),
  remove: (id: string) => call<void>('delete_entry', { id }),
  changePassword: (current: string, newPassword: string, secretKey: string | null) =>
    call<void>('change_password', { current, newPassword, secretKey }),
  bioInfo: () => call<BioInfo>('bio_info'),
  bioEnable: () => call<void>('bio_enable'),
  bioUnlock: () => call<void>('bio_unlock'),
  bioDisable: () => call<void>('bio_disable'),
  driveInfo: () => call<DriveInfo>('drive_info'),
  driveConnect: () => call<string>('drive_connect'),
  driveCancel: () => call<void>('drive_cancel'),
  drivePasteLogin: (url: string) => call<void>('drive_paste_login', { url }),
  driveDisconnect: () => call<void>('drive_disconnect'),
  drivePull: () => call<void>('drive_pull'),
  pairCode: () => call<PairCode>('pair_code'),
  pairApply: (code: string) => call<{ pulled: boolean }>('pair_apply', { code }),
  syncNow: () => call<SyncResult>('sync_now'),
}
