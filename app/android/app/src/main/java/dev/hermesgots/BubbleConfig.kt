package dev.hermesgots

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * The one bot the Bubble dictates to, mirrored out of the page's own store, plus the takes whose words
 * never found a field — kept here so the page can put them in the log the next time it is opened.
 *
 * Bots live in the WebView's IndexedDB, which nothing native can read, so the page writes this block
 * whenever the selection or that bot's connection moves. `root` is already the plugin's own root —
 * profile path included — so the service never has to know how a multiplexed host spells a bot.
 */
object BubbleConfig {
    private const val FILE = "gots-bubble"
    private const val ROOT = "root"
    private const val KEY = "apiKey"
    private const val NAME = "name"
    private const val PROFILE = "profileId"
    private const val WORDS = "vocabulary"
    private const val WAIT = "waitMs"
    private const val CLOUD = "cloud"
    private const val ENABLED = "enabled"
    private const val KEPT = "kept"
    private const val DOCK_RIGHT = "dockRight"
    private const val DOCK_SHARE = "dockShare"

    /** How long the host said its Confirm can take. A bot never asked answers nothing, so it keeps the floor. */
    const val DEFAULT_WAIT_MS = 45_000

    /** What `waitMs` holds until a host has been asked: the app mirrors `-1`, never a made-up number. */
    const val UNASKED = -1

    /** How many takes are handed over: this is a handover, not a second log. */
    private const val KEEP = 20

    private const val ID = "id"
    private const val AT = "at"
    private const val TEXT = "text"
    private const val HEARD = "heard"
    private const val MS = "ms"
    private const val LEVEL = "level"
    private const val CLEANED = "cleaned"
    private const val PROVIDER = "provider"
    private const val MODEL = "model"

    data class Bot(
        val profileId: String,
        val root: String,
        val apiKey: String,
        val name: String,
        val vocabulary: List<String>,
        /** The host's own bound on a Confirm, or [UNASKED] where the app has never had one. */
        val waitMs: Int,
        /** Whether a take leaves the host: a local model is warmed first, a cloud one is not. */
        val cloud: Boolean,
    )

    /** A take's words that landed nowhere, in the shape the log writes one. */
    data class Kept(
        val at: Long,
        val profileId: String,
        val text: String,
        val heard: String,
        val ms: Int,
        val level: String?,
        val cleaned: Boolean?,
        val provider: String?,
        val model: String?,
        /** What the app quotes back once the row is written: a handover that is not lost on a retry. */
        val id: String,
    )

    private fun prefs(context: Context) = context.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    fun bot(context: Context): Bot? {
        val prefs = prefs(context)
        val root = prefs.getString(ROOT, null)?.takeIf { it.isNotBlank() } ?: return null
        val words = prefs.getString(WORDS, null)
            ?.let { runCatching { JSONArray(it) }.getOrNull() }
            ?.let { array -> (0 until array.length()).mapNotNull { array.optString(it).takeIf(String::isNotBlank) } }
            .orEmpty()
        return Bot(
            profileId = prefs.getString(PROFILE, "").orEmpty(),
            root = root,
            apiKey = prefs.getString(KEY, "").orEmpty(),
            name = prefs.getString(NAME, "").orEmpty(),
            vocabulary = words,
            waitMs = prefs.getInt(WAIT, UNASKED),
            cloud = prefs.getBoolean(CLOUD, false),
        )
    }

    fun save(context: Context, bot: Bot) {
        val words = JSONArray().apply { bot.vocabulary.take(50).forEach { put(it.take(40)) } }
        prefs(context).edit()
            .putString(PROFILE, bot.profileId)
            .putString(ROOT, bot.root)
            .putString(KEY, bot.apiKey)
            .putString(NAME, bot.name.take(300))
            .putString(WORDS, words.toString())
            .putInt(WAIT, bot.waitMs)
            .putBoolean(CLOUD, bot.cloud)
            .apply()
    }

