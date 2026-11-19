package dev.hermesgots

import org.json.JSONArray
import org.junit.Assert.assertEquals
import org.junit.Test

class TrayReadsTest {

    private fun rows(stored: String) = JSONArray(stored).let { array ->
        (0 until array.length()).map { array.getJSONObject(it) }
    }

    @Test
    fun aPressIsQueuedAndTakenBack() {
        var stored = TrayReads.append(null, "chat-1", 1_000L, 900L)
        stored = TrayReads.append(stored, "chat-2", 2_000L, null)
        val queued = rows(stored)
        assertEquals(listOf("chat-1", "chat-2"), queued.map { it.getString("chat") })
        assertEquals(1_000L, queued[0].getLong("at"))
        assertEquals(900L, queued[0].getLong("through"))
        // A press whose notice named no moment carries the press alone.
        assertEquals(false, queued[1].has("through"))
    }

    @Test
    fun theQueueKeepsItsNewestPressesUpToItsBound() {
        var stored: String? = null
        for (index in 0 until TrayReads.LIMIT + 5) stored = TrayReads.append(stored, "chat-$index", index + 1L, null)
        val queued = rows(stored!!)
        assertEquals(TrayReads.LIMIT, queued.size)
        assertEquals("chat-5", queued.first().getString("chat"))
        assertEquals("chat-${TrayReads.LIMIT + 4}", queued.last().getString("chat"))
    }

    @Test
    fun aQueueThatCannotBeReadStartsOver() {
        assertEquals(listOf("chat-1"), rows(TrayReads.append("not json", "chat-1", 1L, null)).map { it.getString("chat") })
    }
}
