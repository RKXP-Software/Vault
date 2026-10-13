// APK de release do Android, assinado: gera a chave de assinatura na primeira vez, compila e copia
// o APK para distribuicao/v<versão>/.  Uso: npm run apk
//
// A chave fica FORA do repositório, em %USERPROFILE%\.vault\vault-release.jks, e a senha em
// src-tauri/gen/android/keystore.properties (também fora do git). GUARDE UMA CÓPIA da chave e da senha:
// sem elas não dá para atualizar o app que já está instalado (o Android recusa uma assinatura diferente).

import { execSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const version = JSON.parse(readFileSync('package.json', 'utf8')).version
const androidDir = join('src-tauri', 'gen', 'android')
const gradleFile = join(androidDir, 'app', 'build.gradle.kts')
const propsFile = join(androidDir, 'keystore.properties')
const keyDir = join(homedir(), '.vault')
const keyFile = join(keyDir, 'vault-release.jks')
const ALIAS = 'vault'

if (!existsSync(gradleFile)) {
  console.error('Projeto Android não encontrado. Rode antes: npx tauri android init')
  process.exit(1)
}

// 1. Chave de assinatura (só na primeira vez)
if (!existsSync(keyFile) || !existsSync(propsFile)) {
  if (existsSync(keyFile) !== existsSync(propsFile)) {
    console.error(`Estado inconsistente: ${keyFile} e ${propsFile} precisam existir juntos (ou nenhum dos dois).`)
    process.exit(1)
  }
  const javaHome = process.env.JAVA_HOME
  const keytool = javaHome ? join(javaHome, 'bin', 'keytool') : 'keytool'
  const password = randomBytes(24).toString('base64url')
  mkdirSync(keyDir, { recursive: true })
  execSync(
    `"${keytool}" -genkeypair -keystore "${keyFile}" -alias ${ALIAS} -keyalg RSA -keysize 4096 -validity 36500 ` +
      `-storepass ${password} -keypass ${password} -dname "CN=Vault, O=RKXP Software, C=BR"`,
    { stdio: 'inherit' },
  )
  writeFileSync(propsFile, `storeFile=${keyFile.replace(/\\/g, '/')}\nkeyAlias=${ALIAS}\npassword=${password}\n`)
  console.log(`\nChave de assinatura criada em ${keyFile}\n>>> FAÇA UMA CÓPIA dela e da senha (${propsFile}). Sem elas não há como atualizar o app instalado. <<<\n`)
}

// 2. Gradle: usa a chave no build de release (idempotente; o gen/ é regenerado por `tauri android init`)
const original = readFileSync(gradleFile, 'utf8')
const crlf = original.includes('\r\n') // no Windows o arquivo vem com CRLF: trabalha com \n e volta ao formato original
let gradle = original.replace(/\r\n/g, '\n')
if (!gradle.includes('keystoreProperties')) {
  gradle = gradle.replace(
    'android {\n',
    `// Assinatura do APK de release (scripts/apk.mjs): keystore.properties fica fora do git.
val keystoreProperties = Properties().apply {
    val propFile = rootProject.file("keystore.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

android {
    signingConfigs {
        if (keystoreProperties.containsKey("storeFile")) {
            create("release") {
                keyAlias = keystoreProperties["keyAlias"] as String
                keyPassword = keystoreProperties["password"] as String
                storeFile = file(keystoreProperties["storeFile"] as String)
                storePassword = keystoreProperties["password"] as String
            }
        }
    }
`,
  )
  gradle = gradle.replace(
    'getByName("release") {\n',
    'getByName("release") {\n            signingConfigs.findByName("release")?.let { signingConfig = it }\n',
  )
  if (!gradle.includes('keystoreProperties') || !gradle.includes('signingConfigs.findByName("release")')) {
    console.error('Não consegui configurar a assinatura em build.gradle.kts (o modelo do arquivo mudou?). Edite à mão, como no NOTEx.')
    process.exit(1)
  }
  writeFileSync(gradleFile, crlf ? gradle.replace(/\n/g, '\r\n') : gradle)
  console.log('build.gradle.kts: assinatura de release configurada')
}

// 3. Compila (só arm64: celulares atuais; acrescente --target armv7 para aparelhos 32 bits antigos)
execSync('npx tauri android build --apk --target aarch64', { stdio: 'inherit' })

const built = join(androidDir, 'app', 'build', 'outputs', 'apk', 'universal', 'release', 'app-universal-release.apk')
if (!existsSync(built)) {
  console.error(`APK assinado não encontrado em ${built} (o build saiu como "unsigned"? confira keystore.properties).`)
  process.exit(1)
}
const dest = join('distribuicao', `v${version}`)
mkdirSync(dest, { recursive: true })
const out = join(dest, `Vault-${version}-Android.apk`)
copyFileSync(built, out)
console.log(`\nAPK pronto: ${out}`)
