package app.memento

import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

/**
 * A take's own wire, spelled exactly as the page spells it.
 *
 * Nothing here is the Bubble's invention: a Piece is uploaded as raw bytes with its index, its span
 * and the bot's words, it answers nothing, and the one Confirm answers the words. The routes need no
 * session — the bot is the URL's profile and its key — which is why a service can speak them at all.
 *
 * The bounds are the page's too (`app/src/lib/dictation.ts`): a hung Piece is given a minute before
 * it is called a failure, and a Piece is tried three times, because a phone loses a request to a
 * lift or a tunnel and one lost POST should not cost the take.
 */
class BubbleNet(val bot: BubbleConfig.Bot) {

    /** A take's whole answer: the words, what they were, and how they were tidied. */
    data class Answer(
        val text: String,
        val heard: String,
        val ms: Int,
        val level: String?,
        val cleaned: Boolean?,
        val provider: String?,
        val model: String?,
    )

    /** Null when the host took the Piece; the reason it did not, otherwise. */
    fun upload(take: String, index: Int, ms: Int, wav: ByteArray): String? {
        var last: String? = null
        for (attempt in 1..TRIES) {
            try {
                return send(take, index, ms, wav)
            } catch (error: IOException) {
                // No answer at all is the one failure worth repeating; a host that answered will
                // answer the same way again.
                last = error.message ?: UNREACHED
                // The page's own pace: a second try after 400 ms, a third after 800.
                if (attempt < TRIES) Thread.sleep(RETRY_MS * attempt)
            }
        }
        return last
    }

    private fun send(take: String, index: Int, ms: Int, wav: ByteArray): String? {
        val query = StringBuilder("?index=").append(index)
        if (ms > 0) query.append("&ms=").append(ms)
        for (word in bot.vocabulary) if (word.isNotBlank()) query.append("&vocabulary=").append(encode(word))
        val connection = open("${bot.root}/dictation/$take/piece$query", "POST", UPLOAD_MS)
        return try {
            connection.setRequestProperty("Content-Type", "audio/wav")
            connection.setFixedLengthStreamingMode(wav.size)
            connection.outputStream.use { it.write(wav) }
            val code = connection.responseCode
            if (code in 200..299) {
                drain(connection)
                return null
            }
            // Read before the disconnect: the body is the host's own sentence, and a closed
            // connection has none to quote.
            val said = reason(connection)
            runCatching { connection.disconnect() }
            "$code $said".trim()
        } catch (error: IOException) {
            runCatching { connection.disconnect() }
            throw error
        }
    }

    /**
     * Asks a local host to load its model before the first Piece, as the page does: a cold model would
     * otherwise be loading inside the host's own queue with a Piece already waiting for it.
     */
    fun warm() {
        val connection = open("${bot.root}/dictation/warm", "POST", UPLOAD_MS)
        try {
            connection.doOutput = true
            connection.setFixedLengthStreamingMode(0)
            connection.outputStream.close()
            connection.responseCode
            drain(connection)
        } catch (_: IOException) {
            // Warming is an optimisation: a host that cannot take it hears the take anyway.
        }
    }

    /** The words, tidied at the bot's Cleanup level, or the reason the take has none. */
    fun confirm(take: String, pieces: Int): Result<Answer> {
        val connection = open("${bot.root}/dictation/$take/confirm", "POST", bound())
        return try {
            connection.setRequestProperty("Content-Type", "application/json")
            val body = JSONObject().put("pieces", pieces).toString().toByteArray()
            connection.setFixedLengthStreamingMode(body.size)
            connection.outputStream.use { it.write(body) }
            val code = connection.responseCode
            if (code !in 200..299) {
                return Result.failure(IOException("$code ${reason(connection)}".trim()))
            }
            val answer = JSONObject(connection.inputStream.bufferedReader().use { it.readText() })
            val text = answer.optString("text")
            val heard = answer.optString("heard").ifBlank { text }
            Result.success(
                Answer(
                    text = text,
                    heard = heard,
                    ms = answer.optInt("ms"),
                    level = answer.optString("level").takeIf { it.isNotBlank() },
                    cleaned = if (answer.isNull("cleaned")) null else answer.optBoolean("cleaned"),
                    provider = answer.optString("provider").takeIf { it.isNotBlank() },
                    model = answer.optString("model").takeIf { it.isNotBlank() },
                ),
            )
        } catch (error: Exception) {
            Result.failure(IOException(error.message ?: UNREACHED))
        }
    }

    /** A take the Bubble abandoned still holds its bot until the host drops it. */
    fun cancel(take: String) {
        val connection = open("${bot.root}/dictation/$take", "DELETE", RELEASE_MS)
        try {
            connection.responseCode
            drain(connection)
        } catch (_: IOException) {
            // A cancel that cannot reach the host leaves the take to expire on its own.
        }
    }

    /**
     * The host's own bound on a Confirm, with a little room for the answer to travel: a host that has
     * stated one is held to it, and the floor stands in only where nothing has been asked yet.
     */
    private fun bound() = if (bot.waitMs > 0) bot.waitMs + 5_000 else BubbleConfig.DEFAULT_WAIT_MS

    private fun open(url: String, method: String, readMs: Int): HttpURLConnection {
        val connection = URL(url).openConnection() as HttpURLConnection
        connection.requestMethod = method
        connection.connectTimeout = 10_000
        connection.readTimeout = readMs
        connection.doInput = true
        if (bot.apiKey.isNotBlank()) connection.setRequestProperty("Authorization", "Bearer ${bot.apiKey}")
        return connection
    }

    /**
     * Reads the answer so the socket goes back to the pool. A take is a handful of requests and a
     * Piece is cut every second or so: a `disconnect()` per request pays a dial and a handshake for
     * each of them that the page's own `fetch` never does.
     */
    private fun drain(connection: HttpURLConnection) {
        runCatching {
            (if (connection.responseCode in 200..299) connection.inputStream else connection.errorStream)
                ?.use { it.readBytes() }
        }
    }

    private fun reason(connection: HttpURLConnection): String {
        val body = runCatching {
            connection.errorStream?.bufferedReader()?.use { it.readText() }
        }.getOrNull().orEmpty()
        val said = runCatching { JSONObject(body).optJSONObject("error")?.optString("message") }.getOrNull()
        return said?.takeIf { it.isNotBlank() } ?: connection.responseMessage.orEmpty()
    }

    private fun encode(value: String) = URLEncoder.encode(value, "UTF-8")

    private companion object {
        /** One hung Upload must not hold the take: the bound the host stated covers the rest. */
        const val UPLOAD_MS = 60_000
        /** How long a delete waits for the host to take the take back, as the page waits. */
        const val RELEASE_MS = 5_000
        const val TRIES = 3
        const val RETRY_MS = 400L
        const val UNREACHED = "The host could not be reached."
    }
}
