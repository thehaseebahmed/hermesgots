package app.memento

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.View
import android.view.animation.LinearInterpolator
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import kotlin.math.ln
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * What the Bubble looks like, one face at a time.
 *
 * Idle it is a mark and nothing else. A take shows a level meter rather than words: the host answers
 * a take once, at its end, so there is nothing true to draw while the user talks. A take being heard
 * turns the pill into a spinner, because the only thing happening then is waiting on a host. Nothing
 * is said on the mark itself — what went wrong is a toast, where the phone already says things.
 */
class BubbleView(context: Context) : FrameLayout(context) {

    /** The three states a take puts the mark in, and the only thing that decides what is drawn. */
    enum class Face { Idle, Recording, Waiting }

    var onCancel: (() -> Unit)? = null
    var onDone: (() -> Unit)? = null

    private val circle: FrameLayout
    private val pill: LinearLayout
    private val cancel: ImageView
    private val meter: LevelMeter
    private val done: ImageView
    private val loading: Loading

    init {
        background = GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            cornerRadius = context.px(MARK_DP / 2).toFloat()
            // A mark over someone else's app is read past, not looked at: three parts solid, two clear.
            setColor(0xB31C1C1E.toInt())
        }

        circle = FrameLayout(context).apply {
            addView(WaveMark(context), LayoutParams(context.px(22), context.px(21), Gravity.CENTER))
        }
        addView(circle, LayoutParams(context.px(MARK_DP), context.px(MARK_DP)))

        cancel = context.glyph(R.drawable.ic_bubble_close, "Cancel", 10)
        done = context.glyph(R.drawable.ic_bubble_check, "Done", 10)
        meter = LevelMeter(context)
        loading = Loading(context)

        pill = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            // Centred as much as it is vertical: a face with one child would otherwise be laid out at
            // the start of a wider window, and the gap that leaves reads as a mistake.
            gravity = Gravity.CENTER
            setPadding(context.px(6), 0, context.px(6), 0)
        }
        pill.addView(cancel, LinearLayout.LayoutParams(context.px(42), context.px(42)))
        pill.addView(meter, LinearLayout.LayoutParams(0, context.px(MARK_DP), 1f))
        pill.addView(done, LinearLayout.LayoutParams(context.px(42), context.px(42)))
        pill.addView(loading, LinearLayout.LayoutParams(context.px(34), context.px(34)))
        addView(pill, LayoutParams(LayoutParams.MATCH_PARENT, context.px(MARK_DP)))

        cancel.setOnClickListener { onCancel?.invoke() }
        done.setOnClickListener { onDone?.invoke() }
        show(Face.Idle)
    }

    fun show(face: Face) {
        val idle = face == Face.Idle
        val recording = face == Face.Recording
        circle.visibility = if (idle) VISIBLE else GONE
        pill.visibility = if (idle) GONE else VISIBLE
        // The wait is the loader and nothing else: a cross beside a spinner read as two things to do
        // at once. A tap still gives the take back, which is the way out of a host that never answers.
        cancel.visibility = if (recording) VISIBLE else GONE
        meter.visibility = if (recording) VISIBLE else GONE
        done.visibility = if (recording) VISIBLE else GONE
        loading.visibility = if (face == Face.Waiting) VISIBLE else GONE
        if (recording) meter.restart()
        loading.spin(face == Face.Waiting)
    }

    /** The newest loudness of the take, in the room's own units. */
    fun level(loudness: Float) {
        meter.push(loudness)
    }

    companion object {
        /**
         * The mark's diameter: a control that floats over another app's text is read past, so it is
         * drawn at the size a person's thumb still finds and a line of text still reads under — the
         * size the marks that do this job on Android use.
         */
        const val MARK_DP = 48

        /**
         * The gap between the mark and the screen's edge it is docked to. A mark flush against the
         * side is one the app underneath cannot be read beside, and one the phone's own edge gesture
         * fights for.
         */
        const val EDGE_DP = 20

        /**
         * The window a face asks for, in the view's own arithmetic: the mark is a circle, and a pill
         * is its children and its padding, so a child that changes size moves its window with it.
         */
        fun widthOf(context: Context, face: Face) = when (face) {
            Face.Idle -> context.px(MARK_DP)
            Face.Recording -> context.px(196)
            Face.Waiting -> context.px(MARK_DP)
        }
    }
}

