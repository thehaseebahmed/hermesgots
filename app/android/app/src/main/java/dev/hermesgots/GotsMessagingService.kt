package dev.hermesgots

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.capacitorjs.plugins.pushnotifications.PushNotificationsPlugin
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import org.json.JSONArray
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/**
 * The phone's tray, drawn by the app rather than by Android.
 *
 * A push to the Android app arrives as a data-only message (`message` in `app/netlify/lib/fcm.ts`),
 * because a `notification` payload is drawn by Android itself, with no code of ours running, and
 * Android's own drawing has no room for a button — an approval could only be answered by opening
 * Gots. So this service draws the entry: the notice's title and the body under it, the bot's badged
 * picture as the large icon (the same file the browser's tray and ntfy wear, cut by
 * `app/scripts/build-badges.mjs`), the channel the app makes for the category, the tag a newer
 * notice about the same thing replaces, and the two buttons an approval carries, each posting its
 * own link through [NoticeAnswerReceiver] with the app closed.
 *
 * Nothing here decides anything: the kind, the id, the words, the picture and the buttons are the
 * plugin's (`plugin/notice.py`), relayed by the registry bounded and untouched.
 */
class GotsMessagingService : FirebaseMessagingService() {

    override fun onMessageReceived(message: RemoteMessage) {
        val data = message.data
        val title = data[KEY_TITLE].orEmpty().trim()
        val body = data[KEY_BODY].orEmpty().trim()
        // A message with nothing to say draws no row: the filter this service is declared with is a
        // public one, and a notice whose words went missing is one the reader can't act on.
        if (title.isEmpty() && body.isEmpty()) return
        val kind = data[KEY_KIND].orEmpty()
        val id = data[KEY_ID].orEmpty()
        val category = data[KEY_CATEGORY].orEmpty()
        val tag = data[KEY_TAG]?.takeIf { it.isNotBlank() } ?: "$category:$id"
        val channel =
            data[KEY_CHANNEL]?.takeIf { it.isNotBlank() } ?: category.ifEmpty { FALLBACK_CHANNEL }
        channelFor(channel, category)
        val notice = entry(
            kind = kind,
            id = id,
            tag = tag,
            channel = channel,
            title = title.ifEmpty { getString(R.string.app_name) },
            body = body,
            picture = pictureOf(data[KEY_ICON], data[KEY_BOT]),
            actions = actionsOf(data[KEY_ACTIONS]),
        )
        post(tag, notice)
    }

    /** The entry itself: the notice's words, its picture, and a button for each of its links. */
    private fun entry(
        kind: String,
        id: String,
        tag: String,
        channel: String,
        title: String,
        body: String,
        picture: Bitmap?,
        actions: List<Action>,
    ): Notification {
        val builder = NotificationCompat.Builder(this, channel)
            // Android draws the small icon as a mask — one colour, its shape cut out of it — so it is a
            // silhouette, not the launcher icon, which is a picture and would be drawn as a black square.
            .setSmallIcon(R.drawable.ic_stat_notice)
            .setContentTitle(title)
            .setContentText(body)
            // An approval's body is the card's: a description, then the command on lines of its own. The
            // collapsed row shows the first, and opening it shows all of it.
            .setStyle(NotificationCompat.BigTextStyle().bigText(body.ifEmpty { title }))
            .setContentIntent(openIntent(kind, id, tag))
            // A tap is the reader answering it: the row leaves the tray and nothing is left behind.
            .setAutoCancel(true)
        if (picture != null) builder.setLargeIcon(picture)
        for ((index, action) in actions.withIndex()) {
            builder.addAction(
                NotificationCompat.Action(0, action.label, answerIntent(tag, index, action.url)),
            )
        }
        return builder.build()
    }

    /**
     * What a tap opens: the app, told the kind and the id and never a route, so the screen is decided
     * there (`linkedPush` in `src/lib/push-kinds.ts`) — the same link ntfy's notification carries.
     */
    private fun openIntent(kind: String, id: String, tag: String): PendingIntent {
        val link = Uri.Builder()
            .scheme("gots")
            .authority("open")
            .appendQueryParameter("kind", kind)
            .appendQueryParameter("id", id)
            .build()
        val open = Intent(Intent.ACTION_VIEW, link).apply {
            // Gots is one task (`launchMode="singleTask"`), so a tap from the tray lands in the app that
            // is already there, which is what hands the link to the page (Capacitor's `appUrlOpen`).
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        }
        return PendingIntent.getActivity(this, tag.hashCode(), open, pendingFlags())
    }

    /** A button's broadcast, carrying the one link a press is allowed to post. */
    private fun answerIntent(tag: String, index: Int, url: String): PendingIntent {
        val answer = Intent(this, NoticeAnswerReceiver::class.java).apply {
            action = NoticeAnswerReceiver.ACTION_ANSWER
            putExtra(NoticeAnswerReceiver.EXTRA_URL, url)
            putExtra(NoticeAnswerReceiver.EXTRA_TAG, tag)
        }
        // Each button is its own broadcast, since a notification answered two ways is two links.
        return PendingIntent.getBroadcast(this, "$tag#$index".hashCode(), answer, pendingFlags())
    }

    private fun pendingFlags() = PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT

