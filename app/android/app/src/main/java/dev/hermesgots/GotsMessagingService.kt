package dev.hermesgots

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Rect
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.Person
import androidx.core.app.RemoteInput
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
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
 * Gots. So this service draws the entry: the notice's title and the body under it, the bot's plain
 * face (`happy.png`, or the copy `app/scripts/build-badges.mjs` ships), the channel the app makes for
 * the category, the tag a newer notice about the same thing replaces, and the two buttons an
 * approval carries, each posting its own link through [NoticeAnswerReceiver] with the app closed, and
 * a chat's Reply, typed inline and posted to its own one-shot link the same way, and its Mark as
 * read, which queues the press for the page and leaves the tray. A
 * notice about a chat is drawn as that chat's conversation, the bot its Person, so Android badges
 * the face with the app's icon itself; any other keeps the face as its large icon.
 *
 * Nothing here decides anything: the kind, the id, the words, the picture and the buttons are the
 * plugin's (`plugin/notice.py`), relayed by the registry bounded and untouched, and read by [Notice].
 */
class GotsMessagingService : FirebaseMessagingService() {

    override fun onMessageReceived(message: RemoteMessage) {
        // A clear is not a notice: it carries no words, and takes the entries about its subject out
        // of the tray — the account was told a subject is no news, and this phone answers it
        // (ADR 0169). It is read before [Notice.from], which answers null for a message with none.
        val subject = Notice.clearSubject(message.data)
        if (subject != null) {
            NoticeDrawer.clearSubject(this, subject)
            // The charm's record goes with the tray's: another device settled this subject, so the
            // face it still holds is no longer news. Asked after the tray is clear, and where a
            // charm that cannot be written throws nothing into that work — a phone with no charm
            // saved, Bluetooth off or a lost grant all leave the tray entry exactly as it is.
            runCatching { CharmNotifier.clear(this, subject) }
            return
        }
        val notice = Notice.from(message.data, getString(R.string.app_name)) ?: return
        channelFor(notice.channel, notice.category)
        NoticeDrawer.post(this, notice.tag, entry(notice, pictureOf(notice)))
        // The moment the notice reports, on the charm as well as in the tray. It is asked for after
        // the entry is drawn and can never throw into it: an alert for a wrist is a bonus beside the
        // notice, never a reason to lose one.
        charmAlert(notice)
    }

    /**
     * Hands a notice that carries both a bot and a reason to the charm. The subject is the id the
     * notice is about — the one a clear for it names — so the record and its clear cannot disagree.
     * The title and the body are the words the tray entry shows, so the charm reads like the
     * notification. A notice with either field missing, or with neither, is tray news only.
     */
    private fun charmAlert(notice: Notice) {
        val bot = notice.charm ?: return
        val reason = notice.charmReason ?: return
        if (notice.id.isBlank()) return
        runCatching {
            CharmNotifier.alert(this, bot, reason, notice.id, notice.title, notice.body)
        }
    }

