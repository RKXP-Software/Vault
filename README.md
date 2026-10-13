# Vault

Cofre de senhas cifrado para **Windows** e **Android** (Tauri 2 + TypeScript, núcleo em Rust).

Cada registro tem: título, e-mail, usuário, senha, site e observações (todos opcionais).

## Segurança

- Cifra: XChaCha20-Poly1305. Cada gravação usa um nonce novo.
- A chave de dados é aleatória e fica guardada em dois "slots" no cabeçalho:
  - **Senha mestra + chave secreta** → Argon2id (64 MiB, 3 passes), com a chave secreta como `secret` do Argon2.
  - **Chave de recuperação** → abre sem a senha (senha esquecida).
- Trocar a senha mestra não recifra o corpo.
- O cabeçalho inteiro é autenticado: qualquer alteração no arquivo falha na abertura.
- O arquivo não contém texto legível (nem títulos).
- Contador de revisão para detectar um arquivo que "voltou no tempo".
- Merge por registro (o mais recente vence), pronto para o sync.
- Bloqueio automático por inatividade (5 min), área de transferência limpa em 30 s.
- A chave secreta e o token do Drive guardados no aparelho são protegidos pelo DPAPI (Windows) ou pelo Android Keystore.
- Android: desbloqueio por biometria com chave do Keystore (BiometricPrompt + CryptoObject), invalidada se uma nova biometria for cadastrada.

**Sem a senha mestra e sem a chave de recuperação não há como recuperar o cofre.**

## Estrutura

```
core/        Biblioteca Rust: formato do cofre, criptografia, merge (cargo test)
src-tauri/   App Tauri (comandos, gravação atômica com .bak, DPAPI)
src/         Interface (TypeScript/Vite). src/dev/mock.ts só roda no `npm run dev` no navegador
```

## Comandos

```
npm install
npm run test:core     # testes do núcleo
npm run typecheck
npm run tauri dev     # app Windows
npx tauri android build --debug --apk --target aarch64   # APK de teste (interface embutida)
```

## Extensão do navegador (Chrome/Edge)

Independente do app: baixa o `cofre.vault` do Drive, abre no navegador com o mesmo núcleo em Rust
(compilado para WebAssembly, `core-wasm/`) e preenche logins. Somente leitura por enquanto.

```
npm run ext:build   # gera extension/config.js, extension/wasm/ e extension/icons/
npm run ext:test    # testes das partes puras (casar endereço, código de pareamento)
```

Instalar: `chrome://extensions` → Modo do desenvolvedor → Carregar sem compactação → pasta `extension/`.
Parear: no app do computador, ☁ Nuvem → Parear celular (QR) → Copiar código; cole no popup da extensão.

- **Menu em linha:** ao clicar num campo de login, aparece um menu abaixo do campo com os registros do site
  (`content.js`, Shadow DOM fechado). Só aceita clique/tecla real do usuário (`isTrusted`) e o segundo plano
  decide o que oferecer pelo endereço que o navegador informa. Exige a permissão "ler e alterar todos os sites".
- Para o registro aparecer no menu, o campo **Site** dele precisa ter o endereço (ex.: `https://max.com`).
- Preenche só quando o domínio registrável do registro é o da aba (nunca em site parecido) e em HTTPS.
- A chave de sessão fica só na memória do navegador (`chrome.storage.session`) e some em 15 min de inatividade.
- A chave secreta e a cópia cifrada do cofre ficam no perfil do navegador: ali não há DPAPI/Keystore.

## Google Drive

Escopo `drive.file` (só o arquivo `cofre.vault` criado pelo próprio app). Coloque as credenciais OAuth
(tipo "App para computador") em `src-tauri/google.secret.json` (ignorado pelo git):

```json
{ "client_id": "XXXX.apps.googleusercontent.com", "client_secret": "XXXX" }
```

O JSON baixado do Google Cloud Console também serve como está. O sync baixa o arquivo, junta por registro
(o mais recente vence), grava e envia de volta. Páginas de privacidade/termos para a tela de consentimento
estão em `site/` (publicar no GitHub Pages).

## Ainda não feito

- Testar o sync com o Google Drive de ponta a ponta (código pronto; falta o primeiro login real).
- Android: Autofill Service (Kotlin) e APK de release assinado (hoje só APK de depuração).
- Windows Hello (desbloqueio rápido no desktop).
- Extensão: salvar senhas novas, Firefox, publicar na Chrome Web Store.
- Ícone próprio (os atuais são cópia do NOTEx).
