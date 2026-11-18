package dev.hermesgots

import org.json.JSONArray

/**
 * A push's data, read into what the tray draws, with no Android type in it.
 *
 * The message is the registry's (`message` in `app/netlify/lib/fcm.ts`), which bounded it already;
 * this keeps the same rules where they are used, so a payload that reached the phone some other way
 * still draws nothing it shouldn't. [GotsMessagingService] draws from it and decides nothing more.
 */
data class Notice(
    val kind: String,
    val id: String,
    val category: String,
    /** What a newer notice about the same thing replaces, and what a press clears. */
    val tag: String,
    val channel: String,
    val title: String,
    val body: String,
    /** The bot's plain picture at the app's own origin, an http(s) address or nothing. */
    val icon: String?,
    /** The drawable the APK ships for the bot, for a phone that can't fetch [icon]. */
    val bundled: String?,
    val actions: List<NoticeAction>,
    /** The chat the notice is about, as the plugin found it: what the conversation is keyed by. */
    val chat: String? = null,
) {
    /**
     * A notice about a chat is drawn as that chat's conversation — the bot as its Person, a
     * long-lived shortcut per chat — which is what puts it in Android's Conversations section, with the
     * bot's face on the left and the app's badge on it. Anything else keeps the plain entry.
     */
    val conversation: Boolean get() = chat != null

    /** The chat's long-lived shortcut: one per chat, so a newer notice about it reuses the same one. */
    val shortcut: String? get() = chat?.let { "chat:$it" }

    /** A conversation already wears the face as its Person; a large icon would draw it twice. */
    val largeIcon: Boolean get() = !conversation

    companion object {
        /** A message naming no channel at all still has to name one on Android 8 and later. */
        const val FALLBACK_CHANNEL = "gots"

        private const val ACTION_LIMIT = 2

        /** A chat's id as the plugin keeps them and the registry bounds them (`chatId` in `fcm.ts`). */
        private val CHAT = Regex("^[A-Za-z0-9._-]{1,256}$")

        /**
         * The notice a message carries, or null for one with nothing to say: the filter the service is
         * declared with is a public one, and a notice whose words went missing is one the reader can't
         * act on. [app] titles a notice that came with a body and no title.
         */
        fun from(data: Map<String, String>, app: String): Notice? {
            val title = data[KEY_TITLE].orEmpty().trim()
            val body = data[KEY_BODY].orEmpty().trim()
            if (title.isEmpty() && body.isEmpty()) return null
            val id = data[KEY_ID].orEmpty()
            val category = data[KEY_CATEGORY].orEmpty()
            return Notice(
                kind = data[KEY_KIND].orEmpty(),
                id = id,
                category = category,
                tag = data[KEY_TAG]?.takeIf { it.isNotBlank() } ?: "$category:$id",
                channel = data[KEY_CHANNEL]?.takeIf { it.isNotBlank() }
                    ?: category.ifEmpty { FALLBACK_CHANNEL },
                title = title.ifEmpty { app },
                body = body,
                icon = data[KEY_ICON]?.takeIf(::isLink),
                // `build-badges.mjs` writes the APK's copy under the bot's id, its hyphen as an
                // underscore since a resource name carries none.
                bundled = data[KEY_BOT]?.takeIf { it.isNotBlank() }?.let { "bot_" + it.replace('-', '_') },
                actions = actionsOf(data[KEY_ACTIONS]),
                chat = data[KEY_CHAT]?.trim()?.takeIf { CHAT.matches(it) },
            )
        }

        /**
         * Where a face of [side] pixels sits in an adaptive icon: an adaptive icon is 108 units with
         * the inner 72 the part every launcher's mask keeps, so the canvas is half as large again and
         * the face is inset a sixth of it on every side, drawn whole.
         */
        fun adaptiveFace(side: Int): AdaptiveFace {
            // 72 + 2 × 18 = 108: a quarter of the face on each edge, rounded up so it is never cut.
            val inset = (side + 3) / 4
            return AdaptiveFace(side + 2 * inset, inset)
        }

        /** Whether an address is one the phone may fetch or post: http(s), and nothing else. */
        fun isLink(url: String) = url.startsWith("https://") || url.startsWith("http://")

        /** A message's buttons: at most two, each a label and an http(s) link. */
        private fun actionsOf(raw: String?): List<NoticeAction> {
            if (raw.isNullOrBlank()) return emptyList()
            val rows = try {
                JSONArray(raw)
            } catch (bad: Exception) {
                // A payload we can't read is a notice with no buttons, never a dropped notification.
                return emptyList()
            }
            val actions = ArrayList<NoticeAction>(ACTION_LIMIT)
            for (index in 0 until rows.length()) {
                if (actions.size == ACTION_LIMIT) break
                val row = rows.optJSONObject(index) ?: continue
                val label = row.optString("label").trim()
                val url = row.optString("url").trim()
                // Only a link can be posted; anything else is a button that would do nothing.
                if (label.isEmpty() || !isLink(url)) continue
                actions.add(NoticeAction(label, url))
            }
            return actions
        }

        // The message's data, as `app/netlify/lib/fcm.ts` writes it.
        private const val KEY_KIND = "kind"
        private const val KEY_ID = "session_id"
        private const val KEY_TITLE = "title"
        private const val KEY_BODY = "body"
        private const val KEY_ICON = "icon"
        private const val KEY_BOT = "bot"
        private const val KEY_CATEGORY = "category"
        private const val KEY_CHANNEL = "channel"
        private const val KEY_TAG = "tag"
        private const val KEY_ACTIONS = "actions"
        private const val KEY_CHAT = "chat"
    }
}

/** A face laid in an adaptive icon: the square canvas's [side], and the [inset] on each edge. */
data class AdaptiveFace(val side: Int, val inset: Int)

/** One button a notice carries: what it says, and the link a press posts. */
data class NoticeAction(val label: String, val url: String)
