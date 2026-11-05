package app.memento

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.graphics.PixelFormat
import android.graphics.Rect
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.provider.Settings
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.WindowManager
import android.widget.Toast
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.Semaphore
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.abs

/**
 * The Bubble itself: a mark that stays on the screen while another app is in front, a take's
 * microphone, and the one place on the phone where a take can start without Gots being open. The
 * notification is the price of a microphone Android hands over on a tap (ADR 0104).
 */
class BubbleService : Service() {

    private lateinit var windows: WindowManager
    private val ui = Handler(Looper.getMainLooper())
    private val uploads = Executors.newSingleThreadExecutor()
    private val pieces = AtomicInteger(0)

    /** How many Pieces may be on their way at once: a stalled host must not become a held minute. */
    private val inFlight = Semaphore(PIECES_IN_FLIGHT)

    private var bubble: BubbleView? = null
    private var params: WindowManager.LayoutParams? = null
    private var binView: Bin? = null
    private var recorder: BubbleRecorder? = null
    private var net: BubbleNet? = null

    /**
     * What a take is doing, written from the upload thread as well as this one: the fields below are
     * the service's whole state, and a stale read decides whether the mark is on screen.
     */
    @Volatile private var take: String? = null
    @Volatile private var phase = BubbleView.Face.Idle

    @Volatile private var failure: String? = null

    private var downX = 0f
    private var downY = 0f
    private var fromX = 0
    private var fromY = 0
    private var dragging = false

    /** Whether the phone's keyboard is on screen, as the accessibility service last reported it. */
    private var keyboardUp = false

    /**
     * When the mark may go with the keyboard down: the grace after a take ends, or the longer stay
     * after something went wrong. One deadline, because both answer the same question.
     */
    @Volatile private var holdUntil = 0L

    private val revise = Runnable { apply() }

    /** A take that runs into its cap is stopped rather than left to grow a queue. */
    private val halt = Runnable {
        if (phase == BubbleView.Face.Recording) {
            toast("A take stops at ten minutes.")
            stopTake()
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        running = this
        windows = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        channel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            // Turned off from the notification or the app: the switch has to follow the service.
            BubbleConfig.setEnabled(this, false)
            stopSelf()
            return START_NOT_STICKY
        }
        if (!open()) {
            // The phone refused the window or the microphone: the row must not keep reading On.
            BubbleConfig.setEnabled(this, false)
            stopSelf()
            return START_NOT_STICKY
        }
        if (intent?.action == ACTION_REFRESH) {
            announce()
            return START_STICKY
        }
        announce()
        ui.removeCallbacks(watch)
        ui.postDelayed(watch, WATCH_MS)
        // The mark appears for the keyboard, so the phone's own answer is read before it is drawn.
        ui.post {
            keyboardUp = MementoAccessibilityService.live?.keyboardUp() == true
            apply()
        }
        return START_STICKY
    }

    override fun onDestroy() {
        ui.removeCallbacksAndMessages(null)
        if (running === this) running = null
        hideBin()
        removeMark()
        abandon("teardown", queued = true)
        uploads.shutdown()
        super.onDestroy()
    }

    /**
     * The Bubble cannot draw without the draw-over grant or type without the accessibility service, so
     * either one being taken away is the Bubble being taken away. It is watched rather than waited for:
     * neither grant sends anything the app can hear, and a mark that stays on screen after the phone
     * stopped it working is a control that can only fail.
     */
    private val watch = object : Runnable {
        override fun run() {
            if (!grants()) {
                quit()
                return
            }
            ui.postDelayed(this, WATCH_MS)
        }
    }

    private fun grants() = Settings.canDrawOverlays(this) && MementoAccessibilityService.connected()

    /**
     * The mark is only there while the keyboard is up, which is the state a person dictates in: a take
     * and the five seconds after it are the exception, because the keyboard can be dismissed
     * mid-take and a mark that vanished then would take the way to stop the take with it. The grace is
     * counted from the take's end, not from the keyboard's.
     */
    private fun apply() {
        ui.removeCallbacks(revise)
        val now = System.currentTimeMillis()
        val holding = phase != BubbleView.Face.Idle || now < holdUntil
        bubble?.visibility = if (keyboardUp || holding) View.VISIBLE else View.GONE
        if (keyboardUp || phase != BubbleView.Face.Idle) return
        if (holdUntil > now) ui.postDelayed(revise, holdUntil - now + 50)
    }

