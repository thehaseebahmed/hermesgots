package dev.hermesgots

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.core.content.ContextCompat
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The charm's alert, written by the phone: the one place an alert frame goes over the air, whether
 * the page asked for it or a push did with the app closed.
 *
 * The page pairs and syncs, so it is the side that knows which charm is the reader's; a push with
 * the app closed runs in this process and can read no WebView storage at all. The address is
 * therefore mirrored here, the way `BubbleConfig` mirrors the Bubble's bot, and every write reads it
 * from here.
 *
 * Nothing in this file may throw into its caller: a moment for the charm is a bonus beside the
 * notice the tray already holds, so no charm saved, Bluetooth off, the connect grant gone or a bond
 * Android dropped all mean the same thing — nothing happens, and nothing is said.
 */
object CharmNotifier {
    private const val FILE = "gots-charm"
    private const val DEVICE = "deviceId"

    /** What a saved address may measure. An Android charm's id is a MAC; a longer one is not one. */
    private const val MAX_DEVICE_CHARS = 64

    /** The charm's service and its `control` characteristic, as `src/lib/charm-protocol.ts` names them. */
    private val SERVICE = UUID.fromString("1fa26b10-0e3e-4c4c-b6ce-062415834e11")
    private val CONTROL = UUID.fromString("1fa26b11-0e3e-4c4c-b6ce-062415834e11")

    /** The MTU the charm asks for; a control frame may measure 133 bytes, more than a default link carries. */
    private const val MTU = 517

    /** What one write may cost the thread that asked, all told: it runs after the tray entry is posted. */
    private const val BUDGET_MS = 10_000L

    /**
     * One write at a time, and a second call while one runs is dropped rather than queued: the charm
     * holds one alert and the latest wins, so a queue would only spend the newer moment's ten seconds
     * behind the older one — and there is no thread here that owns a queue to keep it in.
     */
    private val busy = AtomicBoolean(false)

    private fun prefs(context: Context) = context.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    /** Keeps the charm the page paired, so a write can be made with the page gone. */
    fun save(context: Context, deviceId: String) {
        val clean = deviceId.trim().take(MAX_DEVICE_CHARS)
        if (clean.isEmpty()) return forget(context)
        prefs(context).edit().putString(DEVICE, clean).apply()
    }

    /** The charm is forgotten on the page: no address is left for a write to aim at. */
    fun forget(context: Context) {
        prefs(context).edit().remove(DEVICE).apply()
    }

    /** The paired charm's address, or null when the page has never paired one. */
    fun deviceId(context: Context): String? =
        prefs(context).getString(DEVICE, null)?.trim()?.takeIf { it.isNotEmpty() }

    /**
     * The reason byte a name stands for, or null for anything that is not one of the three moments
     * the charm draws. One rule, asked by both the plugin and a push.
     */
    fun reasonOf(name: String?): Int? = when (name) {
        "question" -> CharmWire.REASON_QUESTION
        "approval" -> CharmWire.REASON_APPROVAL
        "finished" -> CharmWire.REASON_FINISHED
        else -> null
    }

    /**
     * A bot needs the reader: which bot, and why. The subject is what a later clear names, so it is
     * the session the notice is about — the same id a clear's push carries.
     */
    fun alert(context: Context, botId: String?, reason: String?, subject: String?) {
        val why = reasonOf(reason) ?: return
        val frame = runCatching { CharmWire.alert(why, subject.orEmpty(), botId.orEmpty()) }
            .getOrNull() ?: return
        send(context, frame)
    }

    /** The bot is settled: the record the subject names goes, and the charm goes back to its carousel. */
    fun clear(context: Context, subject: String?) {
        val frame = runCatching { CharmWire.clear(subject.orEmpty()) }.getOrNull() ?: return
        send(context, frame)
    }