/**
 * Where a dragged mark is dropped: the same circle and the same cross as the mark, in the mark's own
 * colour, so it reads as "put it here" and not as a warning. It turns red only when the mark is
 * actually over it, which is the one moment the drop will turn the Bubble off.
 */
class Bin(context: Context) : FrameLayout(context) {
    private val circle = GradientDrawable().apply {
        shape = GradientDrawable.OVAL
        setColor(COLD)
    }

    init {
        background = circle
        // The pill's own cross, a little larger: a third more than the one in the recorder, which is
        // the size of the tick beside it.
        addView(
            context.glyph(R.drawable.ic_bubble_close, "Turn the Bubble off", 0),
            LayoutParams(context.px(36), context.px(36), Gravity.CENTER),
        )
    }

    fun over(on: Boolean) {
        circle.setColor(if (on) HOT else COLD)
    }

    private companion object {
        /** The mark's own shade: over someone else's app, the bin is another mark, not a warning. */
        val COLD = 0xB31C1C1E.toInt()
        /** The drop that will land, and nothing else. */
        val HOT = 0xB3C2362B.toInt()
    }
}

internal fun Context.px(value: Int) = (value * resources.displayMetrics.density).roundToInt()

internal fun Context.px(value: Float) = value * resources.displayMetrics.density

/** One glyph of the mark: white, centred, and padded to the target it is pressed through. */
private fun Context.glyph(drawable: Int, label: String, pad: Int) = ImageView(this).apply {
    setImageResource(drawable)
    setColorFilter(Color.WHITE)
    contentDescription = label
    scaleType = ImageView.ScaleType.CENTER_INSIDE
    setPadding(px(pad), px(pad), px(pad), px(pad))
}

/**
 * The mark's own face: a voice, drawn rather than shipped.
 *
 * A stroke-only vector tinted through an ImageView's colour filter came out blank on a phone, so the
 * five bars are drawn here, where there is nothing to inflate and nothing to tint.
 */
private class WaveMark(context: Context) : View(context) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.WHITE
        strokeCap = Paint.Cap.ROUND
        strokeWidth = context.px(2.2f)
    }

    override fun onDraw(canvas: Canvas) {
        val heights = floatArrayOf(0.4f, 0.7f, 1f, 0.7f, 0.4f)
        val gap = width.toFloat() / (heights.size + 1)
        val middle = height / 2f
        heights.forEachIndexed { index, share ->
            val bar = share * (height * 0.85f)
            val x = gap * (index + 1)
            canvas.drawLine(x, middle - bar / 2f, x, middle + bar / 2f, paint)
        }
    }
}

/**
 * The take's own pulse: how loud the room is, which is the only thing that is true while it runs.
 *
 * It is its full width from the first frame — a fixed ring of bars every sample pushes through, so
 * the meter never begins as a stub at one end and fills up — and every slot is drawn as a bar, at the
 * height its loudness earns. A level is read against the room rather than against full scale: the
 * floor follows the quietest thing heard and a bar is the distance above it, so a quiet speaker in a
 * quiet room moves the meter as far as a loud one in a noisy room, and no microphone's gain has to be
 * guessed at. Silence is the floor, and the floor draws as a dot.
 */
