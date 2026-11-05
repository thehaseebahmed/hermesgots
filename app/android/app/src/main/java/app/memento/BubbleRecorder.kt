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

    /**
     * Joins the reading thread, which flushes the Piece the take was in the middle of: the tail is
     * the reader's own ending, and this waits for it because the service queues the take's Confirm
     * only after `stop()` returns. A tail still on its way when that Confirm went would be answered
     * for by a count that never included it, which is a take missing its last words and no error
     * anywhere to say so.
     */
    fun stop() {
        running = false
        // The stop runs on a thread of the service's own, never the main one, so this wait costs the
        // phone nothing; the bound is only for a reader too wedged to hear its own ending.
        thread?.join(FLUSH_MS)
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
        var peak = 0f
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
                // The block's loudest frame, not its average: a meter drawn from means flattens
                // every peak into the room around it, which is a wave that never looks like talking.
                if (loudness > peak) peak = loudness
                frames += 1
                if (frames >= LEVEL_FRAMES) {
                    // Raw, because the meter owns the scale: a loudness the view has to undo is a
                    // scale in two places, and the two drifted apart the moment either moved.
                    onLevel(peak)
                    peak = 0f
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
            // The device captured everything up to the Stop, and the reader has only read the frames
            // it asked for: what is left sits in the device's own buffer until the device is
            // released, and releasing it throws the end of the take away. Read it out here, where
            // the recorder is still the one that heard it.
            drain(recorder, buffer)
            val tail = (SystemClock.elapsedRealtime() - pieceStart).toInt()
            // Whatever is left is the last thing said, however quiet the meter found it: the end of
            // a take is not the place to decide a word was too small to be the user's.
            if (buffer.size() > 0) onPiece(wav(buffer.toByteArray()), tail)
        }
    }

    /**
     * Everything the device already holds and the reader had not read, taken out in one go — without
     * waiting for audio that has not been said yet, so a Stop costs the buffer's own length and no
     * more.
     */
    private fun drain(recorder: AudioRecord, into: ByteArrayOutputStream) {
        var read: Int
        do {
            read = runCatching {
                recorder.read(samples, 0, samples.size, AudioRecord.READ_NON_BLOCKING)
            }.getOrDefault(0)
            if (read > 0) into.write(pcm(samples, read))
        } while (read > 0)
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
        /** How long a Stop waits for the reader to flush the tail it is holding. */
        private const val FLUSH_MS = 5_000L
        private const val QUIET_MIN = 0.012
        private const val QUIET_MAX = 0.05
        private const val TAKEN = "The microphone is in use by another app."
    }
}
