package com.rkxp.vault.keystore

import android.app.Activity
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.security.keystore.KeyPermanentlyInvalidatedException
import androidx.appcompat.app.AppCompatActivity
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import java.util.concurrent.Executor
import javax.crypto.Cipher

/**
 * Tela transparente que mostra o BiometricPrompt com CryptoObject: a chave do Keystore só
 * opera (cifrar/decifrar) depois que a biometria for aceita. Entrada e saída ficam em `Pending`.
 */
class KeystoreActivity : AppCompatActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.keystore_activity)

        val sealing = Pending.mode == "seal"
        val input = Pending.input
        if (input == null) {
            finishWithError("[error] Sem dados.")
            return
        }

        val cipher: Cipher = try {
            if (sealing) KeystoreCrypto.bioEncryptCipher() else KeystoreCrypto.bioDecryptCipher(input)
        } catch (e: KeyPermanentlyInvalidatedException) {
            finishWithError("[invalidated] A biometria do aparelho mudou. Entre com a senha mestra.")
            return
        } catch (e: Exception) {
            finishWithError("[invalidated] Chave biométrica indisponível: ${e.message}")
            return
        }

        val executor: Executor = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            mainExecutor
        } else {
            Executor { command -> Handler(mainLooper).post(command) }
        }

        val info = BiometricPrompt.PromptInfo.Builder()
            .setTitle("Vault")
            .setSubtitle(if (sealing) "Confirme para ativar o desbloqueio por biometria" else "Desbloquear o cofre")
            .setNegativeButtonText("Usar a senha")
            .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
            .setConfirmationRequired(false)
            .build()

        val prompt = BiometricPrompt(this, executor, object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                val cancelled = errorCode == BiometricPrompt.ERROR_NEGATIVE_BUTTON ||
                    errorCode == BiometricPrompt.ERROR_USER_CANCELED ||
                    errorCode == BiometricPrompt.ERROR_CANCELED
                finishWithError(if (cancelled) "[cancelled] Autenticação cancelada." else "[error] $errString")
            }

            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                try {
                    val c = result.cryptoObject?.cipher ?: throw IllegalStateException("sem cipher")
                    Pending.output = if (sealing) KeystoreCrypto.sealWith(c, input) else KeystoreCrypto.openWith(c, input)
                    setResult(Activity.RESULT_OK)
                    finish()
                } catch (e: Exception) {
                    finishWithError("[error] ${e.message}")
                }
            }
        })
        prompt.authenticate(info, BiometricPrompt.CryptoObject(cipher))
    }

    private fun finishWithError(message: String) {
        Pending.error = message
        setResult(Activity.RESULT_OK)
        finish()
    }
}
