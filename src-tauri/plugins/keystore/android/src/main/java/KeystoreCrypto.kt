package com.rkxp.vault.keystore

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * AES-256-GCM com chaves do Android Keystore (não exportáveis; ficam no hardware quando existe).
 * O blob cifrado tem o formato `iv(12) || ciphertext+tag`.
 */
object KeystoreCrypto {
    private const val PROVIDER = "AndroidKeyStore"
    private const val DEVICE_ALIAS = "vault.device"
    private const val BIO_ALIAS = "vault.bio"
    private const val TRANSFORM = "AES/GCM/NoPadding"
    private const val IV_LEN = 12
    private const val TAG_BITS = 128

    private fun store(): KeyStore = KeyStore.getInstance(PROVIDER).apply { load(null) }

    private fun generate(spec: KeyGenParameterSpec): SecretKey =
        KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, PROVIDER).apply { init(spec) }.generateKey()

    private fun baseSpec(alias: String) =
        KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)

    // ---- Chave do aparelho: sem biometria, protege o que o app guarda em disco ----

    private fun deviceKey(): SecretKey =
        (store().getKey(DEVICE_ALIAS, null) as? SecretKey) ?: generate(baseSpec(DEVICE_ALIAS).build())

    fun deviceEncrypt(plain: ByteArray): ByteArray {
        val c = Cipher.getInstance(TRANSFORM)
        c.init(Cipher.ENCRYPT_MODE, deviceKey())
        return c.iv + c.doFinal(plain)
    }

    fun deviceDecrypt(blob: ByteArray): ByteArray {
        require(blob.size > IV_LEN) { "blob inválido" }
        val c = Cipher.getInstance(TRANSFORM)
        c.init(Cipher.DECRYPT_MODE, deviceKey(), GCMParameterSpec(TAG_BITS, blob.copyOfRange(0, IV_LEN)))
        return c.doFinal(blob, IV_LEN, blob.size - IV_LEN)
    }

    // ---- Chave biométrica: só opera depois da biometria (por uso) ----

    /** Recria a chave biométrica (descarta a anterior) e devolve um Cipher de cifragem. */
    fun bioEncryptCipher(): Cipher {
        bioRemove()
        val b = baseSpec(BIO_ALIAS)
            .setUserAuthenticationRequired(true)
            .setInvalidatedByBiometricEnrollment(true)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            b.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
        } else {
            @Suppress("DEPRECATION")
            b.setUserAuthenticationValidityDurationSeconds(-1)
        }
        val key = generate(b.build())
        val c = Cipher.getInstance(TRANSFORM)
        c.init(Cipher.ENCRYPT_MODE, key)
        return c
    }

    /** Cipher de decifragem para um blob criado por `bioEncryptCipher`. */
    fun bioDecryptCipher(blob: ByteArray): Cipher {
        require(blob.size > IV_LEN) { "blob inválido" }
        val key = store().getKey(BIO_ALIAS, null) as? SecretKey ?: throw IllegalStateException("sem chave biométrica")
        val c = Cipher.getInstance(TRANSFORM)
        c.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(TAG_BITS, blob.copyOfRange(0, IV_LEN)))
        return c
    }

    fun bioRemove() {
        val ks = store()
        if (ks.containsAlias(BIO_ALIAS)) ks.deleteEntry(BIO_ALIAS)
    }

    fun sealWith(cipher: Cipher, plain: ByteArray): ByteArray = cipher.iv + cipher.doFinal(plain)

    fun openWith(cipher: Cipher, blob: ByteArray): ByteArray = cipher.doFinal(blob, IV_LEN, blob.size - IV_LEN)
}
