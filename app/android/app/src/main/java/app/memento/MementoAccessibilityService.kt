package app.memento

import android.accessibilityservice.AccessibilityService
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PersistableBundle
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo

/**
 * Where the words land: the field another app has focused.
 *
 * Setting a field's text is best-effort by nature — some editors report success and change nothing,
 * and a few report failure having already changed it — so the answer here is what the system said and
 * never a retry. A blind second attempt on a field that had silently accepted the first is exactly
 * how one sentence becomes two.
 */
class MementoAccessibilityService : AccessibilityService() {

    private val ui = Handler(Looper.getMainLooper())

    override fun onServiceConnected() {
        live = this
        BubbleService.keyboard(keyboardUp())
    }

    /**
     * The phone unbinding this service is the user switching it off. The Bubble types through it, so
     * losing it takes the mark away there and then rather than leaving a control that cannot type.
     */
    override fun onUnbind(intent: Intent?): Boolean {
        gone()
        return super.onUnbind(intent)
    }

    override fun onDestroy() {
        gone()
        super.onDestroy()
    }

    /** Both ways out of the service end the mark: a destroy without an unbind is still no typing. */
    private fun gone() {
        if (live === this) live = null
        BubbleService.standDown()
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        // The keyboard is what decides whether the mark is on screen: a person dictating is looking at
        // a field with a keyboard under it. It is read from the phone's own window list rather than
        // guessed from focus, because a field can hold focus with no keyboard up.
        when (event?.eventType) {
            AccessibilityEvent.TYPE_WINDOWS_CHANGED,
            AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED,
            -> read()
        }
    }

    /**
     * The window list is a binder round trip for every window on screen, and it is read for the Bubble
     * alone: with no mark running there is nothing to tell, and one app switch sends a burst of these,
     * so the read waits for the burst to end instead of following each event.
     */
    private fun read() {
        if (!BubbleService.watching()) return
        ui.removeCallbacks(keyboard)
        ui.postDelayed(keyboard, SETTLE_MS)
    }

    private val keyboard = Runnable { BubbleService.keyboard(keyboardUp()) }

    /** Whether the phone's keyboard is on screen. */
    fun keyboardUp(): Boolean = windows.any { it.type == AccessibilityWindowInfo.TYPE_INPUT_METHOD }

    override fun onInterrupt() = Unit

    data class Landed(val landed: Boolean, val why: String? = null)

    /**
     * The field a take's words go into, read when the take **ends**: a take is allowed to start with
     * no field at all, and its words are kept for the app when it ends with none.
     */
    private fun field(): AccessibilityNodeInfo? {
        val root = rootInActiveWindow ?: return null
        val focused = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
        if (focused != null && focused.isEditable) return focused
        // An untouched field reports focus on the container around it, so the field is looked for inside.
        return editable(root, 0)
    }

    fun land(words: String): Landed {
        if (words.isBlank()) return Landed(false, "Nothing was heard.")
        val node = field() ?: return Landed(false, "No text field is focused.")
        val text = node.text?.toString().orEmpty()
        val start = node.textSelectionStart.coerceIn(0, text.length)
        val end = node.textSelectionEnd.coerceIn(start, text.length)
        val merged = text.substring(0, start) + words + text.substring(end)
        val arguments = Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, merged)
        }
        if (node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, arguments)) return Landed(true)
        return paste(node, words)
    }

    private fun editable(node: AccessibilityNodeInfo, depth: Int): AccessibilityNodeInfo? {
        if (depth > DEPTH) return null
        for (index in 0 until node.childCount) {
            val child = node.getChild(index) ?: continue
            if (child.isEditable && child.isVisibleToUser) return child
            editable(child, depth + 1)?.let { return it }
        }
        return null
    }

    /**
     * The fallback that shipped products fall back to: the words go on the clipboard and the field is
     * asked to paste. The previous clipboard is put back afterwards where it could be read at all; a
     * transcript is the user's own words, so it is marked sensitive wherever the system supports it.
     */
    private fun paste(node: AccessibilityNodeInfo, words: String): Landed {
        val clips = getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
            ?: return Landed(false, "Couldn't put the words in that field.")
        val previous = runCatching { clips.primaryClip }.getOrNull()
        val clip = ClipData.newPlainText("Speech-to-text", words)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            clip.description.extras = PersistableBundle().apply {
                putBoolean("android.content.extra.IS_SENSITIVE", true)
            }
        }
        runCatching { clips.setPrimaryClip(clip) }.onFailure {
            return Landed(false, "Couldn't put the words in that field.")
        }
        val pasted = node.performAction(AccessibilityNodeInfo.ACTION_PASTE)
        Handler(Looper.getMainLooper()).postDelayed({
            // A phone that does not let this app read the clipboard answers null, so there is nothing
            // to put back — the transcript is cleared rather than left for the next paste to offer.
            runCatching {
                if (previous != null) {
                    clips.setPrimaryClip(previous)
                } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                    clips.clearPrimaryClip()
                }
            }
        }, RESTORE_MS)
        return if (pasted) Landed(true) else Landed(false, "Couldn't put the words in that field.")
    }

    companion object {
        private const val DEPTH = 6
        private const val RESTORE_MS = 600L
        /** How long a burst of window events is given to finish before the windows are read once. */
        private const val SETTLE_MS = 120L

        @Volatile
        var live: MementoAccessibilityService? = null
            private set

        /** Whether the phone has switched this service on: without it nothing can insert anything. */
        fun connected() = live != null
    }
}
