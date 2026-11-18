package dev.hermesgots

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
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
        assertEquals("https://app.example/bots/nova/happy.png", read("title" to "t", "icon" to "https://app.example/bots/nova/happy.png")!!.icon)
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

    @Test
    fun aMessageNamingAChatIsAConversation() {
        val notice = read("title" to "Trip", "body" to "Booked.", "chat" to " 6b0f2c1e-9a4d ")!!
        assertEquals("6b0f2c1e-9a4d", notice.chat)
        assertEquals("chat:6b0f2c1e-9a4d", notice.shortcut)
        assertTrue("drawn as a conversation", notice.conversation)
        // The bot is the conversation's Person, which Android draws on the left with the app's badge:
        // a large icon beside it would be the same face twice.
        assertFalse("no large icon on a conversation", notice.largeIcon)
    }

    @Test
    fun aMessageNamingNoChatKeepsTodaysEntryWithTheFaceAsItsLargeIcon() {
        for (chat in listOf(null, "", "  ", "../../etc", "a b", "x".repeat(257))) {
            val pairs = listOfNotNull("title" to "Research", chat?.let { "chat" to it })
            val notice = read(*pairs.toTypedArray())!!
            assertNull("$chat is no chat", notice.chat)
            assertNull(notice.shortcut)
            assertFalse(notice.conversation)
            assertTrue("the plain face is the large icon", notice.largeIcon)
        }
    }

    @Test
    fun aMessageWithAReplyLinkDrawsAnInlineReply() {
        val link = "https://bot.example/api/plugins/gots/push/reply/r-1"
        val notice = read("title" to "Trip", "body" to "Booked.", "chat" to "chat-1", "reply" to " $link ")!!
        assertEquals(link, notice.reply)
        assertTrue("a chat's notice with a reply link offers Reply", notice.inlineReply)
        for (reply in listOf("javascript:alert(1)", "bot.example/reply", "", "  ")) {
            val bad = read("title" to "Trip", "chat" to "chat-1", "reply" to reply)!!
            assertNull("$reply is no link", bad.reply)
            assertFalse(bad.inlineReply)
        }
        // A reply is a message in a chat, so a notice naming no chat offers none, whatever it carries.
        assertFalse(read("title" to "Trip", "reply" to link)!!.inlineReply)
        assertFalse(read("title" to "Trip", "chat" to "chat-1")!!.inlineReply)
    }

    @Test
    fun aChatsNewsCarryingReadOffersMarkAsRead() {
        val notice = read("title" to "Trip", "chat" to "chat-1", "read" to "true", "at" to "1763456000000")!!
        assertTrue("a chat's news the plugin marked readable offers Mark as read", notice.markAsRead)
        assertEquals(1763456000000L, notice.at)
        // Only the plugin's word: anything but "true" is no Mark as read, and Mark as read moves a chat.
        assertFalse(read("title" to "Trip", "chat" to "chat-1", "read" to "yes")!!.markAsRead)
        assertFalse(read("title" to "Trip", "chat" to "chat-1")!!.markAsRead)
        assertFalse(read("title" to "Trip", "read" to "true")!!.markAsRead)
        for (at in listOf("-1", "0", "soon", "", "1.5")) {
            assertNull("$at is no moment", read("title" to "Trip", "chat" to "chat-1", "at" to at)!!.at)
        }
    }

    @Test
    fun aFaceIsPaddedIntoTheAdaptiveSafeZone() {
        // An adaptive icon is 108 units with its inner 72 the part every mask keeps, so a face drawn
        // whole sits in the middle two thirds of a canvas half as large again.
        assertEquals(AdaptiveFace(side = 288, inset = 48), Notice.adaptiveFace(192))
        assertEquals(AdaptiveFace(side = 384, inset = 64), Notice.adaptiveFace(256))
        assertEquals(AdaptiveFace(side = 3, inset = 1), Notice.adaptiveFace(1))
    }

    private companion object {
        const val APP = "Gots"
    }
}
