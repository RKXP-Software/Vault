// Documento invisível: o service worker não tem acesso à área de transferência.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== 'offscreen' || msg.type !== 'clear-clipboard') return
  const t = document.getElementById('t')
  t.value = ' '
  t.select()
  document.execCommand('copy') // copia um espaço: substitui a senha que estava na área de transferência
  t.value = ''
})
