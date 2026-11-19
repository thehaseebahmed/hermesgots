package dev.hermesgots

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.security.spec.X509EncodedKeySpec
import java.util.Base64

class NoticeSignatureTest {

    @Test
    fun aPressSignsTheContextThePurposeTheTokenAndTheWords() {
        assertArrayEquals(
            "gots-notice-v1\nreply\ntok\nhi".toByteArray(),
            NoticeSignature.message(NoticeSignature.REPLY, "tok", "hi"),
        )
        assertArrayEquals(
            "gots-notice-v1\nanswer\ntok\n".toByteArray(),
            NoticeSignature.message(NoticeSignature.ANSWER, "tok"),
        )
    }

    @Test
    fun aLinksTokenIsItsLastSegment() {
        assertEquals("abc_-1", NoticeSignature.tokenOf("https://bot.example/p/work/api/plugins/gots/push/reply/abc_-1"))
        assertNull(NoticeSignature.tokenOf("https://bot.example/push/reply/"))
        assertNull(NoticeSignature.tokenOf("not a url at all ::"))
    }

    @Test
    fun aSignatureTheKeyMadeChecksUnderItsPublicHalfAndNoOtherMessage() {
        val pair = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
        val message = NoticeSignature.message(NoticeSignature.REPLY, "tok", "yes")
        val signature = NoticeSignature.sign(pair.private, message)
        fun checks(over: ByteArray) = Signature.getInstance("SHA256withECDSA").run {
            initVerify(pair.public)
            update(over)
            verify(signature)
        }
        assertTrue(checks(message))
        assertFalse(checks(NoticeSignature.message(NoticeSignature.REPLY, "tok", "no")))
    }

    @Test
    fun aSignatureThePluginsLibraryMadeIsOneThisCodeReadsTheSameWay() {
        // Made by the plugin's own `cryptography` over `device_keys.message("reply", "tok", "hi")`:
        // the DER key and the DER signature are the shapes the two sides exchange.
        val der = Base64.getDecoder().decode(PLUGIN_KEY)
        val public = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(der))
        val checks = Signature.getInstance("SHA256withECDSA").run {
            initVerify(public)
            update(NoticeSignature.message(NoticeSignature.REPLY, "tok", "hi"))
            verify(Base64.getDecoder().decode(PLUGIN_SIGNATURE))
        }
        assertTrue(checks)
        assertEquals(PLUGIN_KEY_ID, NoticeSignature.keyId(der))
    }

    private companion object {
        const val PLUGIN_KEY = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEGUCl5NYO25K9O0lRhvkg6OXXK+91nJ4TPV6RLJZR3QgM2/ftEsH9bA5GFq2oA4qWv5pC2Jr57SmY5bCofH1xTQ=="
        const val PLUGIN_SIGNATURE = "MEUCIQC+jkV0ni6z1yNn3ZrT5AajsgFYPcQM1K7kVftn0x+glwIgC3N5eZIn1zA9Pm1M2y06TpjygwgYU/XPKIdH98PQ8EY="
        const val PLUGIN_KEY_ID = "913a619c4cce69a8208aeb5d5de481b09b8ba93d648aa23c77723d62523aa638"
    }
}
