package dev.hermesgots

import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

/**
 * The Mark as read presses the tray has queued for the page, with no Android type in it.
 *
 * A press can't move a read mark itself — the marks are the page's, in its own storage — so the
 * receiver appends `{chat, at, through}` here (the press, and the moment the notice covered) and the
 * page takes the queue the next time it runs (`TrayPlugin`, `src/lib/tray-marks.ts`). Bounded, since
 * a page that never runs again must not leave the preferences growing: the newest presses are kept.
 */
object TrayReads {
    /** Where the queue is kept: the app's own preferences, under one key. */
    const val PREFS = "dev.hermesgots.tray"
    const val KEY = "reads"

    /** The most presses waiting for the page; a press past it drops the oldest. */
    const val LIMIT = 50

    /** The queue with one press appended, as the string it is kept as. */
    fun append(stored: String?, chat: String, at: Long, through: Long?): String {
        val rows = try {
            if (stored.isNullOrBlank()) JSONArray() else JSONArray(stored)
        } catch (bad: JSONException) {
            // A queue that can't be read is one nothing can drain: it starts over rather than grow.
            JSONArray()
        }
        val row = JSONObject().put("chat", chat).put("at", at)
        if (through != null) row.put("through", through)
        rows.put(row)
        val kept = JSONArray()
        for (index in maxOf(0, rows.length() - LIMIT) until rows.length()) kept.put(rows.get(index))
        return kept.toString()
    }
}
