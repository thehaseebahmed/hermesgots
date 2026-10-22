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
  keptKeeper,
  keptText,
  micError,
  readKept,
  recordingType,
  type DictationStatus,
} from "@/lib/dictation"
import { RESTORED, type Keeper } from "@/lib/dictation-kept"
import {
  EMPTY_TRANSCRIPT,
  hear,
  openingTranscript,
  settled,
  transcriptText,
  type DictationAnswer,
  type DictationTranscript,
} from "@/lib/dictation-transcript"
import type { DictationPiece } from "@/lib/db"
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
  /** The composer's draft key: the take's audio is kept on the device under it. */
  key?: string
  /** Where the caret was when the take began, so a kept take lands where it was left. */
  caret?: number
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
  /** Whether its audio still belongs on the device: no once its text is in, or it was let go. */
  keeping: boolean
  failure: string | null
  /** The take's audio as the device holds it: one piece per slice, none of them transcribed. */
  kept: DictationPiece[]
  /** Writes `kept` to the device no more often than every 2 s. */
  keeper: Keeper
  /** Read back from the device after a reload: no longer live, so the batch route hears it whole. */
  restored: boolean
  /** Whether the meter has heard speech at all, so a silent take doesn't close phrases. */
  heard: boolean
  quietSince: number | null
  /** A pause the app heard, waiting for the next slice to carry it. */
  pauseNext: boolean
  /** Whether this pause has been marked already, so one pause closes one phrase. */
  pauseMarked: boolean
  startedAt: number
}

function newTake(
  key: string | undefined,
  caret?: number,
  kept: DictationPiece[] = [],
): TakeSession {
  return {
    key,
    caret,
    take: null,
    asking: Promise.resolve(),
    stream: null,
    recorder: null,
    slices: 0,
    queue: [],
    running: null,
    upload: null,
    closed: false,
    keeping: true,
    failure: null,
    kept,
    keeper: keptKeeper(key),
    restored: false,
    heard: false,
    quietSince: null,
    pauseNext: false,
    pauseMarked: false,
    startedAt: Date.now(),
  }
}

/** Holds a slice of the take for the device, written at the pace the keeper writes at. */
function keepSlice(current: TakeSession, blob: Blob) {
  current.kept.push({ blob, text: null })
  void current.keeper.keep({ pieces: [...current.kept], caret: current.caret })
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
export function useStreamDictation(
  config: HermesConfig,
  hint: string,
  key?: string,
  vocabulary: string[] = [],
) {
  const [status, setStatus] = useState<DictationStatus>("idle")
  const [levels, setLevels] = useState<number[] | null>(null)
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [transcript, setTranscript] = useState<DictationTranscript>(EMPTY_TRANSCRIPT)
  const session = useRef<TakeSession | null>(null)
  const heard = useRef<DictationTranscript>(EMPTY_TRANSCRIPT)
  const latest = useRef({ config, hint, key, vocabulary })
  useEffect(() => {
    latest.current = { config, hint, key, vocabulary }
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
    // What the take recorded is kept before the mic goes, its tail included: the recorder flushes
    // the last slice on the way out, so the row is written after it.
    void stopRecording(current).then(() => current.keeper.flush())
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
      // Its text is in: nothing is left to keep on the device.
      void current.keeper.drop()
      if (session.current === current) session.current = null
      showIdle()
    },
    [showIdle],
  )

  const start = async (caret?: number | null) => {
    if (session.current || !canRecord()) return
    const current = newTake(latest.current.key, caret ?? undefined)
    session.current = current
    setError(null)
    setLevels(null)
    setStatus("listening")
    show(openingTranscript())

    // The host is asked for a take while the mic is opened, so the model has the whole time the
    // user is speaking to load. The slices wait for it: nothing is sent before the host has a take.
    const asking = new AbortController()
    const cold = window.setTimeout(() => asking.abort(), START_MS)
    current.asking = startDictationTake(
      latest.current.config,
      latest.current.hint,
      latest.current.vocabulary,
      asking.signal,
    )
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
      if (!event.data.size) return
      // The audio is what survives the app: every slice is held, at the pace the keeper writes at.
      keepSlice(current, event.data)
      if (current.closed) return
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
  }

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
      // Discarded: the take leaves nothing on the device.
      void current.keeper.drop()
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

  /**
   * Asks for a take that came back: it is no longer live, so the batch route hears it whole. That
   * is also what a host without streaming would need, so one path serves both.
   */
  const replay = useCallback(
    async (current: TakeSession) => {
      current.failure = null
      setError(null)
      setStatus("transcribing")
      setLevels(null)
      const controller = new AbortController()
      current.upload = controller
      try {
        const text = await keptText(
          latest.current.config,
          current.kept,
          latest.current.hint,
          controller.signal,
        )
        if (session.current !== current || current.upload !== controller) return null
        clear(current)
        return text
      } catch (failure) {
        if (session.current !== current || current.upload !== controller) return null
        fail(current, reason(failure, "Couldn't transcribe the recording."))
        return null
      } finally {
        if (current.upload === controller) current.upload = null
      }
    },
    [clear, fail],
  )

  /** Asks the host for what it heard after a take that couldn't be finished, and returns it. */
  const retry = useCallback(async () => {
    const current = session.current
    if (!current) return null
    if (current.restored) return replay(current)
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
  }, [cancel, clear, fail, replay, show])

  // A take the app was killed in the middle of is offered again, with Retry and Discard: its
  // slices are on the device, and the batch route can still hear them whole.
  useEffect(() => {
    let live = true
    if (key)
      void readKept(key).then((saved) => {
        if (!live || session.current || !saved?.pieces.length || saved.kind !== "stream") return
        const current = newTake(key, saved.caret, saved.pieces)
        current.restored = true
        current.startedAt = saved.at
        session.current = current
        setError(RESTORED)
        setStatus("failed")
      })
    return () => {
      live = false
    }
  }, [key])

  // A take let go before it ends (another chat, the screen closed) keeps what it recorded: the row
  // is written before the host is told to forget the take, so reopening the composer offers it.
  useEffect(
    () => () => {
      const current = session.current
      session.current = null
      if (!current) return
      current.closed = true
      current.upload?.abort()
      current.upload = null
      void stopRecording(current).then(() => current.keeper.flush())
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
    /** Where a take that came back was left, so its text lands where it began. */
    anchor: () => (session.current?.restored ? (session.current.caret ?? null) : null),
    start,
    finish,
    retry,
    cancel,
  }
}
