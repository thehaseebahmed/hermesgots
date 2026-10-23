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

import { connectionKey } from "@/lib/connection"
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
  STOP_WAIT_MS,
  TAKEN,
  TAKE_RUNNING,
  canRecord,
  keptKeeper,
  keptText,
  micError,
  readKept,
  recordingType,
  within,
  type DictationStatus,
} from "@/lib/dictation"
import {
  blockedMicrophone,
  clipFailure,
  failure as failureOf,
  microphoneFailure,
  startFailure,
  takeFailure,
  type DictationFailure,
} from "@/lib/dictation-failure"
import { RESTORED, type Keeper } from "@/lib/dictation-kept"
import { holdTake, releaseTake } from "@/lib/dictation-lock"
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

const SLICE_MS = 250
const PHRASE_PAUSE_MS = 700
const START_MS = 120_000
const CANCEL_MS = 5_000

interface Slice {
  blob: Blob
  pause: boolean
}

interface TakeSession {
  profile: string
  lock: symbol | null
  key?: string
  caret?: number
  take: string | null
  asking: Promise<void>
  ending: AbortController | null
  finishing: Promise<string | null> | null
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
  keeping: boolean
  failure: DictationFailure | null
  handed: boolean
  kept: DictationPiece[]
  keeper: Keeper
  restored: boolean
  heard: boolean
  quietSince: number | null
  pauseNext: boolean
  pauseMarked: boolean
  startedAt: number
}