private class LevelMeter(context: Context) : View(context) {
    private val bars = FloatArray(BARS) { 0f }
    private val dot = context.px(STROKE_DP)
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.WHITE
        strokeCap = Paint.Cap.ROUND
        strokeWidth = dot
    }

    /** The quietest the room has been heard: what every later level is a distance above. */
    private var floor = Float.MAX_VALUE

    /** Back to silence across the whole width, for a take about to start. */
    fun restart() {
        bars.fill(0f)
        floor = Float.MAX_VALUE
        invalidate()
    }

    /** The room as it arrives, unscaled: the height it draws at is this view's to decide. */
    fun push(loudness: Float) {
        // A quieter reading is the room; a louder one only creeps the floor up, so a cough cannot
        // leave the meter deaf for the rest of the take.
        floor = if (loudness < floor) loudness else floor + (loudness - floor) * CREEP
        System.arraycopy(bars, 1, bars, 0, BARS - 1)
        bars[BARS - 1] = loudness
        invalidate()
    }

    override fun onDraw(canvas: Canvas) {
        if (width <= 0 || height <= 0) return
        val step = width.toFloat() / BARS
        val middle = height / 2f
        val tallest = height * TALLEST
        for (index in 0 until BARS) {
            val x = step * index + step / 2f
            // Silence is a dot rather than a gap: the row of them is the meter at rest, which is what
            // a take looks like between two words.
            val bar = dot + share(bars[index]) * (tallest - dot)
            canvas.drawLine(x, middle - bar / 2f, x, middle + bar / 2f, paint)
        }
    }

    /**
     * How far a reading stands above the room, from nothing at the floor to one at the ratio speech
     * is above it. A ratio, so the microphone's gain and the phone's own loudness cancel.
     */
    private fun share(loudness: Float): Float {
        val base = (if (floor == Float.MAX_VALUE) loudness else floor).coerceAtLeast(QUIETEST)
        if (loudness <= base) return 0f
        return (ln(loudness / base) / ln(SPEECH_RATIO)).coerceIn(0f, 1f)
    }

    private companion object {
        const val BARS = 22
        /** A bar's own width: thin enough that a row of them reads as a wave rather than a fence. */
        const val STROKE_DP = 1.8f
        /** The tallest a bar is drawn, as a share of the pill's height: a band, not the whole face. */
        const val TALLEST = 0.30f
        /** The distance above the room that earns a full bar: ordinary speech at arm's length. */
        const val SPEECH_RATIO = 24f
        /** No bar is read against a floor quieter than this, so a silent room still has one. */
        const val QUIETEST = 0.0004f
        /** How fast the floor follows a louder room, per reading: slowly, as the recorder's does. */
        const val CREEP = 0.002f
    }
}

/** The wait, drawn: an arc going round while the host hears the take. */
private class Loading(context: Context) : View(context) {
    private var angle = 0f
    private var wanted = false
    private val spin = ValueAnimator.ofFloat(0f, 360f).apply {
        duration = 900
        repeatCount = ValueAnimator.INFINITE
        interpolator = LinearInterpolator()
        addUpdateListener {
            angle = it.animatedValue as Float
            invalidate()
        }
    }
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        color = Color.WHITE
        strokeCap = Paint.Cap.ROUND
        strokeWidth = context.px(2f)
    }
    private val box = RectF()

    /**
     * Runs only while it is the wait. An infinite animator left running behind a hidden child is a
     * main-thread wakeup every frame for something nobody can see, for as long as the Bubble is on.
     */
    fun spin(on: Boolean) {
        wanted = on
        if (on && !spin.isStarted) spin.start()
        if (!on && spin.isStarted) spin.cancel()
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        if (wanted) spin.start()
    }

    override fun onDetachedFromWindow() {
        spin.cancel()
        super.onDetachedFromWindow()
    }

    override fun onDraw(canvas: Canvas) {
        val radius = min(width, height) * 0.3f
        val x = width / 2f
        val y = height / 2f
        box.set(x - radius, y - radius, x + radius, y + radius)
        canvas.save()
        canvas.rotate(angle, x, y)
        canvas.drawArc(box, -90f, 280f, false, paint)
        canvas.restore()
    }
}
