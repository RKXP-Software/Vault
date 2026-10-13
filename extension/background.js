// Service worker: responde ao menu em linha, bloqueia a sessão por inatividade e limpa a área de
// transferência depois de copiar.

import { handleRequest } from './lib/suggest.js'

const LOCK_ALARM = 'vault-lock'
const CLIP_ALARM = 'vault-clip'
const IDLE_MINUTES = 15
const CLIP_DELAY_MINUTES = 0.5 // 30 s (mínimo que o Chrome aceita em alarmes)

async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })
  if (existing.length) return
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['CLIPBOARD'],
    justification: 'Limpar a área de transferência depois de copiar uma senha.',
  })
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target === 'offscreen') return
  if (msg?.type === 'session-touch') chrome.alarms.create(LOCK_ALARM, { delayInMinutes: IDLE_MINUTES })
  if (msg?.type === 'clip-clear') chrome.alarms.create(CLIP_ALARM, { delayInMinutes: CLIP_DELAY_MINUTES })

  if (msg?.type === 'suggest' || msg?.type === 'credential') {
    handleRequest(msg, sender)
      .then((res) => {
        if (msg.type === 'credential' && res.password) chrome.alarms.create(LOCK_ALARM, { delayInMinutes: IDLE_MINUTES })
        sendResponse(res)
      })
      .catch(() => sendResponse({ state: 'none' }))
    return true // resposta assíncrona
  }
})

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === LOCK_ALARM) {
    await chrome.storage.session.remove('session')
  } else if (alarm.name === CLIP_ALARM) {
    await ensureOffscreen()
    chrome.runtime.sendMessage({ target: 'offscreen', type: 'clear-clipboard' })
  }
})
