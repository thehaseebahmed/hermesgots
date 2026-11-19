package dev.hermesgots

import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

/**
 * The swipes the tray has queued for the page, with no Android type in it.
 *
 * A swipe can't tell the account itself — the receiver holds no key of the account's, as a press of
 * a button's link doesn't — so it appends `{subject, at}` here (the id the entry was about, the last
 * segment of its tag) and the page takes the queue the next time it runs (`TrayPlugin`,
 * `src/lib/push.ts`), which tells the account the subject is no news (ADR 0169). Bounded, since a
 * page that never runs again must not leave the preferences growing: the newest swipes are kept.
 */
object TrayDismisses {
    /** Where the queue is kept: the app's own preferences, beside the reads, under its own key. */
    const val PREFS = TrayReads.PREFS
    const val KEY = "dismisses"

    /** The most swipes waiting for the page; a swipe past it drops the oldest. */
    const val LIMIT = 50

    /** The queue with one swipe appended, as the string it is kept as. */
    fun append(stored: String?, subject: String, at: Long): String {
        val rows = try {
            if (stored.isNullOrBlank()) JSONArray() else JSONArray(stored)
        } catch (bad: JSONException) {
            // A queue that can't be read is one nothing can drain: it starts over rather than grow.
            JSONArray()
        }
        rows.put(JSONObject().put("subject", subject).put("at", at))
        val kept = JSONArray()
        for (index in maxOf(0, rows.length() - LIMIT) until rows.length()) kept.put(rows.get(index))
        return kept.toString()
    }
}
