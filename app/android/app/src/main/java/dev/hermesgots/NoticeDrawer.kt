package dev.hermesgots

import android.annotation.SuppressLint
import android.app.Notification
import android.content.Context
import androidx.core.app.NotificationManagerCompat

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

    /** Takes an answered entry out of the tray. */
    fun clear(context: Context, tag: String) {
        runCatching { NotificationManagerCompat.from(context).cancel(tag, NOTICE_ID) }
    }
}
