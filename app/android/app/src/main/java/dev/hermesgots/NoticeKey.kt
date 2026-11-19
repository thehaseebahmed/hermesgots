package dev.hermesgots

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.spec.ECGenParameterSpec

/**
 * This phone's notice key: a P-256 pair made in the Android Keystore, whose private half can't be
 * read out of it (ADR 0167).
 *
 * The page hands the public half to each bot's plugin over the bot's own key (`POST push/key`), and
 * [NoticeAnswerReceiver] signs every press of a link the relay carried with the private half, so a
 * link read off the relay on its way is a link nobody else can press. The key needs no user
 * authentication, since a press made from the lock screen with the app closed is the point of it.
 */
object NoticeKey {
    private const val STORE = "AndroidKeyStore"
    private const val ALIAS = "dev.hermesgots.notice"

    /** The public half as X.509 SubjectPublicKeyInfo DER, made on first use. */
    @Synchronized
    fun publicKey(): ByteArray {
        val store = keyStore()
        if (!store.containsAlias(ALIAS)) make()
        return keyStore().getCertificate(ALIAS).publicKey.encoded
    }

    /** The public half as the plugin takes it: base64url, unpadded. */
    fun publicKeyText(): String = Base64.encodeToString(publicKey(), Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)

    /**
     * The headers one press carries, or none where the key can't be reached — a press posted
     * unsigned is refused by the host in its own words, which the entry then says.
     */
    fun headers(purpose: String, url: String, text: String = ""): Map<String, String> = runCatching {
        val token = NoticeSignature.tokenOf(url) ?: return emptyMap()
        val der = publicKey()
        val signature = NoticeSignature.sign(privateKey(), NoticeSignature.message(purpose, token, text))
        mapOf(
            NoticeSignature.KEY_HEADER to NoticeSignature.keyId(der),
            NoticeSignature.SIGNATURE_HEADER to Base64.encodeToString(signature, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING),
        )
    }.getOrDefault(emptyMap())

    private fun keyStore(): KeyStore = KeyStore.getInstance(STORE).apply { load(null) }

    @Synchronized
    private fun privateKey(): PrivateKey {
        if (!keyStore().containsAlias(ALIAS)) make()
        return keyStore().getKey(ALIAS, null) as PrivateKey
    }

    private fun make() {
        val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, STORE)
        generator.initialize(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN)
                .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .build(),
        )
        generator.generateKeyPair()
    }
}