    /**
     * The entry itself: the notice's words, its picture, and a button for each of its links. A notice
     * about a chat is that chat's conversation — the bot a [Person] wearing its face, a long-lived
     * shortcut linked to the entry — and anything else keeps the plain entry, the face beside it.
     */
    private fun entry(notice: Notice, picture: Bitmap?): Notification {
        val builder = NotificationCompat.Builder(this, notice.channel)
            // Android draws the small icon as a mask — one colour, its shape cut out of it — so it is a
            // silhouette, not the launcher icon, which is a picture and would be drawn as a black square.
            .setSmallIcon(R.drawable.ic_stat_notice)
            .setContentTitle(notice.title)
            .setContentText(notice.body)
            .setContentIntent(openIntent(notice.kind, notice.id, notice.tag))
            // A tap is the reader answering it: the row leaves the tray and nothing is left behind.
            .setAutoCancel(true)
            // So is a swipe, which queues the subject for the page to tell the account (ADR 0169).
            .setDeleteIntent(dismissIntent(notice.tag))
        val shortcut = notice.shortcut
        if (shortcut != null) {
            val face = picture?.let { IconCompat.createWithAdaptiveBitmap(adaptive(it)) }
            val bot = Person.Builder()
                // The plugin doesn't know the name the reader gave the bot, so the conversation is the
                // chat's, as a messaging app names a one-to-one chat by its contact.
                .setName(notice.title)
                .setKey(shortcut)
                .setIcon(face)
                .setBot(true)
                .build()
            conversation(shortcut, notice, bot, face)
            builder
                .setStyle(
                    NotificationCompat.MessagingStyle(Person.Builder().setName(getString(R.string.notice_you)).build())
                        .addMessage(notice.body.ifEmpty { notice.title }, System.currentTimeMillis(), bot),
                )
                .setShortcutId(shortcut)
                .setCategory(NotificationCompat.CATEGORY_MESSAGE)
        } else {
            // An approval's body is the card's: a description, then the command on lines of its own.
            // The collapsed row shows the first, and opening it shows all of it.
            builder.setStyle(NotificationCompat.BigTextStyle().bigText(notice.body.ifEmpty { notice.title }))
        }
        if (notice.largeIcon && picture != null) builder.setLargeIcon(picture)
        val reply = notice.reply
        if (notice.inlineReply && reply != null) {
            val typed = RemoteInput.Builder(NoticeAnswerReceiver.KEY_TEXT)
                .setLabel(getString(R.string.notice_reply))
                .build()
            builder.addAction(
                NotificationCompat.Action.Builder(0, getString(R.string.notice_reply), replyIntent(notice.tag, reply))
                    .addRemoteInput(typed)
                    .setAllowGeneratedReplies(false)
                    .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_REPLY)
                    .build(),
            )
        }
        val chat = notice.chat
        if (notice.markAsRead && chat != null) {
            builder.addAction(
                NotificationCompat.Action.Builder(0, getString(R.string.notice_mark_read), readIntent(notice.tag, chat, notice.at))
                    .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_MARK_AS_READ)
                    .setShowsUserInterface(false)
                    .build(),
            )
        }
        for ((index, action) in notice.actions.withIndex()) {
            builder.addAction(
                NotificationCompat.Action(0, action.label, answerIntent(notice.tag, index, action.url)),
            )
        }
        return builder.build()
    }

    /**
     * The chat's long-lived shortcut, pushed before the entry names it: Android files a notification
     * under Conversations only when the shortcut it names exists, is long-lived and carries the Person.
     * Labelled with the chat's title and opening what a tap opens. Pushing it again replaces it, and a
     * launcher that keeps no more shortcuts drops the oldest — the entry is drawn either way.
     */
    private fun conversation(id: String, notice: Notice, bot: Person, face: IconCompat?) {
        val shortcut = ShortcutInfoCompat.Builder(this, id)
            .setShortLabel(notice.title)
            .setLongLived(true)
            .setPerson(bot)
            .setIntent(openLink(notice.kind, notice.id))
            .setCategories(setOf(SHORTCUT_CATEGORY))
        if (face != null) shortcut.setIcon(face)
        runCatching { ShortcutManagerCompat.pushDynamicShortcut(this, shortcut.build()) }
    }

    /** The face padded into an adaptive icon's safe zone, so a launcher's mask never cuts it. */
    private fun adaptive(face: Bitmap): Bitmap {
        val laid = Notice.adaptiveFace(maxOf(face.width, face.height))
        val canvas = Bitmap.createBitmap(laid.side, laid.side, Bitmap.Config.ARGB_8888)
        val inner = laid.side - 2 * laid.inset
        Canvas(canvas).drawBitmap(
            face,
            null,
            Rect(laid.inset, laid.inset, laid.inset + inner, laid.inset + inner),
            Paint(Paint.FILTER_BITMAP_FLAG),
        )
        return canvas
    }

    /**
     * What a tap opens: the app, told the kind and the id and never a route, so the screen is decided
     * there (`linkedPush` in `src/lib/push-kinds.ts`) — the same link ntfy's notification carries.
     */
    private fun openIntent(kind: String, id: String, tag: String): PendingIntent =
        PendingIntent.getActivity(this, tag.hashCode(), openLink(kind, id), pendingFlags())

    /** The `gots://open` link a tap and a chat's shortcut both open, built in one place with the charm. */
    private fun openLink(kind: String, id: String): Intent = NoticeOpen.link(kind, id)

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

    /**
     * A swipe's broadcast, carrying the tag of the entry put away: the subject it names is queued for
     * the page, which tells the account it is no news (ADR 0169). A press of it holds no key of the
     * account's — as a button's does not — so the host can't be told from here.
     */
    private fun dismissIntent(tag: String): PendingIntent {
        val dismiss = Intent(this, NoticeAnswerReceiver::class.java).apply {
            action = NoticeAnswerReceiver.ACTION_DISMISS
            putExtra(NoticeAnswerReceiver.EXTRA_TAG, tag)
        }
        return PendingIntent.getBroadcast(this, "$tag#dismiss".hashCode(), dismiss, pendingFlags())
    }

    /** Mark as read's broadcast: the chat whose read mark it moves, and the moment the notice covered. */
    private fun readIntent(tag: String, chat: String, at: Long?): PendingIntent {
        val read = Intent(this, NoticeAnswerReceiver::class.java).apply {
            action = NoticeAnswerReceiver.ACTION_READ
            putExtra(NoticeAnswerReceiver.EXTRA_TAG, tag)
            putExtra(NoticeAnswerReceiver.EXTRA_CHAT, chat)
            if (at != null) putExtra(NoticeAnswerReceiver.EXTRA_AT, at)
        }
        return PendingIntent.getBroadcast(this, "$tag#read".hashCode(), read, pendingFlags())
    }

    /**
     * Reply's broadcast, carrying the one link the typed text is posted to. A RemoteInput fills the
     * intent in with what was typed, so this one intent is mutable where Android asks it to say so.
     */
    private fun replyIntent(tag: String, url: String): PendingIntent {
        val reply = Intent(this, NoticeAnswerReceiver::class.java).apply {
            action = NoticeAnswerReceiver.ACTION_REPLY
            putExtra(NoticeAnswerReceiver.EXTRA_URL, url)
            putExtra(NoticeAnswerReceiver.EXTRA_TAG, tag)
        }
        val mutable =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0
        return PendingIntent.getBroadcast(
            this,
            "$tag#reply".hashCode(),
            reply,
            mutable or PendingIntent.FLAG_UPDATE_CURRENT,
        )
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
     * The bot's plain face, fetched from the app's own origin or taken from the copy the APK ships.
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
        /** The category Android files a conversation's shortcut under (`Notification.CATEGORY_MESSAGE`'s). */
        private const val SHORTCUT_CATEGORY = "android.shortcut.conversation"

        /** What fetching a picture may cost the message thread, each way: a couple of seconds, no more. */
        private const val PICTURE_MS = 2_000

        /**
         * The categories that wait on the user, and so may peek: the same list Settings reads, where
         * every one of them is at importance 4 (`PUSH_CATEGORIES` in `src/lib/push-kinds.ts`).
         */
        private val WAITS = setOf("chat_input", "code_input", "room_input", "research_input")
    }
}