    private fun onKeyboard(up: Boolean) {
        ui.post {
            if (keyboardUp == up) return@post
            keyboardUp = up
            apply()
        }
    }

    /** Drops the mark and leaves the switch off, with nothing left saying it is running. */
    private fun quit() {
        ui.post {
            ui.removeCallbacks(watch)
            BubbleConfig.setEnabled(this, false)
            removeMark()
            stopSelf()
        }
    }

    /**
     * The window and the foreground service: the draw-over grant is checked here, and the microphone
     * is the plugin's to check before it starts anything (`BubblePlugin.enable`), because a service
     * cannot ask for it.
     */
    private fun open(): Boolean {
        if (!Settings.canDrawOverlays(this)) return false
        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTICE, notice(), ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
            } else {
                startForeground(NOTICE, notice())
            }
            if (bubble == null) add()
            true
        } catch (error: Exception) {
            // Said, not swallowed: the switch flips back to Off on this path, and this is the only
            // place that knows why.
            toast("The Bubble couldn't start: ${error.message ?: "unknown"}.")
            false
        }
    }

    private fun add() {
        val layout = WindowManager.LayoutParams(
            px(56),
            px(56),
            overlayType(),
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = metrics().widthPixels - px(72)
            y = metrics().heightPixels / 2
        }
        val view = BubbleView(this).apply {
            onCancel = { cancel() }
            onDone = { stopTake() }
            setOnTouchListener(drag(layout))
        }
        runCatching { windows.addView(view, layout) }.onFailure { return }
        bubble = view
        params = layout
    }

    /** The overlay type this phone understands: the API 26 one where it exists, the old one below. */
    private fun overlayType() = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
    } else {
        @Suppress("DEPRECATION")
        WindowManager.LayoutParams.TYPE_PHONE
    }

    /**
     * A drag moves the mark and a tap starts or ends a take: one gesture has to do both, so the tap
     * only counts when the finger stayed inside the touch slop the whole time. A drag that ends on the
     * bin turns the Bubble off.
     */
    private fun drag(layout: WindowManager.LayoutParams) = View.OnTouchListener { _, event ->
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                downX = event.rawX
                downY = event.rawY
                fromX = layout.x
                fromY = layout.y
                dragging = false
                true
            }

            MotionEvent.ACTION_MOVE -> {
                val dx = event.rawX - downX
                val dy = event.rawY - downY
                val slop = ViewConfiguration.get(this).scaledTouchSlop
                if (!dragging && (abs(dx) > slop || abs(dy) > slop)) {
                    dragging = true
                    showBin()
                }
                if (dragging) {
                    layout.x = (fromX + dx).toInt()
                    layout.y = (fromY + dy).toInt()
                    push(layout)
                    // The bin says it will take the mark: the two circles overlapping is the drop.
                    binView?.over(over(layout))
                }
                true
            }

            MotionEvent.ACTION_UP -> {
                val onBin = dragging && over(layout)
                hideBin()
                if (onBin) {
                    dragging = false
                    turnOff()
                } else if (dragging) {
                    dragging = false
                    snap(layout)
                } else {
                    dragging = false
                    tap()
                }
                true
            }

            MotionEvent.ACTION_CANCEL -> {
                dragging = false
                hideBin()
                true
            }

            else -> false
        }
    }

    /** Where a dragged mark is dropped to switch the Bubble off: bottom centre, clear of the keys. */
    private fun binRect(): Rect {
        val screen = metrics()
        val size = px(56)
        val left = (screen.widthPixels - size) / 2
        val top = screen.heightPixels - px(48) - size
        return Rect(left, top, left + size, top + size)
    }

    /** The mark itself over the bin, which is what the red and the drop both mean. */
    private fun over(layout: WindowManager.LayoutParams) =
        Rect.intersects(binRect(), Rect(layout.x, layout.y, layout.x + layout.width, layout.y + layout.height))

    private fun showBin() {
        if (binView != null) return
        val rect = binRect()
        val layout = WindowManager.LayoutParams(
            rect.width(),
            rect.height(),
            overlayType(),
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = rect.left
            y = rect.top
        }
        val view = Bin(this)
        runCatching { windows.addView(view, layout) }.onFailure { return }
        binView = view
    }

    private fun hideBin() {
        binView?.let { runCatching { windows.removeView(it) } }
        binView = null
    }

    /** Dropped on the bin: the Bubble goes off, and only the switch in the app brings it back. */
    private fun turnOff() {
        abandon("off")
        forget()
        BubbleConfig.setEnabled(this, false)
        toast("Bubble turned off. Turn it back on in Gots.")
        stopSelf()
    }

    private fun snap(layout: WindowManager.LayoutParams) {
        val screen = metrics()
        layout.x = if (layout.x + px(28) < screen.widthPixels / 2) px(8) else screen.widthPixels - px(64)
        layout.y = layout.y.coerceIn(px(24), screen.heightPixels - px(96))
        push(layout)
    }

    private fun tap() {
        // The grant can go while the mark is on screen; a tap is the last moment to notice.
        if (!grants()) return quit()
        when (phase) {
            BubbleView.Face.Recording -> stopTake()
            // The wait is out of our hands and not out of the user's: the same tap gives the take back.
            BubbleView.Face.Waiting -> cancel()
            BubbleView.Face.Idle -> start()
        }
    }

    /**
     * A take does not need a field to start, only somewhere to land: the phone's focused field is read
     * at the end, and a take whose words find none is kept for the app rather than refused up front.
     */
    private fun start() {
        val chosen = BubbleConfig.bot(this) ?: return fail(NO_BOT)
        if (!MementoAccessibilityService.connected()) return fail(NO_TYPING)
        // Revoked between the switch and the tap: a foreground service of this type does not need it
        // to be running, and the recorder's own construction would throw.
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            return fail("Allow the microphone first.")
        }
        val client = BubbleNet(chosen)
        val current = UUID.randomUUID().toString()
        // A local model, loaded before the first Piece: on its own thread, because a slow loader must
        // not hold the Piece that is already on its way.
        if (!chosen.cloud) Thread({ client.warm() }, "memento-bubble-warm").start()
        net = client
        take = current
        failure = null
        holdUntil = 0
        pieces.set(0)
        val recorder = BubbleRecorder(
            onPiece = { wav, ms -> cut(client, current, wav, ms) },
            onLevel = { loudness -> ui.post { bubble?.level(loudness) } },
            onError = { message ->
                // The recorder has stopped reading, so it has to be released like any other take's:
                // `abandon` clears both fields and stops it on a thread that can join its own.
                forget()
                abandon("error")
                fail(message)
            },
        )
        if (!recorder.start()) {
            // The recorder has said why; what it cannot do is unset the take it never heard, and a
            // take with no microphone behind it is one nothing can end.
            forget()
            return
        }
        this.recorder = recorder
        phase = BubbleView.Face.Recording
        render()
        apply()
        keepAwake(true)
        ui.postDelayed(halt, MAX_TAKE_MS)
    }

    /**
     * A Piece is uploaded while the user is still talking, and at most [PIECES_IN_FLIGHT] of them are
     * ever in hand: a host that takes half a minute per Piece would otherwise let a queue grow into
     * megabytes of audio nobody is waiting for.
     */
    private fun cut(client: BubbleNet, take: String, wav: ByteArray, ms: Int) {
        if (!inFlight.tryAcquire()) {
            if (failure == null) failure = SLOW
            ui.post { if (phase == BubbleView.Face.Recording) stopTake() }
            return
        }
        enqueue {
            try {
                // Counted where it is accepted: a Piece the executor refused was never a Piece.
                val index = pieces.getAndIncrement()
                val problem = client.upload(take, index, ms, wav)
                if (problem != null && failure == null) failure = problem
            } finally {
                inFlight.release()
            }
        }
    }

    /**
     * The reader joins its own thread and flushes the Piece it was in the middle of, so it is stopped
     * off the main thread: a Stop that blocks the main thread freezes the mark at best. The Confirm is
     * queued behind that flush, because the queue is single-threaded and the tail is a Piece too.
     */
    private fun stopTake() {
        val recorder = recorder ?: return
        val current = take ?: return
        this.recorder = null
        phase = BubbleView.Face.Waiting
        render()
        Thread(
            {
                runCatching { recorder.stop() }
                enqueue { finish(current) }
            },
            "memento-bubble-stop",
        ).start()
    }

    private fun finish(current: String) {
        ui.removeCallbacks(halt)
        val client = net
        val problem = when {
            client == null -> NO_BOT
            failure != null -> "Couldn't hear that: $failure"
            pieces.get() <= 0 -> "Nothing was heard."
            else -> null
        }
        if (client == null || problem != null) {
            give(current, problem ?: NO_BOT)
            return
        }
        client.confirm(current, pieces.get()).fold(
            { if (it.text.isBlank()) give(current, "Nothing was heard.") else land(it) },
            { give(current, it.message ?: "The host didn't answer.") },
        )
        forget()
    }

    /**
     * A take the Bubble gives back: dropped on the host so the bot is free for the next one, said on
     * the phone, and the mark reset. One epilogue, because the four ways a take fails all end here.
     */
    private fun give(current: String, message: String) {
        net?.cancel(current)
        fail(message)
        forget()
    }

    /** Words that landed say nothing: the field they landed in is the confirmation. */
    private fun land(answer: BubbleNet.Answer) {
        val landed = MementoAccessibilityService.live?.land(answer.text)
        if (landed?.landed == true) return
        keep(answer)
        // The phone's own reason where there is one — no field, a field that refused, no service —
        // and then where the words went instead.
        toast("${landed?.why ?: NO_TYPING} This take is saved in Gots.")
    }

    /** The words go to the app when the phone has nowhere to put them, so a take is never lost. */
    private fun keep(answer: BubbleNet.Answer) {
        val chosen = net?.bot ?: return
        BubbleConfig.keep(
            this,
            BubbleConfig.Kept(
                at = System.currentTimeMillis(),
                profileId = chosen.profileId,
                text = answer.text,
                heard = answer.heard,
                ms = answer.ms,
                level = answer.level,
                cleaned = answer.cleaned,
                provider = answer.provider,
                model = answer.model,
                id = UUID.randomUUID().toString(),
            ),
        )
    }

    /** A take the user abandoned: the host is told, and nothing is typed. */
    private fun cancel() {
        abandon("cancel")
        forget()
    }

    /**
     * Gives a take back: the microphone is stopped off the main thread, because joining the reader is
     * what flushes its last Piece, and the host is told to drop the take. `queued` puts that drop
     * behind the Pieces already on their way, which is what a teardown wants and a cancel does not.
     */
    private fun abandon(label: String, queued: Boolean = false) {
        val dying = recorder
        val client = net
        val current = take
        recorder = null
        take = null
        if (dying == null && current == null) return
        if (queued) {
            current?.let { id -> client?.let { one -> enqueue { runCatching { one.cancel(id) } } } }
            Thread({ dying?.stop() }, "memento-bubble-$label").start()
            return
        }
        Thread(
            {
                runCatching { dying?.stop() }
                current?.let { id -> client?.cancel(id) }
            },
            "memento-bubble-$label",
        ).start()
    }

    /**
     * Back to no take. Posted, because the take ends on the upload thread and every field it clears is
     * read here: the grace is a deadline the mark is drawn against.
     */
    private fun forget() {
        ui.post {
            val was = phase
            take = null
            failure = null
            pieces.set(0)
            phase = BubbleView.Face.Idle
            if (was != BubbleView.Face.Idle) {
                holdUntil = maxOf(holdUntil, System.currentTimeMillis() + GRACE_MS)
            }
            ui.removeCallbacks(halt)
            keepAwake(false)
            render()
            apply()
        }
    }

    private fun render() {
        bubble?.show(phase)
        resize(BubbleView.widthOf(this, phase))
    }

    /**
     * Something went wrong: it is said where the phone says things — the mark is too small to read a
     * sentence — and the mark stays a while after, so the retry is a tap rather than a hunt.
     */
    private fun fail(message: String) {
        toast(message)
        ui.post {
            holdUntil = maxOf(holdUntil, System.currentTimeMillis() + LINGER_MS)
            apply()
        }
    }

    private fun toast(message: String) {
        ui.post {
            runCatching { Toast.makeText(applicationContext, message, Toast.LENGTH_LONG).show() }
        }
    }

    private fun enqueue(task: () -> Unit) {
        try {
            uploads.execute(task)
        } catch (_: RejectedExecutionException) {
            // The service is on its way out: the take it belonged to is gone with it.
        }
    }

    /** The one place the window is redrawn: a move after the mark is gone is a crash, not a no-op. */
    private fun push(layout: WindowManager.LayoutParams) {
        bubble?.let { runCatching { windows.updateViewLayout(it, layout) } }
    }

    private fun removeMark() {
        bubble?.let { runCatching { windows.removeView(it) } }
        bubble = null
        params = null
    }

    private fun resize(width: Int) {
        val layout = params ?: return
        if (layout.width == width && layout.height == px(56)) return
        val screen = metrics()
        // The mark keeps the edge it is docked to: a pill on the right grows leftwards, so what
        // collapses back is the mark's own corner rather than a piece of the middle of the screen.
        val fromRight = layout.x + layout.width / 2 > screen.widthPixels / 2
        val right = layout.x + layout.width
        layout.width = width
        layout.height = px(56)
        layout.x = if (fromRight) right - width else layout.x
        layout.x = layout.x.coerceIn(0, (screen.widthPixels - width).coerceAtLeast(0))
        push(layout)
    }

    /** A take is a minute of someone talking: the screen going dark under it would end that. */
    private fun keepAwake(on: Boolean) {
        val layout = params ?: return
        val flag = WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
        val lit = layout.flags and flag != 0
        if (lit == on) return
        layout.flags = if (on) layout.flags or flag else layout.flags and flag.inv()
        push(layout)
    }

    private fun metrics() = resources.displayMetrics

    private fun channel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val channel = NotificationChannel(CHANNEL, "Dictation Bubble", NotificationManager.IMPORTANCE_LOW).apply {
            description = "The Bubble stays on the screen, and this says it is running."
            setShowBadge(false)
        }
        manager.createNotificationChannel(channel)
    }

    private fun notice(): Notification {
        val launch = packageManager.getLaunchIntentForPackage(packageName)
        val open = launch?.let {
            PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE)
        }
        val off = PendingIntent.getService(
            this,
            1,
            Intent(this, BubbleService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_bubble_mic)
            .setContentTitle("Dictate in other apps")
            .setContentText(BubbleConfig.bot(this)?.name?.takeIf { it.isNotBlank() } ?: NO_BOT)
            .setOngoing(true)
            .setSilent(true)
            .setContentIntent(open)
            .addAction(0, "Turn off", off)
            .build()
    }

    private fun announce() {
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.notify(NOTICE, notice())
    }

    companion object {
        const val ACTION_START = "app.memento.bubble.START"
        const val ACTION_STOP = "app.memento.bubble.STOP"
        const val ACTION_REFRESH = "app.memento.bubble.REFRESH"

        private const val CHANNEL = "bubble"
        private const val NOTICE = 4211
        private const val NO_BOT = "Choose a bot in Gots."
        private const val NO_TYPING = "Turn on accessibility to insert text."
        private const val SLOW = "The host is not keeping up."
        /** How often the two grants are looked at while the mark is on screen. */
        private const val WATCH_MS = 1_500L
        /** How long the mark stays after a take ends, with the keyboard down. */
        private const val GRACE_MS = 5_000L
        /** How long the mark stays after something went wrong, so a retry is one tap. */
        private const val LINGER_MS = 30_000L
        /** The page's own cap on one recording, so a take cannot grow without end. */
        private const val MAX_TAKE_MS = 10 * 60 * 1000L
        private const val PIECES_IN_FLIGHT = 4

        @Volatile
        private var running: BubbleService? = null

        /** Whether a mark is on the phone at all: with none, the phone's windows are nobody's business. */
        fun watching() = running != null

        /** Takes the mark away because a grant it needs has gone: the same end as turning it off. */
        fun standDown() {
            running?.quit()
        }

        /** A keyboard opened or closed: the one thing that decides whether the mark is shown. */
        fun keyboard(up: Boolean) {
            running?.onKeyboard(up)
        }

        fun start(context: Context) {
            ContextCompat.startForegroundService(
                context,
                Intent(context, BubbleService::class.java).setAction(ACTION_START),
            )
        }

        fun stop(context: Context) {
            context.startService(Intent(context, BubbleService::class.java).setAction(ACTION_STOP))
        }

        fun refresh(context: Context) {
            context.startService(Intent(context, BubbleService::class.java).setAction(ACTION_REFRESH))
        }
    }
}