    /** The page found no bot left to hear a take: the block goes, so the notice stops naming one. */
    fun clear(context: Context) {
        prefs(context).edit()
            .remove(PROFILE)
            .remove(ROOT)
            .remove(KEY)
            .remove(NAME)
            .remove(WORDS)
            .remove(WAIT)
            .remove(CLOUD)
            .apply()
    }

    /** Keeps a take whose words found no field, so the page can log it rather than losing it. */
    fun keep(context: Context, take: Kept) {
        val held = kept(context) + take
        prefs(context).edit().putString(KEPT, array(held.takeLast(KEEP)).toString()).apply()
    }

    /** Every take still held, oldest first: nothing is dropped until the page says it has the row. */
    fun peekKept(context: Context): List<Kept> = kept(context)

    /** Drops only what the page has written, so a handover that failed is handed over again. */
    fun forgetKept(context: Context, ids: Collection<String>) {
        if (ids.isEmpty()) return
        val left = kept(context).filterNot { it.id in ids }
        prefs(context).edit().putString(KEPT, array(left).toString()).apply()
    }

    private fun array(takes: List<Kept>) = JSONArray().apply {
        takes.forEach { one ->
            put(
                JSONObject()
                    .put(ID, one.id)
                    .put(AT, one.at)
                    .put(PROFILE, one.profileId)
                    .put(TEXT, one.text)
                    .put(HEARD, one.heard)
                    .put(MS, one.ms)
                    .put(LEVEL, one.level ?: JSONObject.NULL)
                    .put(CLEANED, one.cleaned ?: JSONObject.NULL)
                    .put(PROVIDER, one.provider ?: JSONObject.NULL)
                    .put(MODEL, one.model ?: JSONObject.NULL),
            )
        }
    }

    private fun kept(context: Context): List<Kept> {
        val raw = prefs(context).getString(KEPT, null)?.takeIf { it.isNotBlank() } ?: return emptyList()
        val array = runCatching { JSONArray(raw) }.getOrNull() ?: return emptyList()
        return (0 until array.length()).mapNotNull { index ->
            val one = array.optJSONObject(index) ?: return@mapNotNull null
            val text = one.optString(TEXT).takeIf { it.isNotBlank() } ?: return@mapNotNull null
            val at = one.optLong(AT)
            Kept(
                at = at,
                profileId = one.optString(PROFILE),
                text = text,
                heard = one.optString(HEARD),
                ms = one.optInt(MS),
                level = one.optString(LEVEL).takeIf { it.isNotBlank() },
                cleaned = if (one.isNull(CLEANED)) null else one.optBoolean(CLEANED),
                provider = one.optString(PROVIDER).takeIf { it.isNotBlank() },
                model = one.optString(MODEL).takeIf { it.isNotBlank() },
                id = one.optString(ID).takeIf { it.isNotBlank() } ?: stableId(at, text),
            )
        }
    }

    /** A row written before ids existed: the same pair answers the same id between peek and forget. */
    private fun stableId(at: Long, text: String) = "$at-${text.hashCode()}"

    data class Dock(val right: Boolean = true, val share: Float = 0.5f)

    fun dock(context: Context): Dock {
        val prefs = prefs(context)
        val home = Dock()
        return Dock(
            prefs.getBoolean(DOCK_RIGHT, home.right),
            prefs.getFloat(DOCK_SHARE, home.share).coerceIn(0f, 1f),
        )
    }

    fun saveDock(context: Context, dock: Dock) {
        prefs(context).edit().putBoolean(DOCK_RIGHT, dock.right).putFloat(DOCK_SHARE, dock.share).apply()
    }

    fun enabled(context: Context) = prefs(context).getBoolean(ENABLED, false)

    fun setEnabled(context: Context, on: Boolean) {
        prefs(context).edit().putBoolean(ENABLED, on).apply()
    }
}
