package dev.hermesgots

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
import com.capacitorjs.plugins.pushnotifications.PushNotificationsPlugin
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
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
 * plugin's (`plugin/notice.py`), relayed by the registry bounded and untouched, and read by [Notice].
 */
class GotsMessagingService : FirebaseMessagingService() {

    override fun onMessageReceived(message: RemoteMessage) {
        val notice = Notice.from(message.data, getString(R.string.app_name)) ?: return
        channelFor(notice.channel, notice.category)
        NoticeDrawer.post(this, notice.tag, entry(notice, pictureOf(notice)))
    }

    /** The entry itself: the notice's words, its picture, and a button for each of its links. */
    private fun entry(notice: Notice, picture: Bitmap?): Notification {
        val builder = NotificationCompat.Builder(this, notice.channel)
            // Android draws the small icon as a mask — one colour, its shape cut out of it — so it is a
            // silhouette, not the launcher icon, which is a picture and would be drawn as a black square.
            .setSmallIcon(R.drawable.ic_stat_notice)
            .setContentTitle(notice.title)
            .setContentText(notice.body)
            // An approval's body is the card's: a description, then the command on lines of its own. The
            // collapsed row shows the first, and opening it shows all of it.
            .setStyle(NotificationCompat.BigTextStyle().bigText(notice.body.ifEmpty { notice.title }))
            .setContentIntent(openIntent(notice.kind, notice.id, notice.tag))
            // A tap is the reader answering it: the row leaves the tray and nothing is left behind.
            .setAutoCancel(true)
        if (picture != null) builder.setLargeIcon(picture)
        for ((index, action) in notice.actions.withIndex()) {
            builder.addAction(
                NotificationCompat.Action(0, action.label, answerIntent(notice.tag, index, action.url)),
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
    private fun pictureOf(notice: Notice): Bitmap? {
        notice.icon?.let(::fetch)?.let { return it }
        val name = notice.bundled ?: return null
        val bundled = resources.getIdentifier(name, "drawable", packageName)
        return if (bundled == 0) null else BitmapFactory.decodeResource(resources, bundled)
    }

    /** The picture at an http(s) address, or null for a refusal or no network. */
    private fun fetch(icon: String): Bitmap? {
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

    companion object {
        /** What fetching a picture may cost the message thread, each way: a couple of seconds, no more. */
        private const val PICTURE_MS = 2_000

        /**
         * The categories that wait on the user, and so may peek: the same list Settings reads, where
         * every one of them is at importance 4 (`PUSH_CATEGORIES` in `src/lib/push-kinds.ts`).
         */
        private val WAITS = setOf("chat_input", "code_input", "room_input", "research_input")
    }
}
