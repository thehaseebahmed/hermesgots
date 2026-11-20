package dev.hermesgots

/**
 * The charm's alert, as bytes: the three control writes the phone makes so a bot can tap the reader
 * on the shoulder, pick up a tap the phone could not answer at the time, and nothing else.
 *
 * The wire is `docs/PROTOCOL.md` in the `hermesgots-charm` repo, protocol version 1: every control
 * write is `[version u8 = 1][op][payload]`, `Alert` (`0x20`) carries
 * `[reason u8][minute u16 LE][titleLen u8][title][bodyLen u8][body][actionCount u8][per action:
 * idLen u8, id, labelLen u8, label][subjectLen u8][subject][idLen u8][botId]`, `Clear` (`0x21`)
 * carries `[subjectLen u8][subject]`, and `Handoff` (`0x22`) is the op alone. The app's own copy of
 * this protocol is `src/lib/charm-protocol.ts`; this object is the copy that runs with the app
 * closed, and `app/scripts/test-charm-alert.mjs` compares these constants and this field order to
 * the document's literals, so a drift here fails a test rather than reaching the charm as silence.
 */
object CharmWire {
    /** The version byte every control write leads with — the handoff's ask, a one-byte write, is alone. */
    const val VERSION = 1

    /** `Alert`: this bot needs the reader, and what the notification said. */
    const val OP_ALERT = 0x20

    /** `Clear`: this bot is settled, so the record keyed by the subject goes. */
    const val OP_CLEAR = 0x21

    /**
     * `Handoff`: is a tap waiting that this phone could not answer? One byte, with no version in
     * front of it — the charm reads a one-byte control write as this ask alone, and answers in its
     * status characteristic. One ask consumes the answer, so the phone asks on every connection it
     * makes, which is why a tap made while the phone was away is picked up at the next contact and
     * never before it.
     */
    const val OP_HANDOFF = 0x22

    // The moments a charm draws: a question, and an approval a plan waiting is. Nothing else is
    // forwarded to it — a finished run, a failure, a room or a routine's news is not a bot's face
    // waiting on you.
    const val REASON_QUESTION = 1
    const val REASON_APPROVAL = 2

    /** What an alert's title, and its body, may measure on the wire. */
    const val TITLE_BYTES = 64
    const val BODY_BYTES = 128

    /**
     * What an alert's buttons may measure: an approval's two at most, an id a press answers by, and
     * the words the charm draws on it.
     */
    const val ACTION_LIMIT = 2
    const val ACTION_ID_BYTES = 16
    const val ACTION_LABEL_BYTES = 32

    /** What a subject or a bot id may measure, as the charm's `kMaxSubjectLen` does. */
    const val FIELD_BYTES = 64

    /** Minutes in a day: an alert's minute counts from local midnight. */
    private const val MINUTES_A_DAY = 24 * 60

    private val REASONS = setOf(REASON_QUESTION, REASON_APPROVAL)

    /**
     * A button an alert carries: the id the charm answers with when it is pressed, and the words it
     * draws on it. The id is the button's place in the notice's own list, which is the id the tray's
     * press carries too — so the charm's buttons are the notification's, not a copy with a second
     * naming of its own.
     */
    data class Action(val id: String, val label: String)

