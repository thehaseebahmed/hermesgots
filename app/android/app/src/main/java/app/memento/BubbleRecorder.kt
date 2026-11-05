package app.memento

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.SystemClock
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

/**
 * A take's microphone, cut into Pieces on the same rule the page cuts on.
 *
 * The cut is the accuracy story: a Piece ends where the speaker paused, so one thought is heard as
 * one Piece. The length cap is not a second opinion — it exists so a room that never falls quiet
 * still closes a Piece, and it stays under the host's own queue allowance because a Piece is also
 * the tail a Stop waits for. These numbers are the page's (`app/src/lib/dictation.ts`), and
 * `bench/dictation/cut.py`'s `app_rule_problems` reads this file as well as that one, so a number
 * that moves here and not there fails the bench.
 */
class BubbleRecorder(
    private val onPiece: (wav: ByteArray, ms: Int) -> Unit,
    private val onLevel: (Float) -> Unit,
    private val onError: (String) -> Unit,
) {
    private val samples = ShortArray(FRAME)
    private var record: AudioRecord? = null
    private var thread: Thread? = null

    @Volatile private var running = false

    @SuppressLint("MissingPermission")
    fun start(): Boolean {
        if (running) return true
        val buffer = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        if (buffer <= 0) {
            onError("This phone cannot record at $RATE Hz.")
            return false
        }
        val recorder = try {
            AudioRecord(
                MediaRecorder.AudioSource.VOICE_RECOGNITION,
                RATE,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                buffer * 2,
            )
        } catch (error: Exception) {
            // Not `TAKEN`: a phone that cannot build an `AudioRecord` at all is a different answer
            // from a microphone another app holds, and only one of them is the user's to fix.
            onError("The microphone could not open: ${error.message ?: "unknown"}.")
            return false
        }
        if (recorder.state != AudioRecord.STATE_INITIALIZED) {
            recorder.release()
            onError(TAKEN)
            return false
        }
        record = recorder
        running = true
        recorder.startRecording()
        thread = Thread({ listen(recorder) }, "memento-bubble-recorder").apply {
            isDaemon = true
            start()
        }
        return true
    }

    /** Joins the reading thread, which flushes the Piece the take was in the middle of. */
    fun stop() {
        running = false
        thread?.join(1500)
        thread = null
        record?.let {
            if (it.recordingState == AudioRecord.RECORDSTATE_RECORDING) it.stop()
            it.release()
        }
        record = null
    }

    private fun listen(recorder: AudioRecord) {
        val meter = Meter()
        val buffer = ByteArrayOutputStream()
        var pieceStart = SystemClock.elapsedRealtime()
        var heard = false
        var quietSince = -1L
        // The meter is read out every other frame: one reading per 100 ms is what a person sees, and a
        // level per 50 ms frame scrolled the bars twice as fast and read quieter than the room was.
        var energy = 0.0
        var counted = 0
        var frames = 0
        try {
            while (running) {
                val read = recorder.read(samples, 0, samples.size)
                // A negative read is the microphone failing, not a frame that has not arrived yet:
                // `continue` here spins the loop at a full core until something else stops the take,
                // and nothing else does.
                if (read < 0) {
                    onError("The microphone stopped: $read.")
                    return
                }
                if (read == 0) continue
                val squares = squares(samples, read)
                buffer.write(pcm(samples, read))
                val loudness = sqrt(squares / read).toFloat()
                val quiet = meter.quiet(loudness)
                val now = SystemClock.elapsedRealtime()
                if (!quiet) {
                    heard = true
                    quietSince = -1
                } else if (quietSince < 0) {
                    quietSince = now
                }
                energy += squares
                counted += read
                frames += 1
                if (frames >= LEVEL_FRAMES) {
                    // Raw, because the meter owns the scale: a loudness the view has to undo is a
                    // scale in two places, and the two drifted apart the moment either moved.
                    onLevel(sqrt(energy / counted).toFloat())
                    energy = 0.0
                    counted = 0
                    frames = 0
                }
                val length = now - pieceStart
                val pause = if (quietSince < 0) 0 else now - quietSince
                // A stretch that has heard nothing never becomes a Piece: a room's tone is free.
                if (heard && (length >= LONG_PIECE_MS || (length >= PIECE_MS && pause >= PAUSE_MS))) {
                    if (buffer.size() > 0) onPiece(wav(buffer.toByteArray()), length.toInt())
                    buffer.reset()
                    pieceStart = now
                    heard = false
                    quietSince = -1
                }
            }
        } catch (error: Exception) {
            onError("The microphone stopped: ${error.message ?: "unknown"}")
        } finally {
            // Whatever is still in the buffer when the take ends is the last thing said. Waiting for
            // the meter to call it speech is how a take loses its last words: a quiet tail is still
            // the user's.
            val tail = (SystemClock.elapsedRealtime() - pieceStart).toInt()
            if (buffer.size() > 0 && tail >= TAIL_MS) onPiece(wav(buffer.toByteArray()), tail)
        }
    }

    private fun pcm(from: ShortArray, count: Int): ByteArray {
        val bytes = ByteArray(count * 2)
        for (index in 0 until count) {
            val sample = from[index].toInt()
            bytes[index * 2] = (sample and 0xFF).toByte()
            bytes[index * 2 + 1] = ((sample shr 8) and 0xFF).toByte()
        }
        return bytes
    }

    /** The frame's energy, which is what a loudness reading is: the square root is taken where it is used. */
    private fun squares(from: ShortArray, count: Int): Double {
        var sum = 0.0
        for (index in 0 until count) {
            val sample = from[index] / 32768.0
            sum += sample * sample
        }
        return sum
    }

    /**
     * The Piece's whole file: the host probes the container it is given and never remuxes, so a Piece
     * of bare samples would be silence to it.
     */
    private fun wav(from: ByteArray): ByteArray {
        val out = ByteArray(44 + from.size)
        val head = ByteBuffer.wrap(out).order(ByteOrder.LITTLE_ENDIAN)
        head.put("RIFF".toByteArray())
        head.putInt(36 + from.size)
        head.put("WAVE".toByteArray())
        head.put("fmt ".toByteArray())
        head.putInt(16)
        head.putShort(1)
        head.putShort(1)
        head.putInt(RATE)
        head.putInt(RATE * 2)
        head.putShort(2)
        head.putShort(16)
        head.put("data".toByteArray())
        head.putInt(from.size)
        System.arraycopy(from, 0, out, 44, from.size)
        return out
    }

    /**
     * Quiet is relative to the room: the floor creeps towards the quietest thing heard so far, and a
     * frame counts as a pause only when it is well under it. A fixed threshold would call a noisy
     * street's silence speech and a hushed room's speech silence.
     */
    private class Meter {
        private var floor = Double.MAX_VALUE

        fun quiet(loudness: Float): Boolean {
            val level = loudness.toDouble()
            floor = if (level < floor) level else floor + (level - floor) * 0.002
            return level < min(max(QUIET_MIN, floor * 2.5), QUIET_MAX)
        }
    }

    companion object {
        private const val RATE = 16_000
        /** One tick of the meter, and the span a cut is confirmed on: the page reads every 50 ms. */
        private const val FRAME = 800
        /** How many frames one meter reading is made of: two 50 ms frames are the 100 ms a person sees. */
        private const val LEVEL_FRAMES = 2
        private const val PIECE_MS = 1_200
        private const val PAUSE_MS = 350
        private const val LONG_PIECE_MS = 25_000
        /** The shortest tail worth sending: under it there is nothing to hear (the page's own floor). */
        private const val TAIL_MS = 300
        private const val QUIET_MIN = 0.012
        private const val QUIET_MAX = 0.05
        private const val TAKEN = "The microphone is in use by another app."
    }
}
