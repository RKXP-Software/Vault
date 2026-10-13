package com.rkxp.vault.keystore

import android.app.Activity
import android.content.Intent
import android.util.Base64
import androidx.activity.result.ActivityResult
import androidx.biometric.BiometricManager
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class BlobArgs {
    lateinit var data: String
}

/** Dados que passam entre o plugin e a KeystoreActivity (evita colocar segredos em Intent). */
object Pending {
    @Volatile var mode: String = ""
    @Volatile var input: ByteArray? = null
    @Volatile var output: ByteArray? = null
    @Volatile var error: String? = null

    fun reset() {
        input?.fill(0)
        output?.fill(0)
        mode = ""
        input = null
        output = null
        error = null
    }
}

@TauriPlugin
class KeystorePlugin(private val activity: Activity) : Plugin(activity) {

    private fun decode(invoke: Invoke): ByteArray =
        Base64.decode(invoke.parseArgs(BlobArgs::class.java).data, Base64.NO_WRAP)

    private fun resolveBlob(invoke: Invoke, bytes: ByteArray) {
        val ret = JSObject()
        ret.put("data", Base64.encodeToString(bytes, Base64.NO_WRAP))
        invoke.resolve(ret)
    }

    @Command
    fun protect(invoke: Invoke) {
        try {
            resolveBlob(invoke, KeystoreCrypto.deviceEncrypt(decode(invoke)))
        } catch (e: Exception) {
            invoke.reject("Falha ao proteger no Keystore: ${e.message}")
        }
    }

    @Command
    fun unprotect(invoke: Invoke) {
        try {
            resolveBlob(invoke, KeystoreCrypto.deviceDecrypt(decode(invoke)))
        } catch (e: Exception) {
            invoke.reject("Falha ao ler do Keystore: ${e.message}")
        }
    }

    @Command
    fun bioStatus(invoke: Invoke) {
        val r = BiometricManager.from(activity).canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG)
        val ret = JSObject()
        ret.put("available", r == BiometricManager.BIOMETRIC_SUCCESS)
        invoke.resolve(ret)
    }

    @Command
    fun bioRemove(invoke: Invoke) {
        try {
            KeystoreCrypto.bioRemove()
        } catch (_: Exception) {
        }
        invoke.resolve()
    }

    @Command
    fun bioSeal(invoke: Invoke) = startPrompt(invoke, "seal")

    @Command
    fun bioOpen(invoke: Invoke) = startPrompt(invoke, "open")

    private fun startPrompt(invoke: Invoke, mode: String) {
        val data = try {
            decode(invoke)
        } catch (e: Exception) {
            invoke.reject("Dados inválidos")
            return
        }
        Pending.reset()
        Pending.mode = mode
        Pending.input = data
        startActivityForResult(invoke, Intent(activity, KeystoreActivity::class.java), "promptResult")
    }

    @ActivityCallback
    private fun promptResult(invoke: Invoke, @Suppress("UNUSED_PARAMETER") result: ActivityResult) {
        val out = Pending.output
        val error = Pending.error
        try {
            when {
                error != null -> invoke.reject(error)
                out != null -> resolveBlob(invoke, out)
                else -> invoke.reject("[cancelled] Autenticação cancelada.")
            }
        } finally {
            Pending.reset()
        }
    }
}
