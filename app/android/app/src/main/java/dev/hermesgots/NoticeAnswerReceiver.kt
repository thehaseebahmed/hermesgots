package dev.hermesgots

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

/**
 * Answers a notice's button with the app closed.
 *
 * A press posts the one-shot link the notice minted (`plugin/answers.py`, served at
 * `POST /api/plugins/gots/push/answer/<token>`, where the token is the credential — no account key,
 * no session, no page), and then the row it was pressed on leaves the tray. The choice is the
 * token's, so a press cannot ask for more than the one thing it was drawn for, and a second press of
 * the same link is refused by the host.
 *
 * Not exported: the only intents that reach it are the ones [GotsMessagingService] built. The post
 * runs on a thread of its own and the receiver is held open until it finishes, since the app may be
 * gone by the time the host answers and the press is the one thing the reader asked for.
 */
class NoticeAnswerReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_ANSWER) return
        val url = intent.getStringExtra(EXTRA_URL).orEmpty()
        // Only a link is ever posted. The registry keeps an http(s) address and drops anything else
        // (`actionsOf` in `app/netlify/lib/fcm.ts`); this is the same rule, kept where it is used.
        if (!Notice.isLink(url)) return
        val tag = intent.getStringExtra(EXTRA_TAG)
        val pending = goAsync()
        thread {
            try {
                post(url)
            } finally {
                // The row has been answered, whatever the network said: a notice that waits for a
                // retry is one the reader has to clear twice.
                if (tag != null) NoticeDrawer.clear(context, tag)
                pending.finish()
            }
        }
    }

    /** One POST to the link, and no exception out of it: a dead network is a press that didn't land. */
    private fun post(url: String) {
        val connection = try {
            URL(url).openConnection() as HttpURLConnection
        } catch (error: IOException) {
            return
        } catch (error: SecurityException) {
            return
        }
        try {
            connection.requestMethod = "POST"
            // A press made in a lift is given a few seconds and then let go: a broadcast is held open
            // for about ten, and a press the reader can repeat is better than one this process hangs on.
            connection.connectTimeout = ANSWER_MS
            connection.readTimeout = ANSWER_MS
            connection.doOutput = true
            // The route takes no body: the length is declared zero, so the request is a fixed one
            // rather than a chunked one.
            connection.setFixedLengthStreamingMode(0)
            connection.outputStream.use { }
            // Read the answer, so the host's refusal is read as one and the exchange is closed cleanly.
            val answered = connection.responseCode
            val body = if (answered >= 400) connection.errorStream else connection.inputStream
            body?.use { it.readBytes() }
        } catch (error: IOException) {
            // No network, a host asleep or gone: the press is lost, and it is one tap to repeat.
        } catch (error: SecurityException) {
            // No INTERNET permission — nothing can be done about that from here.
        } finally {
            runCatching { connection.disconnect() }
        }
    }

    companion object {
        /** What [GotsMessagingService] marks a button's intent with: nothing else is answered here. */
        const val ACTION_ANSWER = "dev.hermesgots.push.ANSWER"

        /** The link a press posts. */
        const val EXTRA_URL = "dev.hermesgots.push.URL"

        /** The row to clear once it has been answered. */
        const val EXTRA_TAG = "dev.hermesgots.push.TAG"

        /** What one press may cost each way: a broadcast is only held open for about ten seconds. */
        private const val ANSWER_MS = 3_500
    }
}
