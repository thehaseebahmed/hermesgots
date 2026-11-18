package dev.hermesgots

import org.json.JSONObject

/**
 * What became of a Reply typed in the tray, read from the host's answer, with no Android type in it.
 *
 * The route (`push_reply` in the plugin) answers 200 once the turn is queued; 400 for words it won't
 * take, read before the link is spent; 404, 409 and 410 once the link is spent or was never this
 * bot's, each with the host's own sentence. [NoticeAnswerReceiver] re-posts the entry from it, so
 * the reply spinner always ends and the reader sees what happened.
 */
sealed class ReplyOutcome {
    /** Whether the entry keeps its Reply: only while the link is still unspent. */
    abstract val keepsReply: Boolean

    /** The line the entry gains: what the reader sent, or why it went nowhere. */
    abstract fun line(typed: String, words: ReplyWords): ReplyLine

    /** Queued on the chat's session: the reader's own words join the conversation, and the link is spent. */
    data object Sent : ReplyOutcome() {
        override val keepsReply = false
        override fun line(typed: String, words: ReplyWords) = ReplyLine(fromReader = true, text = typed)
    }

    /** The host answered and refused, in its own words where it gave any. */
    data class Refused(val reason: String?, override val keepsReply: Boolean) : ReplyOutcome() {
        override fun line(typed: String, words: ReplyWords) = ReplyLine(
            fromReader = false,
            text = reason?.let { "${words.couldntSend} — $it" } ?: words.couldntSend,
        )
    }

    /**
     * No answer the link was spent by: no network, a timeout, or a host that failed and gave the link
     * back. The reader can press Reply again.
     */
    data object NotDelivered : ReplyOutcome() {
        override val keepsReply = true
        override fun line(typed: String, words: ReplyWords) = ReplyLine(fromReader = false, text = words.notSent)
    }

    companion object {
        /** How much of the host's sentence an entry shows: one line of a tray entry, not a page. */
        const val REASON_LIMIT = 160

        /** The outcome of one post: [status] is null where no answer came at all. */
        fun of(status: Int?, body: String?): ReplyOutcome = when {
            status == null -> NotDelivered
            status in 200..299 -> Sent
            // Read before the redeem, so nothing was spent and the same link takes another try.
            status == 400 -> Refused(reasonOf(body), keepsReply = true)
            status in 401..499 -> Refused(reasonOf(body), keepsReply = false)
            // A route that throws after the redeem gives the link back (`answers.release`).
            else -> NotDelivered
        }

        /** The host's sentence from its error shape (`{"error": {"message"}}`), on one bounded line. */
        private fun reasonOf(body: String?): String? {
            if (body.isNullOrBlank()) return null
            val message = try {
                JSONObject(body).optJSONObject("error")?.optString("message")
            } catch (bad: Exception) {
                null
            }
            val line = message?.replace(Regex("\\s+"), " ")?.trim()
            if (line.isNullOrEmpty()) return null
            return if (line.length <= REASON_LIMIT) line else line.take(REASON_LIMIT - 1).trimEnd() + "…"
        }
    }
}

/** A line an entry gains: from the reader, or a note about the reply that isn't anyone's message. */
data class ReplyLine(val fromReader: Boolean, val text: String)

/** The words a line is made of, from the app's strings. */
data class ReplyWords(val couldntSend: String, val notSent: String)
