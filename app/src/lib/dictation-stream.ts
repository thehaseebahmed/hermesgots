/**
 * A dictation heard while it is spoken: one continuous recording, sliced as it is made and sent to
 * the bot's host, whose answer carries the words it has newly committed.
 *
 * A slice is in flight before the next one is sent, so nothing queues up on the host and a phrase's
 * words arrive in the order they were said. Everything the take has heard lives here rather than in
 * the composer: the bar shows it and the whole take lands in the field in one write when it ends
 * (ADR 0016).
 */
import { useCallback, useEffect, useRef, useState } from "react"

import {
  BARS,
  MAX_MS,
  QUIET_MAX,
  QUIET_MIN,
  SAMPLE_MS,
  SILENT,
  SILENT_MS,
  STOPPED,
  STOP_MS,
  TAKEN,
  canRecord,
  micError,
  recordingType,
  type DictationStatus,
} from "@/lib/dictation"
import {
  EMPTY_TRANSCRIPT,
  hear,
  openingTranscript,
  settled,
  transcriptText,
  type DictationAnswer,
  type DictationTranscript,
} from "@/lib/dictation-transcript"
import { WRITE_TIMEOUT_MS } from "@/lib/freshness"
import {
  HermesError,
  cancelDictationTake,
  sendDictationAudio,
  startDictationTake,
  stopDictationTake,
  type HermesConfig,
} from "@/lib/hermes"

/** The slice a recording is flushed in: the app sends each one as it is produced. */
const SLICE_MS = 250
/** Quiet this long after speech is a pause; the slice that lands in one closes the phrase. */
const PHRASE_PAUSE_MS = 700
/** A cold host loads, or first downloads, its model inside the start call, as a clip did. */
const START_MS = 120_000
/** The slices still waiting when Stop lands are sent before the tail is asked for. */
const DRAIN_MS = 10_000
const CANCEL_MS = 5_000
const TOO_LONG = "The bot took too long to hear the dictation."

interface Slice {
  blob: Blob
  pause: boolean
}

interface TakeSession {
  /** The host's take, once it has answered; null while a cold host is still loading its model. */
  take: string | null
  /** Resolves when the take opened or failed, so Stop can wait for a cold host instead of losing it. */
  asking: Promise<void>
  stream: MediaStream | null
  recorder: MediaRecorder | null
  audio?: AudioContext
  meter?: number
  cap?: number
  watch?: number
  slices: number
  queue: Slice[]
  running: Promise<void> | null
  upload: AbortController | null
  closed: boolean
  failure: string | null
  /** Whether the meter has heard speech at all, so a silent take doesn't close phrases. */
  heard: boolean
  quietSince: number | null
  /** A pause the app heard, waiting for the next slice to carry it. */
  pauseNext: boolean
  /** Whether this pause has been marked already, so one pause closes one phrase. */
  pauseMarked: boolean
  startedAt: number
}

/** Whether the host no longer has this take: it expired, was cancelled, or never existed. */
function ended(failure: unknown) {
  return failure instanceof HermesError && (failure.status === 404 || failure.status === 410)
}

function reason(failure: unknown, otherwise: string) {
  if (failure instanceof DOMException && failure.name === "AbortError") return TOO_LONG
  if (failure instanceof Error && failure.message) return failure.message
  return otherwise
}

function release(recording: TakeSession) {
  window.clearInterval(recording.meter)
  window.clearTimeout(recording.cap)
  window.clearTimeout(recording.watch)
  recording.stream?.getTracks().forEach((track) => track.stop())
  void recording.audio?.close().catch(() => {})
  recording.stream = null
  recording.audio = undefined
}

/** Stops the recorder and lets the mic go, bounded: a recorder that died fires no stop of its own. */
function stopRecording(recording: TakeSession) {
  return new Promise<void>((done) => {
    const recorder = recording.recorder
    recording.recorder = null
    if (!recorder || recorder.state === "inactive") {
      done()
      return
    }
    const timer = window.setTimeout(done, STOP_MS)
    recorder.addEventListener(
      "stop",
      () => {
        window.clearTimeout(timer)
        done()
      },
      { once: true },
    )
    try {
      recorder.stop()
    } catch {
      window.clearTimeout(timer)
      done()
    }
  })
}

function within(promise: Promise<unknown>, ms: number) {
  return Promise.race([
    promise.catch(() => undefined),
    new Promise((done) => window.setTimeout(done, ms)),
  ])
}