    /** One connection, one frame, and the grant and the bond it needs asked for before either. */
    @SuppressLint("MissingPermission")
    private fun send(context: Context, frame: ByteArray) {
        if (!busy.compareAndSet(false, true)) return
        try {
            val app = context.applicationContext
            val adapter =
                (app.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter
            val device = adapter?.let { bonded(app, it) }
            if (device == null) {
                busy.set(false)
                return
            }
            Link(app, device, frame).start()
        } catch (refused: Exception) {
            // A grant withdrawn between the check and the call, or a radio that refuses: nothing is
            // written, nothing is said, and the next moment may still get through.
            busy.set(false)
        }
    }

    /**
     * The bonded charm at the saved address. Null when the page saved none, when Bluetooth is off,
     * when Android 12's nearby-devices grant is gone, or when the bond is (a charm forgotten in the
     * phone's own Bluetooth settings is no charm this app can write to).
     */
    @SuppressLint("MissingPermission")
    private fun bonded(context: Context, adapter: BluetoothAdapter): BluetoothDevice? {
        val saved = deviceId(context) ?: return null
        if (!granted(context) || !adapter.isEnabled) return null
        return adapter.bondedDevices.orEmpty()
            .firstOrNull { it.address.equals(saved, ignoreCase = true) }
    }

    /** The connect grant, which Android 12 and later ask for; before that the bond was the whole grant. */
    private fun granted(context: Context): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.S ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.BLUETOOTH_CONNECT) ==
            PackageManager.PERMISSION_GRANTED

    /**
     * One connection and one write: connect, discover the service, ask for the MTU the charm wants,
     * write `control` with a response, and close on the write's own callback — or at [BUDGET_MS],
     * whichever comes first.
     *
     * Nothing subscribes to `status` here. The charm answers every control write with a notification,
     * but this step has nothing that consumes that answer: the tray entry is the record, and a
     * descriptor write and a listener would be code with no decision behind it.
     */
    private class Link(
        private val app: Context,
        private val device: BluetoothDevice,
        private val frame: ByteArray,
    ) : BluetoothGattCallback() {
        private val handler = Handler(Looper.getMainLooper())
        private var gatt: BluetoothGatt? = null

        /** Callbacks arrive on binder threads and the budget on the main one, so this is shared. */
        @Volatile
        private var over = false

        @SuppressLint("MissingPermission")
        fun start() {
            handler.postDelayed({ close() }, BUDGET_MS)
            gatt = runCatching { device.connectGatt(app, false, this, BluetoothDevice.TRANSPORT_LE) }
                .getOrNull()
            if (gatt == null) close()
        }

        override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, state: Int) {
            // The callback's own handle, so a link is never closed through a field not set yet.
            this.gatt = gatt
            if (state == BluetoothProfile.STATE_CONNECTED) gatt.discoverServices() else close()
        }

        override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
            // A stack that takes no MTU request writes as it is: the charm's own frames are small, and
            // a write it refuses closes the link below.
            if (status != BluetoothGatt.GATT_SUCCESS || !gatt.requestMtu(MTU)) write(gatt)
        }

        /** Whatever the phone answered about the MTU, the write is next, on whatever the link carries. */
        override fun onMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int) = write(gatt)

        /** The write is the end of it: with a response, the frame is the charm's before this comes back. */
        override fun onCharacteristicWrite(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            status: Int,
        ) = close()

        @SuppressLint("MissingPermission")
        private fun write(gatt: BluetoothGatt) {
            val control = gatt.getService(SERVICE)?.getCharacteristic(CONTROL)
            if (control == null) return close()
            // `value` rather than API 33's `writeCharacteristic(characteristic, value, type)`: one path
            // from minSdk 24 to the target, and the deprecated setter is what writes on all of them.
            control.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
            control.value = frame
            if (!gatt.writeCharacteristic(control)) close()
        }

        @SuppressLint("MissingPermission")
        fun close() {
            if (over) return
            over = true
            handler.removeCallbacksAndMessages(null)
            gatt?.let { link ->
                runCatching { link.disconnect() }
                runCatching { link.close() }
            }
            gatt = null
            busy.set(false)
        }
    }
}
