package dev.hermesgots

import org.json.JSONArray
import org.junit.Assert.assertEquals
import org.junit.Test

class TrayDismissesTest {

    private fun rows(stored: String) = JSONArray(stored).let { array ->
        (0 until array.length()).map { array.getJSONObject(it) }
    }

    @Test
    fun aSwipeIsQueuedAndTakenBack() {
        var stored = TrayDismisses.append(null, "gots-chat-1", 1_000L)
        stored = TrayDismisses.append(stored, "job-2", 2_000L)
        val queued = rows(stored)
        assertEquals(listOf("gots-chat-1", "job-2"), queued.map { it.getString("subject") })
        assertEquals(1_000L, queued[0].getLong("at"))
        // The subject is the tag's last segment, which is all a swipe's intent carries.
        assertEquals(2_000L, queued[1].getLong("at"))
    }

    @Test
    fun theQueueKeepsItsNewestSwipesUpToItsBound() {
        var stored: String? = null
        for (index in 0 until TrayDismisses.LIMIT + 5)
            stored = TrayDismisses.append(stored, "s$index", index + 1L)
        val queued = rows(stored!!)
        assertEquals(TrayDismisses.LIMIT, queued.size)
        assertEquals("s5", queued.first().getString("subject"))
        assertEquals("s${TrayDismisses.LIMIT + 4}", queued.last().getString("subject"))
    }

    @Test
    fun aQueueThatCannotBeReadStartsOver() {
        assertEquals(
            listOf("gots-chat-1"),
            rows(TrayDismisses.append("not json", "gots-chat-1", 1L)).map { it.getString("subject") },
        )
    }
}
