package dev.hermesgots

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import androidx.core.content.ContextCompat
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback

/**
 * The page's side of the Bubble: the one bot to dictate with, whether the phone has granted the two
 * things it needs, and the two system screens that grant them.
 *
 * The grants are the phone's, not the app's — a switch inside Gots that claimed to turn the Bubble on
 * would be lying on a phone where the draw-over permission is off — so the page can only report them
 * and send the user to where they are given.
 */
@CapacitorPlugin(
    name = "Bubble",
    permissions = [Permission(alias = "microphone", strings = [Manifest.permission.RECORD_AUDIO])],
)
class BubblePlugin : Plugin() {

    @PluginMethod
    fun configure(call: PluginCall) {
        val root = call.getString("root").orEmpty().trim().trimEnd('/')
        if (root.isBlank()) {
            call.reject("A bot needs a host to reach.")
            return
        }
        val words = call.getArray("vocabulary")
            ?.toList<Any?>()
            ?.mapNotNull { (it as? String)?.takeIf(String::isNotBlank) }
            .orEmpty()
        BubbleConfig.save(
            context,
            BubbleConfig.Bot(
                profileId = call.getString("profileId").orEmpty(),
                root = root,
                apiKey = call.getString("apiKey").orEmpty(),
                name = call.getString("name").orEmpty(),
                vocabulary = words,
                waitMs = call.getInt("waitMs") ?: BubbleConfig.UNASKED,
                cloud = call.getBoolean("cloud") ?: false,
            ),
        )
        if (BubbleConfig.enabled(context)) BubbleService.refresh(context)
        call.resolve()
    }

    /**
     * The microphone is a runtime permission, so it is asked for before anything starts: a service of
     * the microphone type cannot even be started without it, and a phone that has never dictated in
     * Gots has never been asked.
     */
    @PluginMethod
    fun requestMicrophone(call: PluginCall) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) {
            call.resolve(JSObject().put("granted", true))
            return
        }
        requestPermissionForAlias("microphone", call, "microphoneAnswered")
    }

    @PermissionCallback
    private fun microphoneAnswered(call: PluginCall) {
        call.resolve(JSObject().put("granted", getPermissionState("microphone") == PermissionState.GRANTED))
    }

    @PluginMethod
    fun enable(call: PluginCall) {
        if (!Settings.canDrawOverlays(context)) {
            call.resolve(JSObject().put("started", false).put("reason", "overlay"))
            return
        }
        // Half the grants is no Bubble: without the service the mark would draw and type nothing.
        if (!GotsAccessibilityService.connected()) {
            call.resolve(JSObject().put("started", false).put("reason", "accessibility"))
            return
        }
        // A foreground service of the microphone type cannot even start without the grant, and a
        // switch that read On over a stopped service would be the lie this row exists to avoid.
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            call.resolve(JSObject().put("started", false).put("reason", "microphone"))
            return
        }
        BubbleConfig.setEnabled(context, true)
        BubbleService.start(context)
        call.resolve(JSObject().put("started", true))
    }

    @PluginMethod
    fun disable(call: PluginCall) {
        BubbleConfig.setEnabled(context, false)
        BubbleService.stop(context)
        call.resolve()
    }

    @PluginMethod
    fun state(call: PluginCall) {
        val answer = JSObject()
            .put("enabled", BubbleConfig.enabled(context))
            .put("overlay", Settings.canDrawOverlays(context))
            .put("accessibility", GotsAccessibilityService.connected())
        call.resolve(answer)
    }

    /**
     * The takes whose words found no field, handed over to be written as **Dictations**. They are
     * only read here: the page quotes back the ones it wrote, and the rest stay for the next open.
     */
    @PluginMethod
    fun takeaways(call: PluginCall) {
        val kept = JSArray()
        BubbleConfig.peekKept(context).forEach { take ->
            val one = JSObject()
                .put("id", take.id)
                .put("at", take.at)
                .put("profileId", take.profileId)
                .put("text", take.text)
                .put("heard", take.heard)
                .put("ms", take.ms)
            take.level?.let { one.put("level", it) }
            take.cleaned?.let { one.put("cleaned", it) }
            take.provider?.let { one.put("provider", it) }
            take.model?.let { one.put("model", it) }
            kept.put(one)
        }
        call.resolve(JSObject().put("kept", kept))
    }

    /** The rows the page wrote: dropped here, so a take is neither lost nor written twice. */
    @PluginMethod
    fun took(call: PluginCall) {
        val ids = call.getArray("ids")
            ?.toList<Any?>()
            ?.mapNotNull { it as? String }
            .orEmpty()
        BubbleConfig.forgetKept(context, ids)
        call.resolve()
    }

    @PluginMethod
    fun openOverlay(call: PluginCall) {
        screen(
            Intent(
                Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                Uri.parse("package:${context.packageName}"),
            ),
            call,
        )
    }

    @PluginMethod
    fun openAccessibility(call: PluginCall) {
        screen(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS), call)
    }

    /** Both grants live on a screen of the phone's, and neither can be asked for in place. */
    private fun screen(intent: Intent, call: PluginCall) {
        val opened = runCatching { context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
        opened.onFailure {
            call.reject("This phone has no screen for that.")
            return
        }
        call.resolve()
    }
}