    /**
     * An alert: which bot, which of the two moments it is, the minute of the day the frame was built,
     * the words the tray entry shows, and the buttons it draws — the same title, body and two buttons
     * the reader reads on the phone, so the charm reads like the notification rather than like a
     * retelling of it.
     *
     * The subject is what a later clear names and what a handoff answer carries, so it is the one
     * field a record, its clear and its tap cannot spell differently.
     *
     * A reason outside the two is refused here rather than written, since the charm would answer
     * `BadMessage` and the reader would never learn a bot had asked anything.
     */
    fun alert(
        reason: Int,
        minute: Int,
        title: String,
        body: String,
        actions: List<Action>,
        subject: String,
        botId: String,
    ): ByteArray {
        require(reason in REASONS) { "A charm alert is a question or an approval" }
        require(minute in 0 until MINUTES_A_DAY) { "A charm alert is raised at a minute of the day" }
        return frame(OP_ALERT)
            .u8(reason)
            .u16(minute)
            .words(title, TITLE_BYTES)
            .words(body, BODY_BYTES)
            .actions(actions)
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

    /** The ask for a tap this phone missed, and the whole of it. */
    fun handoff(): ByteArray {
        return byteArrayOf(OP_HANDOFF.toByte())
    }

    /**
     * The subject a handoff ask was answered with, or null for an answer with nothing pending and for
     * anything that is not this answer at all. A status is exactly four bytes and this answer is five
     * or more, so the two are never read for each other: a status whose third byte happened to be
     * `0x22` is still a status, and this answers null for it.
     */
    fun handoffAnswer(bytes: ByteArray?): String? {
        if (bytes == null || bytes.size < 5) return null
        if ((bytes[2].toInt() and 0xff) != OP_HANDOFF) return null
        val length = bytes[3].toInt() and 0xff
        // Nothing was pending, or the subject the charm announced never arrived: either way, none.
        if (length == 0 || bytes.size < 4 + length) return null
        return String(bytes, 4, length, Charsets.UTF_8)
    }

    /** `[version u8][op]`, the head every control write but the ask wears. */
    private fun frame(op: Int): Writer {
        return Writer().u8(VERSION).u8(op)
    }

    /**
     * `text` as UTF-8 bytes cut to `max` without splitting a character, nor a word — the rule
     * `clampText` keeps in `src/lib/charm-protocol.ts`: a cut landing inside a character steps back to
     * that character's first byte, then back to the space that ended the last whole word, so the charm
     * is handed neither a broken tail nor half a word.
     */
    internal fun clip(text: String, max: Int = FIELD_BYTES): ByteArray {
        val bytes = text.toByteArray(Charsets.UTF_8)
        if (bytes.size <= max) return bytes
        var end = max
        // Continuation bytes are 10xxxxxx: step back to the start of the character they continue.
        while (end > 0 && (bytes[end].toInt() and 0xc0) == 0x80) end--
        // A space is one byte and never inside a character, so this is a second search on the same cut.
        var space = end
        while (space > 0 && (bytes[space - 1].toInt() and 0xff) != 0x20) space--
        if (space > 1) end = space - 1
        return bytes.copyOf(end)
    }

    /** The frame under construction: bytes appended in the order the document names them. */
    private class Writer {
        private val bytes = java.io.ByteArrayOutputStream()

        fun u8(value: Int): Writer {
            bytes.write(value and 0xff)
            return this
        }

        /** A 16-bit field, little endian, as the charm reads its own. */
        fun u16(value: Int): Writer {
            return u8(value).u8(value ushr 8)
        }

        /** A string as `[length u8][bytes]`. An empty one is a frame the charm answers `BadMessage`. */
        fun field(text: String, max: Int = FIELD_BYTES): Writer {
            val clipped = clip(text, max)
            require(clipped.isNotEmpty()) { "A charm field carries 1 to 64 bytes" }
            u8(clipped.size)
            bytes.write(clipped, 0, clipped.size)
            return this
        }

        /**
         * The buttons an alert carries: their count, then each one's id and label, in that order.
         * Two at most, since a charm draws an approval's two and a third would be a press with no
         * button — the notice's own list is cut here rather than written for the charm to refuse.
         */
        fun actions(list: List<CharmWire.Action>): Writer {
            val kept = list.take(ACTION_LIMIT)
            u8(kept.size)
            for (one in kept) {
                field(one.id, ACTION_ID_BYTES)
                field(one.label, ACTION_LABEL_BYTES)
            }
            return this
        }

        /**
         * A string as `[length u8][bytes]` where none at all is allowed: a notice that says nothing but
         * its title, or one whose body was dropped to fit the link, still draws its title.
         */
        fun words(text: String, max: Int): Writer {
            val clipped = clip(text, max)
            u8(clipped.size)
            bytes.write(clipped, 0, clipped.size)
            return this
        }

        fun done(): ByteArray = bytes.toByteArray()
    }
}
