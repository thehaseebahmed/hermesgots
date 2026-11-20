package dev.hermesgots

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.core.content.ContextCompat
import java.util.Calendar
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

    /** The charm's service and its characteristics, as `src/lib/charm-protocol.ts` names them. */
    private val SERVICE = UUID.fromString("1fa26b10-0e3e-4c4c-b6ce-062415834e11")
    private val CONTROL = UUID.fromString("1fa26b11-0e3e-4c4c-b6ce-062415834e11")
    private val STATUS = UUID.fromString("1fa26b13-0e3e-4c4c-b6ce-062415834e11")

    /** The descriptor a characteristic's notifications are switched on through, as Bluetooth numbers it. */
    private val NOTIFY = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

    /** The MTU the charm asks for: an alert measures up to 335 bytes, more than a default link carries. */
    private const val MTU = 517

    /** What a link carries when the stack takes no MTU request: ATT's default, less its three header bytes. */
    private const val DEFAULT_MTU = 23

    /** What one write may cost the thread that asked, all told: it runs after the tray entry is posted. */
    private const val BUDGET_MS = 10_000L

    /**
     * How long the link stays open after an alert is written, with the charm's answers subscribed to:
     * the reader may tap "Show on phone" on the charm while the phone is in a pocket, and that answer
     * arrives only on a link that is still there.
     */
    private const val HOLD_MS = 20_000L

    /**
     * How long a link that carried only a clear waits for the answer to its handoff ask: a tap that is
     * already waiting is answered the moment it is asked for, and nothing else is coming.
     */
    private const val ASK_MS = 3_000L

    /**
     * One link at a time. A moment that arrives while a link is held rides that link, which is what
     * keeps a clear from being lost during an alert's twenty seconds; a link still connecting takes no
     * more, and a third moment is dropped rather than queued, since the charm holds one alert and the
     * latest wins.
     */
    private val busy = AtomicBoolean(false)

    /** The link a moment is going over while it is open, so a second one can ride it. */
    @Volatile
    private var open: Link? = null

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
     * The reason byte a name stands for, or null for anything that is not one of the moments the
     * charm draws. One rule, asked by both the plugin and a push.
     */
    fun reasonOf(name: String?): Int? = when (name) {
        "question" -> CharmWire.REASON_QUESTION
        "approval" -> CharmWire.REASON_APPROVAL
        else -> null
    }

    /**
     * A bot needs the reader: which bot, why, the words the tray entry shows — the notice's own title
     * and body, so the charm reads like the notification rather than like a retelling of it — and the
     * buttons that entry draws, so the reader can answer from the wrist. The subject is what a later
     * clear names and what a tap on the charm answers with, so it is the session the notice is about.
     */
    fun alert(
        context: Context,
        botId: String?,
        reason: String?,
        subject: String?,
        title: String?,
        body: String?,
        actions: List<CharmWire.Action>,
    ) {
        val why = reasonOf(reason) ?: return
        val minute = minuteOfDay()
        val words = title.orEmpty()
        val said = body.orEmpty()
        val session = subject.orEmpty()
        val bot = botId.orEmpty()
        val full = runCatching { CharmWire.alert(why, minute, words, said, actions, session, bot) }
            .getOrNull() ?: return
        // The same alert without its body. A link that negotiated less than the whole frame needs still
        // carries what the bot is waiting for and whose face it is — the title, the buttons, the
        // session and the bot — where dropping the alert would carry nothing at all.
        val brief = runCatching { CharmWire.alert(why, minute, words, "", actions, session, bot) }
            .getOrNull() ?: return
        send(context, full, brief, HOLD_MS)
    }

    /** The bot is settled: the record the subject names goes, and the charm goes back to its carousel. */
    fun clear(context: Context, subject: String?) {
        val frame = runCatching { CharmWire.clear(subject.orEmpty()) }.getOrNull() ?: return
        send(context, frame, frame, ASK_MS)
    }

    /**
     * Minutes since local midnight: an alert says when it was raised in the reader's own clock, so the
     * charm's minute agrees with the one on the phone.
     */
    private fun minuteOfDay(now: Long = System.currentTimeMillis()): Int {
        val at = Calendar.getInstance().apply { timeInMillis = now }
        return at.get(Calendar.HOUR_OF_DAY) * 60 + at.get(Calendar.MINUTE)
    }

    /**
     * One connection, with the grant and the bond it needs asked for before it. A moment that arrives
     * while a link is held is written on that link rather than opening a second one for the same charm.
     */
    @SuppressLint("MissingPermission")
    private fun send(context: Context, full: ByteArray, brief: ByteArray, holdMs: Long) {
        if (open?.again(full, brief) == true) return
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
            val link = Link(app, device, full, brief, holdMs)
            open = link
            link.start()
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
     * One connection and the frames it owes: connect, discover the service, ask for the MTU the charm
     * wants, subscribe to `status`, write the moment, then ask whether a tap is waiting — and stay open
     * for a while after that, because the reader's tap on the charm arrives only on a link still there.
     *
     * The ask goes over on every connection this phone makes, which is what picks up a tap made while
     * the phone was away: at the next contact, and not before it. Nothing is listening in between, so
     * the handoff is not instant by design.
     */
    private class Link(
        private val app: Context,
        private val device: BluetoothDevice,
        private val full: ByteArray,
        private val brief: ByteArray,
        private val holdMs: Long,
    ) : BluetoothGattCallback() {
        private val handler = Handler(Looper.getMainLooper())
        private val closeTask = Runnable { close() }
        private var gatt: BluetoothGatt? = null

        /** The frames still owed, in order: the moment, then the ask, then anything that rides in. */
        private val owed = ArrayDeque<ByteArray>()

        /** The negotiated ATT MTU, or 0 until the stack says which frame fits. */
        private var mtu = 0

        /** True while a write with a response is out, so the next one waits for its own callback. */
        private var writing = false

        /** The moment and the ask are both written: the link is only waiting for an answer now. */
        @Volatile
        private var held = false

        /** Callbacks arrive on binder threads and the budget on the main one, so this is shared. */
        @Volatile
        private var over = false

        @SuppressLint("MissingPermission")
        fun start() {
            handler.postDelayed(closeTask, BUDGET_MS)
            gatt = runCatching { device.connectGatt(app, false, this, BluetoothDevice.TRANSPORT_LE) }
                .getOrNull()
            if (gatt == null) close()
        }

        /**
         * A moment that arrived while this link was held: it is written on the connection that is
         * already there. False once the link is past writing, so the caller opens another one.
         */
        fun again(full: ByteArray, brief: ByteArray): Boolean {
            if (over || !held) return false
            handler.post {
                if (over || !held) return@post
                owed.addLast(if (fits(full)) full else brief)
                if (!writing) writeNext()
            }
            return true
        }

        @SuppressLint("MissingPermission")
        override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, state: Int) {
            // The callback's own handle, so a link is never closed through a field not set yet.
            // Every call here rides a connection the link above opened only after `granted()` said
            // the nearby-devices permission was held; one taken away mid-flight throws, and the
            // write's own runCatching drops it like every other refusal.
            this.gatt = gatt
            if (state == BluetoothProfile.STATE_CONNECTED) gatt.discoverServices() else close()
        }

        @SuppressLint("MissingPermission")
        override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
            // A stack that takes no MTU request writes on the default link: the frame is chosen for 23,
            // and a write it refuses closes the link below.
            if (status != BluetoothGatt.GATT_SUCCESS || !gatt.requestMtu(MTU)) ready(gatt, DEFAULT_MTU)
        }

        /** Whatever the phone answered about the MTU is what the frame is measured against. */
        @SuppressLint("MissingPermission")
        override fun onMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int) = ready(gatt, mtu)

        @SuppressLint("MissingPermission")
        private fun ready(gatt: BluetoothGatt, negotiated: Int) {
            mtu = negotiated
            owed.addLast(if (fits(full)) full else brief)
            owed.addLast(CharmWire.handoff())
            // Subscribed before anything is written, so the answer to the ask cannot be missed.
            val status = gatt.getService(SERVICE)?.getCharacteristic(STATUS)
            val notify = status?.getDescriptor(NOTIFY)
            if (status == null || notify == null || !gatt.setCharacteristicNotification(status, true)) {
                // A charm that cannot be heard still takes the moment; there is nothing to wait for.
                writeNext()
                return
            }
            // `value` rather than API 33's `writeDescriptor(descriptor, value)`, as `writeNext` keeps
            // the deprecated setter: one path from minSdk 24 to the target.
            notify.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
            if (!gatt.writeDescriptor(notify)) writeNext()
        }

        /** The descriptor's one write: the moment follows it, so no answer arrives before it is asked. */
        override fun onDescriptorWrite(
            gatt: BluetoothGatt,
            descriptor: BluetoothGattDescriptor,
            status: Int,
        ) = writeNext()

        /** The next frame owed, one at a time: a write with a response is the charm's before the next. */
        @SuppressLint("MissingPermission")
        private fun writeNext() {
            if (over) return
            val frame = owed.removeFirstOrNull() ?: return
            val link = gatt ?: return close()
            val control = link.getService(SERVICE)?.getCharacteristic(CONTROL) ?: return close()
            writing = true
            control.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
            control.value = frame
            if (!link.writeCharacteristic(control)) close()
        }

        override fun onCharacteristicWrite(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            status: Int,
        ) {
            writing = false
            if (owed.isNotEmpty()) return writeNext()
            // The ask is answered. Whatever is still to come is the reader's tap, and it comes while
            // this link is open or not at all.
            held = true
            handler.removeCallbacks(closeTask)
            handler.postDelayed(closeTask, holdMs)
        }

        override fun onCharacteristicChanged(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
        ) = heard(characteristic.value)

        override fun onCharacteristicChanged(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            value: ByteArray,
        ) = heard(value)

        /**
         * A notification on `status`: the handoff's answer, or the four-byte status a sync reads, which
         * this link has no use for. `handoffAnswer` reads a status as no answer at all, so the two can
         * never be taken for each other.
         */
        private fun heard(value: ByteArray?) {
            val subject = CharmWire.handoffAnswer(value) ?: return
            show(subject)
            close()
        }

        /**
         * The one chat, by the link a tap on the tray opens: the page looks the session up and opens its
         * screen (`linkedPush` and `openPush` in `src/lib/push.ts`), so a charm's answer lands where a
         * tap on the notice would.
         *
         * Android 10 and later refuse an activity start from the background unless the app holds an
         * overlay grant, which is the one the Bubble asks for; a phone without that grant refuses the
         * start, and the notice's own tap still opens the same chat.
         */
        private fun show(subject: String) {
            runCatching { app.startActivity(NoticeOpen.link(null, subject)) }
        }

        /** Whether one write carries the frame: the ATT MTU less the header every write wears. */
        private fun fits(frame: ByteArray) = frame.size <= maxOf(mtu, DEFAULT_MTU) - 3

        @SuppressLint("MissingPermission")
        fun close() {
            if (over) return
            over = true
            handler.removeCallbacksAndMessages(null)
            if (open === this) open = null
            gatt?.let { link ->
                runCatching { link.disconnect() }
                runCatching { link.close() }
            }
            gatt = null
            busy.set(false)
        }
    }
}