function newTake(
  profile: string,
  key: string | undefined,
  caret?: number,
  kept: DictationPiece[] = [],
): TakeSession {
  return {
    profile,
    lock: null,
    key,
    caret,
    take: null,
    asking: Promise.resolve(),
    ending: null,
    finishing: null,
    stream: null,
    recorder: null,
    slices: 0,
    queue: [],
    running: null,
    upload: null,
    closed: false,
    keeping: true,
    failure: null,
    handed: false,
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

function keepSlice(current: TakeSession, blob: Blob) {
  current.kept.push({ blob, text: null })
  void current.keeper.keep({ pieces: [...current.kept], caret: current.caret })
}

function ended(failure: unknown) {
  return failure instanceof HermesError && (failure.status === 404 || failure.status === 410)
}

function abandoned(failure: unknown) {
  return (failure instanceof DOMException && failure.name === "AbortError") || ended(failure)
}

type Tail = { answer: DictationAnswer } | { failed: unknown } | null

function tailWithin(asking: Promise<DictationAnswer>, ms: number): Promise<Tail> {
  return Promise.race([
    asking.then(
      (answer): Tail => ({ answer }),
      (failed): Tail => ({ failed }),
    ),
    new Promise<null>((done) => window.setTimeout(done, Math.max(1, ms))),
  ])
}

function letGo(current: TakeSession) {
  releaseTake(current.profile, current.lock)
  current.lock = null
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

export function useStreamDictation(
  config: HermesConfig,
  hint: string,
  key?: string,
  vocabulary: string[] = [],
  onCommitted?: (text: string) => void,
) {
  const [status, setStatus] = useState<DictationStatus>("idle")
  const [levels, setLevels] = useState<number[] | null>(null)
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [failure, setFailure] = useState<DictationFailure | null>(null)
  const [transcript, setTranscript] = useState<DictationTranscript>(EMPTY_TRANSCRIPT)
  const session = useRef<TakeSession | null>(null)
  const heard = useRef<DictationTranscript>(EMPTY_TRANSCRIPT)
  const latest = useRef({ config, hint, key, vocabulary, onCommitted })
  useEffect(() => {
    latest.current = { config, hint, key, vocabulary, onCommitted }
  })

  const show = useCallback((next: DictationTranscript) => {
    heard.current = next
    setTranscript(next)
  }, [])

  const showIdle = useCallback(() => {
    setStatus("idle")
    setLevels(null)
    setStartedAt(null)
    setFailure(null)
    show(EMPTY_TRANSCRIPT)
  }, [show])

  const fail = useCallback((current: TakeSession, failed: DictationFailure) => {
    if (session.current !== current || current.failure) return
    current.failure = failed
    current.closed = true
    current.upload?.abort()
    current.upload = null
    current.ending?.abort()
    current.ending = null
    letGo(current)
    const committed = transcriptText(heard.current)
    if (committed && !current.handed) {
      current.handed = true
      latest.current.onCommitted?.(committed)
    }
    const take = current.take
    current.take = null
    if (take)
      void cancelDictationTake(latest.current.config, take, AbortSignal.timeout(CANCEL_MS)).catch(
        () => undefined,
      )
    if (!current.restored) void stopRecording(current).then(() => current.keeper.drop())
    release(current)
    setLevels(null)
    setFailure(failed)
    setStatus("failed")
  }, [])

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
            fail(current, takeFailure(failure, "host"))
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
      current.ending?.abort()
      current.ending = null
      letGo(current)
      release(current)
      void current.keeper.drop()
      if (session.current === current) session.current = null
      showIdle()
    },
    [showIdle],
  )

  const abandon = useCallback(
    (current: TakeSession) => {
      const take = current.take
      current.take = null
      clear(current)
      if (take)
        void cancelDictationTake(latest.current.config, take, AbortSignal.timeout(CANCEL_MS)).catch(
          () => undefined,
        )
    },
    [clear],
  )

  const start = async (caret?: number | null) => {
    if (session.current || !canRecord()) return
    const profile = connectionKey(latest.current.config)
    const lock = holdTake(profile)
    if (!lock) throw new Error(TAKE_RUNNING)
    const current = newTake(profile, latest.current.key, caret ?? undefined)
    current.lock = lock
    session.current = current
    setFailure(null)
    setLevels(null)
    setStatus("listening")
    show(openingTranscript())

    const asking = new AbortController()
    const cold = window.setTimeout(() => asking.abort(), START_MS)
    current.asking = startDictationTake(
      latest.current.config,
      latest.current.hint,
      latest.current.vocabulary,
      asking.signal,
    )
      .then((opened) => {
        if (session.current !== current) {
          void cancelDictationTake(
            latest.current.config,
            opened.take,
            AbortSignal.timeout(CANCEL_MS),
          ).catch(() => undefined)
          return
        }
        current.take = opened.take
        show(settled(heard.current))
        void pump(current)
      })
      .catch((failure) => {
        if (session.current !== current) return
        fail(current, startFailure(failure))
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
      letGo(current)
      throw new Error(micError(failure, "Couldn't start the microphone."))
    }
    if (session.current !== current || current.failure) {
      stream.getTracks().forEach((track) => track.stop())
      return
    }

    let recorder: MediaRecorder
    try {
      recorder = new MediaRecorder(stream, {
        mimeType: recordingType(),
        audioBitsPerSecond: 24_000,
      })
      current.stream = stream
      current.recorder = recorder
      recorder.ondataavailable = (event) => {
        if (!event.data.size) return
        keepSlice(current, event.data)
        if (current.closed) return
        window.clearTimeout(current.watch)
        current.slices += 1
        current.queue.push({ blob: event.data, pause: current.pauseNext })
        current.pauseNext = false
        void pump(current)
      }
      recorder.onerror = (event) => {
        const error = (event as Event & { error?: unknown }).error
        fail(current, microphoneFailure(micError(error, STOPPED), blockedMicrophone(error)))
      }
      current.watch = window.setTimeout(() => {
        if (!current.slices) fail(current, microphoneFailure(SILENT))
      }, SILENT_MS)
      recorder.start(SLICE_MS)
    } catch (error) {
      stream.getTracks().forEach((track) => track.stop())
      fail(current, microphoneFailure(micError(error, STOPPED), blockedMicrophone(error)))
      return
    }
    stream
      .getAudioTracks()
      .forEach((track) => track.addEventListener("ended", () => fail(current, microphoneFailure(TAKEN))))
    setStartedAt(current.startedAt)
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
        floor = loudness < floor ? loudness : floor + (loudness - floor) * 0.002
        const quiet = loudness < Math.min(Math.max(QUIET_MIN, floor * 2.5), QUIET_MAX)
        const now = Date.now()
        if (!quiet) {
          current.quietSince = null
          current.heard = true
          current.pauseMarked = false
        } else {
          current.quietSince ??= now
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
    }
  }

  /**
   * Ends the take and returns what was heard: `""` when there's nothing to put in the field, null
   * when the take ended under us and nothing should be inserted.
   *
   * `waitMs` is how long the tail is waited for — a Send waits short, a Stop longer (ADR 0016) —
   * and it covers the slices still queued as well as the tail phrase itself. A tail that misses it
   * is abandoned rather than waited on: the words the host already committed are the take, so what
   * the user saw in the bar is what lands, none of it lost and none of it twice.
   */
  const finish = useCallback(
    (waitMs = STOP_WAIT_MS) => {
      const current = session.current
      if (!current) return Promise.resolve("")
      if (current.finishing) return current.finishing
      const run = (async () => {
        await current.asking.catch(() => undefined)
        const deadline = Date.now() + waitMs
        const left = () => Math.max(0, deadline - Date.now())
        if (session.current !== current || current.failure) return null
        setStatus("transcribing")
        setLevels(null)
        setFailure(null)
        await stopRecording(current)
        if (session.current !== current || current.failure) return null
        await within(pump(current), left())
        if (session.current !== current || current.failure) return null
        const take = current.take
        if (!take) {
          const text = transcriptText(heard.current)
          clear(current)
          return text
        }
        const controller = new AbortController()
        current.ending = controller
        const timer = window.setTimeout(() => controller.abort(), Math.max(1, left()))
        try {
          const tail = await tailWithin(
            stopDictationTake(latest.current.config, take, controller.signal),
            left(),
          )
          if (session.current !== current) return null
          if (!tail) {
            const text = transcriptText(heard.current)
            abandon(current)
            return text
          }
          if ("failed" in tail) {
            if (abandoned(tail.failed)) {
              const text = transcriptText(heard.current)
              abandon(current)
              return text
            }
            fail(current, takeFailure(tail.failed, "host"))
            return null
          }
          const final = hear(heard.current, tail.answer)
          show(final)
          const text = transcriptText(final)
          clear(current)
          return text
        } finally {
          window.clearTimeout(timer)
          if (current.ending === controller) current.ending = null
        }
      })()
      current.finishing = run
      const ended = () => {
        if (current.finishing === run) current.finishing = null
      }
      void run.then(ended, ended)
      return run
    },
    [abandon, clear, fail, pump, show],
  )

  const cancel = useCallback(() => {
    const current = session.current
    session.current = null
    if (current) {
      current.closed = true
      current.upload?.abort()
      current.upload = null
      current.ending?.abort()
      current.ending = null
      letGo(current)
      void stopRecording(current)
      release(current)
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

  const replay = useCallback(
    async (current: TakeSession) => {
      current.failure = null
      setFailure(null)
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
        fail(current, clipFailure(failure))
        return null
      } finally {
        if (current.upload === controller) current.upload = null
      }
    },
    [clear, fail],
  )

  const retry = async () => {
    const current = session.current
    if (!current || !current.failure) return null
    if (current.restored) return replay(current)
    const caret = current.caret
    cancel()
    await start(caret)
    return null
  }

  useEffect(() => {
    let live = true
    if (key)
      void readKept(key).then((saved) => {
        if (!live || session.current || !saved?.pieces.length || saved.kind !== "stream") return
        const current = newTake(
          connectionKey(latest.current.config),
          key,
          saved.caret,
          saved.pieces,
        )
        current.restored = true
        current.startedAt = saved.at
        current.failure = failureOf("clip", RESTORED, { discard: true })
        session.current = current
        setFailure(current.failure)
        setStatus("failed")
      })
    return () => {
      live = false
    }
  }, [key])

  useEffect(
    () => () => {
      const current = session.current
      session.current = null
      if (!current) return
      current.closed = true
      current.upload?.abort()
      current.upload = null
      current.ending?.abort()
      current.ending = null
      letGo(current)
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
    failure,
    transcript,
    recordingSince: () => session.current?.startedAt ?? null,
    anchor: () => (session.current?.restored ? (session.current.caret ?? null) : null),
    start,
    finish,
    retry,
    cancel,
  }
}
