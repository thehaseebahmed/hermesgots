package dev.hermesgots

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationManager
import android.content.Context
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person

/**
 * Where an entry goes into the tray and comes out of it, for the service that draws it and the
 * receivers that answer it: one id for every entry, told apart by the notice's [Notice.tag].
 */
object NoticeDrawer {
    /** The id every entry is posted under: the tag is what tells them apart, and what is cleared. */
    const val NOTICE_ID = 7301

    /**
     * Puts the entry in the tray, or nothing at all.
     *
     * A phone that refused `POST_NOTIFICATIONS` has switched this app's notifications off, and that
     * is a no-op rather than a crash: the grant is asked for by the app's own Notifications switch,
     * and a push that arrives before it is answered is news the reader has already let go of.
     */
    @SuppressLint("MissingPermission")
    fun post(context: Context, tag: String, notice: Notification) {
        val manager = NotificationManagerCompat.from(context)
        if (!manager.areNotificationsEnabled()) return
        try {
            // The tag is what makes a newer notice about the same thing replace the one still showing.
            manager.notify(tag, NOTICE_ID, notice)
        } catch (revoked: SecurityException) {
            // The grant went between the check and the post.
        }
    }

    fun clear(context: Context, tag: String) {
        runCatching { NotificationManagerCompat.from(context).cancel(tag, NOTICE_ID) }
    }

    /**
     * Posts the entry again with what became of its Reply ([ReplyOutcome]): the conversation as it
     * stands in the tray, plus [line] where there is one, and Reply only where [keepsReply]. It is rebuilt from the
     * active entry itself, since the receiver holds nothing else of the notice, and it doesn't alert
     * again. An entry the reader has already cleared is left cleared.
     */
    fun replied(context: Context, tag: String, line: ReplyLine?, keepsReply: Boolean) {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        val active = runCatching { manager.activeNotifications }.getOrNull()
            ?.firstOrNull { it.id == NOTICE_ID && it.tag == tag }?.notification ?: return
        val you = context.getString(R.string.notice_you)
        val style = NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(active)
            ?: NotificationCompat.MessagingStyle(Person.Builder().setName(you).build())
        // A null sender is the reader in a MessagingStyle; a note about the reply is the app's own.
        if (line != null) {
            val sender = if (line.fromReader) null else Person.Builder().setName(context.getString(R.string.app_name)).build()
            style.addMessage(line.text, System.currentTimeMillis(), sender)
        }
        val builder = NotificationCompat.Builder(context, NotificationCompat.getChannelId(active) ?: Notice.FALLBACK_CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_notice)
            .setContentTitle(active.extras.getCharSequence(Notification.EXTRA_TITLE))
            .setContentText(line?.text ?: active.extras.getCharSequence(Notification.EXTRA_TEXT))
            .setContentIntent(active.contentIntent)
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .setStyle(style)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
        NotificationCompat.getShortcutId(active)?.let(builder::setShortcutId)
        for (index in 0 until NotificationCompat.getActionCount(active)) {
            val action = NotificationCompat.getAction(active, index) ?: continue
            if (!keepsReply && action.semanticAction == NotificationCompat.Action.SEMANTIC_ACTION_REPLY) continue
            builder.addAction(action)
        }
        post(context, tag, builder.build())
    }
}
