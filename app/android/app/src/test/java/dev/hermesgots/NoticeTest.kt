package dev.hermesgots

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class NoticeTest {

    private fun read(vararg pairs: Pair<String, String>) = Notice.from(mapOf(*pairs), APP)

    @Test
    fun anEmptyNoticeDrawsNothing() {
        assertNull(read())
        assertNull(read("title" to "  ", "body" to "\n", "kind" to "run_done", "session_id" to "s1"))
    }

    @Test
    fun aNoticeWithWordsKeepsThemTrimmed() {
        val notice = read("title" to " Lisbon weekend ", "body" to " Done. \n")!!
        assertEquals("Lisbon weekend", notice.title)
        assertEquals("Done.", notice.body)
    }

    @Test
    fun aNoticeWithNoTitleIsTitledWithTheApp() {
        assertEquals(APP, read("body" to "Done.")!!.title)
        assertEquals("", read("title" to "Plan")!!.body)
    }

    @Test
    fun aTagFallsBackToCategoryAndId() {
        val base = arrayOf("title" to "t", "category" to "chat_run_done", "session_id" to "s1")
        assertEquals("chat_run_done:s1", read(*base)!!.tag)
        assertEquals("chat_run_done:s1", read(*base, "tag" to "  ")!!.tag)
        assertEquals("approval:r9", read(*base, "tag" to "approval:r9")!!.tag)
    }

    @Test
    fun aChannelFallsBackToTheCategoryThenToGots() {
        assertEquals("code_input", read("title" to "t", "category" to "code_input")!!.channel)
        assertEquals(
            "test_notification",
            read("title" to "t", "category" to "code_input", "channel" to "test_notification")!!.channel,
        )
        assertEquals(Notice.FALLBACK_CHANNEL, read("title" to "t")!!.channel)
    }

    @Test
    fun theKindIdAndCategoryAreCarriedAsSent() {
        val notice = read("title" to "t", "kind" to "approval", "session_id" to "s1", "category" to "chat_input")!!
        assertEquals("approval", notice.kind)
        assertEquals("s1", notice.id)
        assertEquals("chat_input", notice.category)
    }

    @Test
    fun twoActionsAtMostHttpOnly() {
        val actions = """[
            {"label": "Allow once", "url": "https://host.example/push/answer/a"},
            {"label": "Run it", "url": "javascript:alert(1)"},
            {"label": "", "url": "https://host.example/push/answer/b"},
            "not a row",
            {"label": " Deny ", "url": " http://lan.example/push/answer/c "},
            {"label": "Third", "url": "https://host.example/push/answer/d"}
        ]"""
        assertEquals(
            listOf(
                NoticeAction("Allow once", "https://host.example/push/answer/a"),
                NoticeAction("Deny", "http://lan.example/push/answer/c"),
            ),
            read("title" to "t", "actions" to actions)!!.actions,
        )
    }

    @Test
    fun actionsThatCannotBeReadAreNoButtonsNotADroppedNotice() {
        assertEquals(emptyList<NoticeAction>(), read("title" to "t", "actions" to "{oops")!!.actions)
        assertEquals(emptyList<NoticeAction>(), read("title" to "t", "actions" to "")!!.actions)
        assertEquals(emptyList<NoticeAction>(), read("title" to "t")!!.actions)
    }

    @Test
    fun thePictureIsAnHttpAddressOrNone() {
        assertEquals("https://app.example/bots/nova/notify.png", read("title" to "t", "icon" to "https://app.example/bots/nova/notify.png")!!.icon)
        assertEquals("http://lan.example/n.png", read("title" to "t", "icon" to "http://lan.example/n.png")!!.icon)
        assertNull(read("title" to "t", "icon" to "file:///sdcard/x.png")!!.icon)
        assertNull(read("title" to "t")!!.icon)
    }

    @Test
    fun theBundledPictureIsNamedForTheBotWithNoHyphen() {
        assertEquals("bot_nova", read("title" to "t", "bot" to "nova")!!.bundled)
        assertEquals("bot_sun_ray", read("title" to "t", "bot" to "sun-ray")!!.bundled)
        assertNull(read("title" to "t", "bot" to " ")!!.bundled)
        assertNull(read("title" to "t")!!.bundled)
        assertNotNull(read("title" to "t", "bot" to "pip")!!.bundled)
    }

    private companion object {
        const val APP = "Gots"
    }
}
