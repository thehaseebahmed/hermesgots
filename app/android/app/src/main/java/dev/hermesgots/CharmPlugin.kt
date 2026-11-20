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

    /** A bot needs the reader — a question or an approval — with the subject a clear names. */
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
        CharmNotifier.alert(context, botId, reason, call.getString("subject").orEmpty())
        call.resolve()
    }

    /** The bot is settled: the record the subject names goes, and nothing else on the charm moves. */
    @PluginMethod
    fun clear(call: PluginCall) {
        CharmNotifier.clear(context, call.getString("subject").orEmpty())
        call.resolve()
    }
}