    /**
     * The channel the entry names, made only if the app hasn't made it yet.
     *
     * The app makes one for every category on its first launch (`channelPlan` in `src/lib/push.ts`),
     * with the names its own settings list them under; this is the fallback for one it hasn't made —
     * and Android keeps the importance a channel was first created with, so a channel the app made
     * stays at the app's own importance. What waits on the user peeks; news must not take the screen.
     */
    private fun channelFor(channel: String, category: String) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (manager.getNotificationChannel(channel) != null) return
        val importance =
            if (category in WAITS) NotificationManager.IMPORTANCE_HIGH
            else NotificationManager.IMPORTANCE_DEFAULT
        manager.createNotificationChannel(
            NotificationChannel(channel, channelName(channel), importance),
        )
    }

    /** A channel's name as Android's settings show it, until the app renames it on its next launch. */
    private fun channelName(channel: String) = "Gots " + channel.replace('_', ' ')

    /**
     * The badged picture, fetched from the app's own origin or taken from the copy the APK ships.
     *
     * A phone that can't reach the picture still draws the bot's face, and the entry is posted either
     * way. The fetch is bounded to [PICTURE_MS] each way because this runs on the message's own
     * thread: a tray entry a few seconds late beats one that never comes.
     */
    private fun pictureOf(icon: String?, bot: String?): Bitmap? {
        fetch(icon)?.let { return it }
        if (bot.isNullOrBlank()) return null
        // `build-badges.mjs` writes the APK's copy under the bot's id, its hyphen as an underscore
        // since a resource name carries none.
        val bundled = resources.getIdentifier("bot_" + bot.replace('-', '_'), "drawable", packageName)
        return if (bundled == 0) null else BitmapFactory.decodeResource(resources, bundled)
    }

    /** The picture at an http(s) address, or null for anything else, a refusal, or no network. */
    private fun fetch(icon: String?): Bitmap? {
        if (icon == null || !(icon.startsWith("https://") || icon.startsWith("http://"))) return null
        val connection = try {
            URL(icon).openConnection() as HttpURLConnection
        } catch (error: IOException) {
            return null
        } catch (error: SecurityException) {
            return null
        }
        return try {
            connection.connectTimeout = PICTURE_MS
            connection.readTimeout = PICTURE_MS
            if (connection.responseCode != HttpURLConnection.HTTP_OK) null
            else BitmapFactory.decodeStream(connection.inputStream)
        } catch (error: IOException) {
            null
        } finally {
            runCatching { connection.disconnect() }
        }
    }

    /**
     * A new registration id, handed to the push plugin's own static so the page still hears it.
     *
     * This build's service replaced the plugin's on `MESSAGING_EVENT` (see `AndroidManifest.xml`),
     * so a rotated token would otherwise never reach the page that sends it to the registry. The
     * plugin keeps the bridge and the `registration` listener; its static is null-safe and answers
     * nothing while the app isn't running.
     */
    override fun onNewToken(token: String) {
        super.onNewToken(token)
        PushNotificationsPlugin.onNewToken(token)
    }

    /** A message's buttons: at most two, each a label and an http(s) link, as the registry bounded them. */
    private fun actionsOf(raw: String?): List<Action> {
        if (raw.isNullOrBlank()) return emptyList()
        val rows = try {
            JSONArray(raw)
        } catch (bad: Exception) {
            // A payload we can't read is a notice with no buttons, never a dropped notification.
            return emptyList()
        }
        val actions = ArrayList<Action>(ACTION_LIMIT)
        for (index in 0 until rows.length()) {
            if (actions.size == ACTION_LIMIT) break
            val row = rows.optJSONObject(index) ?: continue
            val label = row.optString("label").trim()
            val url = row.optString("url").trim()
            // Only a link can be posted; anything else is a button that would do nothing.
            if (label.isEmpty() || !(url.startsWith("https://") || url.startsWith("http://"))) continue
            actions.add(Action(label, url))
        }
        return actions
    }

    /**
     * Puts the entry in the tray, or nothing at all.
     *
     * A phone that refused `POST_NOTIFICATIONS` has switched this app's notifications off, and that
     * is a no-op rather than a crash: the grant is asked for by the app's own Notifications switch,
     * and a push that arrives before it is answered is news the reader has already let go of.
     */
    @SuppressLint("MissingPermission")
    private fun post(tag: String, notice: Notification) {
        val manager = NotificationManagerCompat.from(this)
        if (!manager.areNotificationsEnabled()) return
        try {
            // The tag is what makes a newer notice about the same thing replace the one still showing.
            manager.notify(tag, NOTICE_ID, notice)
        } catch (revoked: SecurityException) {
            // The grant went between the check and the post.
        }
    }

    /** One button a notice carries: what it says, and the link a press posts. */
    private class Action(val label: String, val url: String)

    companion object {
        /** The id every entry is posted under: the tag is what tells them apart, and what is cleared. */
        const val NOTICE_ID = 7301

        private const val ACTION_LIMIT = 2

        /** What fetching a picture may cost the message thread, each way: a couple of seconds, no more. */
        private const val PICTURE_MS = 2_000

        /** A message naming no channel at all still has to name one on Android 8 and later. */
        private const val FALLBACK_CHANNEL = "gots"

        /**
         * The categories that wait on the user, and so may peek: the same list Settings reads, where
         * every one of them is at importance 4 (`PUSH_CATEGORIES` in `src/lib/push-kinds.ts`).
         */
        private val WAITS = setOf("chat_input", "code_input", "room_input", "research_input")

        // The message's data, as `app/netlify/lib/fcm.ts` writes it.
        private const val KEY_KIND = "kind"
        private const val KEY_ID = "session_id"
        private const val KEY_TITLE = "title"
        private const val KEY_BODY = "body"
        private const val KEY_ICON = "icon"
        private const val KEY_BOT = "bot"
        private const val KEY_CATEGORY = "category"
        private const val KEY_CHANNEL = "channel"
        private const val KEY_TAG = "tag"
        private const val KEY_ACTIONS = "actions"
    }
}
