package dev.hermesgots

import java.net.URI
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.Signature

/**
 * What a press of a link the relay carried signs, and how (ADR 0167).
 *
 * A reply link and an approval's buttons ride the Gots registry and Firebase in clear, so the plugin
 * takes a press of one only with a signature from a key this phone handed it ([NoticeKey]). The
 * signature covers [CONTEXT], the purpose, the link's token and the reply's words, one per line —
 * `device_keys.message` in the plugin, whose context a test holds equal to this one's — so a
 * signature made for one press answers no other, and the token being one-shot is what stops a replay.
 *
 * Pure: the Keystore half is [NoticeKey], so this runs under plain JUnit.
 */
object NoticeSignature {
    const val CONTEXT = "gots-notice-v1"

    /** A tray Reply's purpose, and an approval button's. */
    const val REPLY = "reply"
    const val ANSWER = "answer"

    /** The header naming the key a press is signed with, and the one carrying the signature. */
    const val KEY_HEADER = "X-Gots-Key"
    const val SIGNATURE_HEADER = "X-Gots-Signature"

    /** The bytes one press signs. */
    fun message(purpose: String, token: String, text: String = ""): ByteArray =
        "$CONTEXT\n$purpose\n$token\n$text".toByteArray(Charsets.UTF_8)

    /** A link's token: its last path segment, which is all `push/answer/<token>` and `push/reply/<token>` carry. */
    fun tokenOf(url: String): String? {
        val path = runCatching { URI(url).rawPath }.getOrNull() ?: return null
        return path.substringAfterLast('/').takeIf { it.isNotEmpty() }
    }

    /** What the plugin names a key by: the SHA-256 of its DER, in lower-case hex. */
    fun keyId(der: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(der).joinToString("") { "%02x".format(it) }

    /** An ECDSA P-256 signature over [message], in the DER form the plugin checks. */
    fun sign(key: PrivateKey, message: ByteArray): ByteArray =
        Signature.getInstance("SHA256withECDSA").run {
            initSign(key)
            update(message)
            sign()
        }
}