/** A dictation the bot's host hears as it is spoken, one slice at a time. */
export function useStreamDictation(config: HermesConfig, hint: string) {
  const [status, setStatus] = useState<DictationStatus>("idle")
  const [levels, setLevels] = useState<number[] | null>(null)
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [transcript, setTranscript] = useState<DictationTranscript>(EMPTY_TRANSCRIPT)
  const session = useRef<TakeSession | null>(null)
  const heard = useRef<DictationTranscript>(EMPTY_TRANSCRIPT)
  const latest = useRef({ config, hint })
  useEffect(() => {
    latest.current = { config, hint }
  })

  const show = useCallback((next: DictationTranscript) => {
    heard.current = next
    setTranscript(next)
  }, [])

  const showIdle = useCallback(() => {
    setStatus("idle")
    setLevels(null)
    setStartedAt(null)
    setError(null)
    show(EMPTY_TRANSCRIPT)
  }, [show])

  /** Ends a take that can't go on, keeping what the host already heard so Retry can ask for it. */
  const fail = useCallback((current: TakeSession, message: string) => {
    if (session.current !== current || current.failure) return
    current.failure = message
    current.closed = true
    current.upload?.abort()
    current.upload = null
    release(current)
    setLevels(null)
    setError(message)
    setStatus("failed")
  }, [])

  /** Sends the queued slices in order, one request in flight, and folds each answer in. */
  const pump = useCallback(
    (current: TakeSession): Promise<void> => {
      if (current.running) return current.running
      const run = (async () => {
        while (!current.closed && current.take && current.queue.length) {
          const slice = current.queue.shift() as Slice
          const controller = new AbortController()
          current.upload = controller
          const timer = window.setTimeout(() => controller.abort(), WRITE_TIMEOUT_MS)
          try {
            const answer: DictationAnswer = await sendDictationAudio(
              latest.current.config,
              current.take,
              slice.blob,
              slice.pause,
              controller.signal,
            )
            if (current.closed || session.current !== current) return
            show(hear(heard.current, answer))
          } catch (failure) {
            if (current.closed || session.current !== current) return
            // The host let the take go (it went quiet, or its model fell over): nothing more to
            // send, and what it already heard is still on the bar.
            if (ended(failure)) {
              current.take = null
              current.closed = true
              return
            }
            fail(current, reason(failure, "Couldn't hear the recording."))
            return
          } finally {
            window.clearTimeout(timer)
            if (current.upload === controller) current.upload = null
          }
        }
      })()
      const tracked = run.finally(() => {
        if (current.running === tracked) current.running = null
      })
      current.running = tracked
      return tracked
    },
    [fail, show],
  )

  const clear = useCallback(
    (current: TakeSession) => {
      current.closed = true
      current.upload?.abort()
      current.upload = null
      release(current)
      if (session.current === current) session.current = null
      showIdle()
    },
    [showIdle],
  )

  const start = useCallback(async () => {
    if (session.current || !canRecord()) return
    const current: TakeSession = {
      take: null,
      asking: Promise.resolve(),
      stream: null,
      recorder: null,
      slices: 0,
      queue: [],
      running: null,
      upload: null,
      closed: false,
      failure: null,
      heard: false,
      quietSince: null,
      pauseNext: false,
      pauseMarked: false,
      startedAt: Date.now(),
    }
    session.current = current
    setError(null)
    setLevels(null)
    setStatus("listening")
    show(openingTranscript())

    // The host is asked for a take while the mic is opened, so the model has the whole time the
    // user is speaking to load. The slices wait for it: nothing is sent before the host has a take.
    const asking = new AbortController()
    const cold = window.setTimeout(() => asking.abort(), START_MS)
    current.asking = startDictationTake(latest.current.config, latest.current.hint, asking.signal)
      .then((opened) => {
        if (session.current !== current) return
        current.take = opened.take
        show(settled(heard.current))
        void pump(current)
      })
      .catch((failure) => {
        if (session.current !== current) return
        fail(current, reason(failure, "Couldn't start the dictation."))
      })
      .finally(() => window.clearTimeout(cold))

    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })
    } catch (failure) {
      asking.abort()
      if (session.current === current) {
        session.current = null
        showIdle()
      }
      throw new Error(micError(failure, "Couldn't start the microphone."))
    }
    // Cancelled while the mic was asked for.
    if (session.current !== current) {
      stream.getTracks().forEach((track) => track.stop())
      return
    }

    const recorder = new MediaRecorder(stream, {
      mimeType: recordingType(),
      audioBitsPerSecond: 24_000,
    })
    current.stream = stream
    current.recorder = recorder
    recorder.ondataavailable = (event) => {
      if (!event.data.size || current.closed) return
      window.clearTimeout(current.watch)
      current.slices += 1
      current.queue.push({ blob: event.data, pause: current.pauseNext })
      current.pauseNext = false
      void pump(current)
    }
    recorder.onerror = (event) =>
      fail(current, micError((event as Event & { error?: unknown }).error, STOPPED))
    // A recorder that has sent nothing by now is dead, not quiet: silence still encodes.
    current.watch = window.setTimeout(() => {
      if (!current.slices) fail(current, SILENT)
    }, SILENT_MS)
    recorder.start(SLICE_MS)
    // Another app taking the mic, or the device revoking it, ends the track under the recorder.
    stream
      .getAudioTracks()
      .forEach((track) => track.addEventListener("ended", () => fail(current, TAKEN)))
    setStartedAt(current.startedAt)
    // Past the cap the recording stops growing; Stop still sends what was heard.
    current.cap = window.setTimeout(() => void stopRecording(current), MAX_MS)

    try {
      const audio = new AudioContext()
      void audio.resume().catch(() => {})
      const analyser = audio.createAnalyser()
      analyser.fftSize = 512
      audio.createMediaStreamSource(stream).connect(analyser)
      current.audio = audio
      const motion = !window.matchMedia("(prefers-reduced-motion: reduce)").matches
      const samples = new Uint8Array(analyser.fftSize)
      let history = Array<number>(BARS).fill(0)
      let floor = Infinity
      current.meter = window.setInterval(() => {
        analyser.getByteTimeDomainData(samples)
        let sum = 0
        for (const sample of samples) sum += ((sample - 128) / 128) ** 2
        const loudness = Math.sqrt(sum / samples.length)
        // The quietest the room gets, creeping up slowly so a noisier room is learnt.
        floor = loudness < floor ? loudness : floor + (loudness - floor) * 0.002
        const quiet = loudness < Math.min(Math.max(QUIET_MIN, floor * 2.5), QUIET_MAX)
        const now = Date.now()
        if (!quiet) {
          current.quietSince = null
          current.heard = true
          current.pauseMarked = false
        } else {
          current.quietSince ??= now
          // A pause the app hears itself is what ends a phrase; the host is told on the next slice.
          if (
            current.heard &&
            !current.pauseMarked &&
            now - current.quietSince >= PHRASE_PAUSE_MS
          ) {
            current.pauseNext = true
            current.pauseMarked = true
          }
        }
        if (motion && session.current === current) {
          history = [...history.slice(1), Math.min(1, loudness * 5)]
          setLevels(history)
        }
      }, SAMPLE_MS)
    } catch {
      // Without a meter the take still goes; phrases then close only where the user stops.
    }
  }, [fail, pump, show, showIdle])

  /**
   * Ends the take and returns what was heard: `""` when there's nothing to put in the field, null
   * when the host couldn't finish it (the bar keeps the words, and Retry asks again).
   */
  const finish = useCallback(async () => {
    const current = session.current
    if (!current) return ""
    // Stop waits for a cold host to open the take, so what was said while it loaded isn't lost.
    await current.asking.catch(() => undefined)
    if (session.current !== current) return null
    setStatus("transcribing")
    setLevels(null)
    setError(null)
    await stopRecording(current)
    // Everything still queued is sent before the tail is asked for.
    await within(pump(current), DRAIN_MS)
    if (session.current !== current) return null
    const take = current.take
    if (!take) {
      // The host let the take go before Stop: what it already committed is still what was said.
      const text = transcriptText(heard.current)
      clear(current)
      return text
    }
    try {
      const answer = await stopDictationTake(
        latest.current.config,
        take,
        AbortSignal.timeout(WRITE_TIMEOUT_MS),
      )
      const final = hear(heard.current, answer)
      show(final)
      const text = transcriptText(final)
      clear(current)
      return text
    } catch (failure) {
      fail(current, reason(failure, "Couldn't finish the dictation."))
      return null
    }
  }, [clear, fail, pump, show])

  const cancel = useCallback(() => {
    const current = session.current
    session.current = null
    if (current) {
      current.closed = true
      current.upload?.abort()
      current.upload = null
      void stopRecording(current)
      release(current)
      if (current.take) {
        void cancelDictationTake(
          latest.current.config,
          current.take,
          AbortSignal.timeout(CANCEL_MS),
        ).catch(() => undefined)
      }
    }
    showIdle()
  }, [showIdle])

  /** Asks the host for what it heard after a take that couldn't be finished, and returns it. */
  const retry = useCallback(async () => {
    const current = session.current
    if (!current) return null
    const take = current.take
    if (!take) {
      const text = transcriptText(heard.current)
      cancel()
      return text
    }
    current.failure = null
    setError(null)
    setStatus("transcribing")
    try {
      const answer = await stopDictationTake(
        latest.current.config,
        take,
        AbortSignal.timeout(WRITE_TIMEOUT_MS),
      )
      const final = hear(heard.current, answer)
      show(final)
      const text = transcriptText(final)
      clear(current)
      return text
    } catch (failure) {
      // The host let the take go: what it had already committed is still the take.
      if (ended(failure)) {
        const text = transcriptText(heard.current)
        clear(current)
        return text
      }
      fail(current, reason(failure, "Couldn't finish the dictation."))
      return null
    }
  }, [cancel, clear, fail, show])

  // A take abandoned before it ends inserts nothing, and the host is told to let it go. Kept takes
  // are the next ticket's: this one drops the audio rather than pretending to hold it.
  useEffect(
    () => () => {
      const current = session.current
      session.current = null
      if (!current) return
      current.closed = true
      current.upload?.abort()
      void stopRecording(current)
      release(current)
      if (current.take) {
        void cancelDictationTake(
          latest.current.config,
          current.take,
          AbortSignal.timeout(CANCEL_MS),
        ).catch(() => undefined)
      }
    },
    [],
  )

  return {
    status,
    levels,
    startedAt,
    error,
    transcript,
    /** When the recording started, for a hold that ends before the mic was granted. */
    recordingSince: () => session.current?.startedAt ?? null,
    start,
    finish,
    retry,
    cancel,
  }
}
