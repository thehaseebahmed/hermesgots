package dev.hermesgots

import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * The page's side of the charm's alerts: the address the phone writes to, and the two moments it can
 * ask for.
 *
 * The page pairs and syncs, so it holds the charm's device id in its own store; a push with the app
 * closed can read none of that. It is mirrored to [CharmNotifier] here, and every frame — a real
 * moment or the settings row's test — is written by that one notifier, so two links never race for
 * the charm. Nothing here fails the page: a write the phone can't make (no charm, Bluetooth off, the
 * grant gone) is nothing happening, which is what the charm's silence already means.
 */
@CapacitorPlugin(name = "Charm")
class CharmPlugin : Plugin() {

    /** The charm the reader paired, so a push can reach it with the page closed. */
    @PluginMethod
    fun save(call: PluginCall) {
        val deviceId = call.getString("deviceId").orEmpty().trim()
        if (deviceId.isEmpty()) {
            call.reject("A charm has an address.")
            return
        }
        CharmNotifier.save(context, deviceId)
        call.resolve()
    }

    /** The reader forgot the charm: the phone forgets where to write, and writes nowhere. */
    @PluginMethod
    fun forget(call: PluginCall) {
        CharmNotifier.forget(context)
        call.resolve()
    }

    /**
     * A bot needs the reader — a question or an approval — with the subject a clear names, the words
     * the tray shows, and the buttons it draws.
     */
    @PluginMethod
    fun alert(call: PluginCall) {
        val botId = call.getString("botId").orEmpty().trim()
        if (botId.isEmpty()) {
            call.reject("An alert names the bot it is about.")
            return
        }
        val reason = call.getString("reason").orEmpty().trim()
        if (CharmNotifier.reasonOf(reason) == null) {
            call.reject("A charm alert is a question or an approval.")
            return
        }
        // The words and the buttons the page's own notice carries, so a test alert reads and answers
        // on the charm as a real one does: the title over the body, at the minute the frame is built.
        CharmNotifier.alert(
            context,
            botId,
            reason,
            call.getString("subject").orEmpty(),
            call.getString("title").orEmpty(),
            call.getString("body").orEmpty(),
            buttonsOf(call),
        )
        call.resolve()
    }

    /**
     * The buttons the page sent, each an id and a label — the two fields a charm answers and draws
     * by. A row with either missing is dropped rather than written, since a button with no id
     * answers nothing and one with no label says nothing.
     */
    private fun buttonsOf(call: PluginCall): List<CharmWire.Action> {
        val rows = call.getArray("actions") ?: return emptyList()
        val buttons = ArrayList<CharmWire.Action>(rows.length())
        for (at in 0 until rows.length()) {
            val row = rows.optJSONObject(at) ?: continue
            val id = row.optString("id").trim()
            val label = row.optString("label").trim()
            if (id.isEmpty() || label.isEmpty()) continue
            buttons.add(CharmWire.Action(id, label))
        }
        return buttons
    }

    /** The bot is settled: the record the subject names goes, and nothing else on the charm moves. */
    @PluginMethod
    fun clear(call: PluginCall) {
        CharmNotifier.clear(context, call.getString("subject").orEmpty())
        call.resolve()
    }
}
