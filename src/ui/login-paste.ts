import { api } from '../api'
import { errText, h, toast } from '../dom'

/**
 * Plano B do login do Google: no Android o sistema pausa o app enquanto o navegador está na frente, e
 * a volta para o app falha ("Não é possível acessar esse site"). O usuário copia o endereço da barra
 * do navegador e cola aqui; o app termina o login com o código que está nele.
 */
export function loginPasteBox(): HTMLElement {
  const input = h('input', {
    type: 'text',
    placeholder: 'http://127.0.0.1:…/?state=…&code=…',
    autocomplete: 'off',
    spellcheck: false,
    'aria-label': 'Endereço da página de retorno do login',
  })
  const send = h('button', { class: 'btn small', type: 'button', text: 'Enviar' })
  send.addEventListener('click', async () => {
    const url = input.value.trim()
    if (!url) return
    send.disabled = true
    try {
      await api.drivePasteLogin(url)
      input.value = ''
      toast('Endereço enviado, concluindo o login…')
    } catch (e) {
      toast(errText(e), 'err')
    } finally {
      send.disabled = false
    }
  })
  return h(
    'div',
    { class: 'paste-box' },
    h('p', {
      class: 'hint',
      text: 'Se o navegador mostrar "Não é possível acessar esse site" depois do login, copie o endereço da barra (começa com http://127.0.0.1) e cole aqui:',
    }),
    h('div', { class: 'paste-row' }, input, send),
  )
}
