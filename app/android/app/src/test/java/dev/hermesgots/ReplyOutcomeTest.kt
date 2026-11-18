package dev.hermesgots

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ReplyOutcomeTest {

    private fun refusal(message: String) = """{"error": {"message": "$message"}}"""

    @Test
    fun aSentReplyShowsTheTextAndNoReply() {
        val outcome = ReplyOutcome.of(200, """{"object": "gots.push.reply", "queued": true}""")
        assertEquals(ReplyOutcome.Sent, outcome)
        assertFalse(outcome.keepsReply)
        assertEquals(ReplyLine(fromReader = true, text = "Try again"), outcome.line("Try again", WORDS))
    }

    @Test
    fun aBlankReplyPostsNothingAndKeepsReply() {
        for (typed in listOf(null, "", "   \n\t ")) {
            assertEquals("'$typed' is no words", null, ReplyOutcome.typed(typed))
        }
        assertEquals("Try again", ReplyOutcome.typed("  Try again \n"))
        // The entry is posted again all the same, so Android's spinner ends, with nothing added.
        assertTrue(ReplyOutcome.Blank.keepsReply)
        assertEquals(null, ReplyOutcome.Blank.line("", WORDS))
    }

    @Test
    fun aRefusedReplySaysWhyAndOffersNone() {
        for (status in listOf(404, 409, 410)) {
            val outcome = ReplyOutcome.of(status, refusal("That reply has already been sent."))
            assertFalse("$status spends the link", outcome.keepsReply)
            assertEquals(
                ReplyLine(fromReader = false, text = "Couldn't send — That reply has already been sent."),
                outcome.line("Try again", WORDS),
            )
        }
    }

    @Test
    fun aRefusalWithNoWordsStillSaysItWasNotSent() {
        val outcome = ReplyOutcome.of(410, "<html>gone</html>")
        assertFalse(outcome.keepsReply)
        assertEquals(ReplyLine(fromReader = false, text = "Couldn't send"), outcome.line("x", WORDS))
    }

    @Test
    fun aReplyTheHostWouldNotReadKeepsReplySinceItsLinkIsUnspent() {
        // The route reads the words before it spends the link (`push_reply` in the plugin).
        val outcome = ReplyOutcome.of(400, refusal("That reply is too long."))
        assertTrue(outcome.keepsReply)
        assertEquals(
            ReplyLine(fromReader = false, text = "Couldn't send — That reply is too long."),
            outcome.line("x", WORDS),
        )
    }

    @Test
    fun aReplyWithNoNetworkKeepsReply() {
        val outcome = ReplyOutcome.of(null, null)
        assertEquals(ReplyOutcome.NotDelivered, outcome)
        assertTrue(outcome.keepsReply)
        assertEquals(ReplyLine(fromReader = false, text = "Not sent"), outcome.line("Try again", WORDS))
    }

    @Test
    fun aHostThatFailedGaveItsLinkBackSoReplyStays() {
        // A route that throws after the redeem releases the link (`answers.release`).
        assertEquals(ReplyOutcome.NotDelivered, ReplyOutcome.of(500, "Internal Server Error"))
        assertEquals(ReplyOutcome.NotDelivered, ReplyOutcome.of(502, refusal("Bad gateway")))
    }

    @Test
    fun theHostsWordsAreOneBoundedLine() {
        val long = "word ".repeat(100)
        val outcome = ReplyOutcome.of(409, refusal("That chat\\nis closed.  $long"))
        val text = outcome.line("x", WORDS)!!.text
        assertFalse(text.contains('\n'))
        assertTrue(text.startsWith("Couldn't send — That chat is closed. word"))
        assertTrue(text.length <= "Couldn't send — ".length + ReplyOutcome.REASON_LIMIT)
    }

    companion object {
        private val WORDS = ReplyWords(couldntSend = "Couldn't send", notSent = "Not sent")
    }
}
