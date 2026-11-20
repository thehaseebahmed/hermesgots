package dev.hermesgots

import android.content.Intent
import android.net.Uri

/**
 * The link that opens what a notice is about: `gots://open?kind=&id=`, which the page reads as
 * `linkedPush` (`src/lib/push-kinds.ts`) and turns into the screen the kind and the id name. It
 * carries no route, so where it lands is decided in the app, the same as every other tap.
 *
 * Built here once because two things open one: a tap on the tray entry, and the charm's answer to a
 * tap the phone could not answer at the time. The answer names only the session, so its link carries
 * no kind — which is the same link a notice with no kind builds.
 */
object NoticeOpen {
    /** The `gots://open` intent for [id], of [kind] where the caller knows one. */
    fun link(kind: String?, id: String): Intent {
        val link = Uri.Builder().scheme("gots").authority("open")
        if (kind != null) link.appendQueryParameter("kind", kind)
        link.appendQueryParameter("id", id)
        return Intent(Intent.ACTION_VIEW, link.build()).apply {
            // Gots is one task (`launchMode="singleTask"`), so a link from outside lands in the app
            // that is already there, which is what hands it to the page (Capacitor's `appUrlOpen`).
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        }
    }
}
