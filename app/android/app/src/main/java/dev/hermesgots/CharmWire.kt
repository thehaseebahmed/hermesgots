package dev.hermesgots

/**
 * The charm's alert, as bytes: the two control writes the phone makes so a bot can tap the reader on
 * the shoulder, and nothing else.
 *
 * The wire is `docs/PROTOCOL.md` in the `hermesgots-charm` repo, protocol version 1: every control
 * write is `[version u8 = 1][op][payload]`, `Alert` (`0x20`) carries
 * `[reason u8][subjectLen u8][subject][idLen u8][botId]` and `Clear` (`0x21`) carries
 * `[subjectLen u8][subject]`. The app's own copy of this protocol is `src/lib/charm-protocol.ts`,
 * which the page syncs with; this object is the copy that runs with the app closed, and
 * `app/scripts/test-charm-alert.mjs` compares these constants and this field order to the
 * document's literals, so a drift here fails a test rather than reaching the charm as silence.
 */
object CharmWire {
    /** The version byte every control write leads with. */
    const val VERSION = 1

    /** `Alert`: this bot needs the reader, and why. */
    const val OP_ALERT = 0x20

    /** `Clear`: this bot is settled, so the record keyed by the subject goes. */
    const val OP_CLEAR = 0x21

    // The three moments a charm draws. Nothing else is forwarded to it: a failure, a room or a
    // routine's news is not a bot's face waiting on you.
    const val REASON_QUESTION = 1
    const val REASON_APPROVAL = 2
    const val REASON_FINISHED = 3

    /** What a subject or a bot id may measure, as the charm's `kMaxSubjectLen` does. */
    const val FIELD_BYTES = 64

    private val REASONS = setOf(REASON_QUESTION, REASON_APPROVAL, REASON_FINISHED)

    /**
     * An alert: which bot, and which of the three moments it is. The subject is what a later clear
     * names, so it is the one field a record and its clear cannot spell differently.
     *
     * A reason outside the three is refused here rather than written, since the charm would answer
     * `BadMessage` and the reader would never learn a bot had asked anything.
     */
    fun alert(reason: Int, subject: String, botId: String): ByteArray {
        require(reason in REASONS) { "A charm alert is a question, an approval or a finished run" }
        return frame(OP_ALERT)
            .u8(reason)
            .field(subject)
            .field(botId)
            .done()
    }

    /** A clear: the subject whose record goes. It carries no reason, and names no bot. */
    fun clear(subject: String): ByteArray {
        return frame(OP_CLEAR)
            .field(subject)
            .done()
    }

    /** `[version u8][op]`, the head every control write wears. */
    private fun frame(op: Int): Writer {
        return Writer().u8(VERSION).u8(op)
    }

    /**
     * `text` as UTF-8 bytes cut to [FIELD_BYTES] without splitting a character — the rule `utf8Clip`
     * keeps in `src/lib/charm-protocol.ts`: a cut landing inside a character steps back to that
     * character's first byte, so the charm is never handed a broken tail.
     */
    internal fun clip(text: String): ByteArray {
        val bytes = text.toByteArray(Charsets.UTF_8)
        if (bytes.size <= FIELD_BYTES) return bytes
        var end = FIELD_BYTES
        // Continuation bytes are 10xxxxxx: step back to the start of the character they continue.
        while (end > 0 && (bytes[end].toInt() and 0xc0) == 0x80) end--
        return bytes.copyOf(end)
    }

    /** The frame under construction: bytes appended in the order the document names them. */
    private class Writer {
        private val bytes = java.io.ByteArrayOutputStream()

        fun u8(value: Int): Writer {
            bytes.write(value and 0xff)
            return this
        }

        /** A string as `[length u8][bytes]`. An empty one is a frame the charm answers `BadMessage`. */
        fun field(text: String): Writer {
            val clipped = clip(text)
            require(clipped.isNotEmpty()) { "A charm field carries 1 to 64 bytes" }
            u8(clipped.size)
            bytes.write(clipped, 0, clipped.size)
            return this
        }

        fun done(): ByteArray = bytes.toByteArray()
    }
}
