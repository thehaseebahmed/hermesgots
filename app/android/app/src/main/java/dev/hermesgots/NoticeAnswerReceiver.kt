package dev.hermesgots

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.RemoteInput
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

/**
 * Answers a notice's button, or sends its typed Reply, with the app closed.
 *
 * A press posts the one-shot link the notice minted (`plugin/answers.py`, served at
 * `POST /api/plugins/gots/push/answer/<token>`, where the token is the credential — no account key,
 * no session, no page), and then the row it was pressed on leaves the tray. The choice is the
 * token's, so a press cannot ask for more than the one thing it was drawn for, and a second press of
 * the same link is refused by the host. A Reply is the same: its link is `push/reply/<token>`, and the
 * typed text is its body. Its entry stays, and says what happened ([ReplyOutcome]): the words sent,
 * or why they weren't, with Reply kept only while the link is still unspent.
 * Mark as read posts nothing: it queues the press for the page ([TrayReads]) and clears the entry.
 *
 * Not exported: the only intents that reach it are the ones [GotsMessagingService] built. The post
 * runs on a thread of its own and the receiver is held open until it finishes, since the app may be
 * gone by the time the host answers and the press is the one thing the reader asked for.
 */
class NoticeAnswerReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == ACTION_READ) {
            markRead(context, intent)
            return
        }
        if (intent.action != ACTION_ANSWER && intent.action != ACTION_REPLY) return
        val url = intent.getStringExtra(EXTRA_URL).orEmpty()
        // Only a link is ever posted. The registry keeps an http(s) address and drops anything else
        // (`actionsOf` in `app/netlify/lib/fcm.ts`); this is the same rule, kept where it is used.
        if (!Notice.isLink(url)) return
        val tag = intent.getStringExtra(EXTRA_TAG)
        // A reply posts what was typed as `{text}` (`push_reply` in the plugin); a button posts nothing.
        val text = if (intent.action == ACTION_REPLY) {
            RemoteInput.getResultsFromIntent(intent)?.getCharSequence(KEY_TEXT)
                ?.toString()?.trim().orEmpty().ifEmpty { return }
        } else {
            null
        }
        val body = text?.let { JSONObject().put("text", it).toString().toByteArray(Charsets.UTF_8) } ?: ByteArray(0)
        val pending = goAsync()
        thread {
            try {
                val answer = post(url, body)
                if (tag != null) {
                    if (text == null) {
                        // The row has been answered, whatever the network said: a notice that waits
                        // for a retry is one the reader has to clear twice.
                        NoticeDrawer.clear(context, tag)
                    } else {
                        // A reply's entry stays and says what became of it, which also ends the
                        // spinner Android shows on a sent RemoteInput until the entry is posted again.
                        val outcome = ReplyOutcome.of(answer?.status, answer?.body)
                        NoticeDrawer.replied(context, tag, outcome.line(text, wordsOf(context)), outcome.keepsReply)
                    }
                }
            } finally {
                pending.finish()
            }
        }
    }

    private fun wordsOf(context: Context) = ReplyWords(
        couldntSend = context.getString(R.string.notice_couldnt_send),
        notSent = context.getString(R.string.notice_not_sent),
    )

    /**
     * Mark as read: the press is queued for the page, which holds the read marks, and the entry
     * leaves the tray. Nothing is posted — a read mark is this device's alone — so it needs no network.
     */
    private fun markRead(context: Context, intent: Intent) {
        val chat = intent.getStringExtra(EXTRA_CHAT)?.takeIf { it.isNotBlank() } ?: return
        val through = if (intent.hasExtra(EXTRA_AT)) intent.getLongExtra(EXTRA_AT, 0L).takeIf { it > 0 } else null
        val prefs = context.getSharedPreferences(TrayReads.PREFS, Context.MODE_PRIVATE)
        synchronized(TrayReads) {
            val stored = prefs.getString(TrayReads.KEY, null)
            prefs.edit().putString(TrayReads.KEY, TrayReads.append(stored, chat, System.currentTimeMillis(), through)).apply()
        }
        intent.getStringExtra(EXTRA_TAG)?.let { NoticeDrawer.clear(context, it) }
    }

    /** What the host answered a post: its status, and its body as text where it sent one. */
    private class Answer(val status: Int, val body: String?)

    /**
     * One POST to the link, and no exception out of it: null is a press that didn't land — a dead
     * network, a host asleep or gone, a timeout.
     */
    private fun post(url: String, body: ByteArray): Answer? {
        val connection = try {
            URL(url).openConnection() as HttpURLConnection
        } catch (error: IOException) {
            return null
        } catch (error: SecurityException) {
            return null
        }
        return try {
            connection.requestMethod = "POST"
            // A press made in a lift is given a few seconds and then let go: a broadcast is held open
            // for about ten, and a press the reader can repeat is better than one this process hangs on.
            connection.connectTimeout = ANSWER_MS
            connection.readTimeout = ANSWER_MS
            connection.doOutput = true
            // The length is declared — zero for a button, the JSON for a reply — so the request is a
            // fixed one rather than a chunked one.
            if (body.isNotEmpty()) connection.setRequestProperty("Content-Type", "application/json")
            connection.setFixedLengthStreamingMode(body.size)
            connection.outputStream.use { it.write(body) }
            // Read the answer, so the host's refusal is read as one, in its own words, and the
            // exchange is closed cleanly. A refusal is a few dozen bytes; more than that is not one.
            val answered = connection.responseCode
            val answer = if (answered >= 400) connection.errorStream else connection.inputStream
            val words = answer?.use { String(head(it), Charsets.UTF_8) }
            Answer(answered, words)
        } catch (error: IOException) {
            // No network, a host asleep or gone: the press is lost, and it is one tap to repeat.
            null
        } catch (error: SecurityException) {
            // No INTERNET permission — nothing can be done about that from here.
            null
        } finally {
            runCatching { connection.disconnect() }
        }
    }

    /** The first [ANSWER_BYTES] of a stream, read on any Android this app runs on. */
    private fun head(stream: InputStream): ByteArray {
        val out = ByteArrayOutputStream()
        val chunk = ByteArray(1_024)
        while (out.size() < ANSWER_BYTES) {
            val read = stream.read(chunk, 0, minOf(chunk.size, ANSWER_BYTES - out.size()))
            if (read < 0) break
            out.write(chunk, 0, read)
        }
        return out.toByteArray()
    }

    companion object {
        /** What [GotsMessagingService] marks a button's intent with: nothing else is answered here. */
        const val ACTION_ANSWER = "dev.hermesgots.push.ANSWER"

        /** What [GotsMessagingService] marks a Reply's intent with: the text typed rides as a RemoteInput. */
        const val ACTION_REPLY = "dev.hermesgots.push.REPLY"

        /** The RemoteInput key the typed reply is read under. */
        const val KEY_TEXT = "dev.hermesgots.push.TEXT"

        /** What [GotsMessagingService] marks a Mark as read's intent with: nothing is posted for it. */
        const val ACTION_READ = "dev.hermesgots.push.READ"

        /** The chat a Mark as read moves the read mark of. */
        const val EXTRA_CHAT = "dev.hermesgots.push.CHAT"

        /** The host's moment of the activity the notice reported, which a Mark as read covers. */
        const val EXTRA_AT = "dev.hermesgots.push.AT"

        /** The link a press posts. */
        const val EXTRA_URL = "dev.hermesgots.push.URL"

        /** The row to clear once it has been answered. */
        const val EXTRA_TAG = "dev.hermesgots.push.TAG"

        /** What one press may cost each way: a broadcast is only held open for about ten seconds. */
        private const val ANSWER_MS = 3_500

        /** How much of an answer is read: enough for the host's error shape and its sentence. */
        private const val ANSWER_BYTES = 4_096
    }
}
