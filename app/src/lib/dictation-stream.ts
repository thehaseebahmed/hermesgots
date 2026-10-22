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

/** The slice a recording is flushed in: the app sends each one as it is produced. */
const SLICE_MS = 250
/** Quiet this long after speech is a pause; the slice that lands in one closes the phrase. */
const PHRASE_PAUSE_MS = 700
/** A cold host loads, or first downloads, its model inside the start call, as a clip did. */
const START_MS = 120_000
const CANCEL_MS = 5_000

interface Slice {
  blob: Blob
  pause: boolean
}

interface TakeSession {
  /** The profile this take holds: one take at a time is one per profile. */
  profile: string
  /** The profile's microphone, held from the start of the take to its end. */
  lock: symbol | null
  /** The composer's draft key: the take's audio is kept on the device under it. */
  key?: string
  /** Where the caret was when the take began, so a kept take lands where it was left. */
  caret?: number
  /** The host's take, once it has answered; null while a cold host is still loading its model. */
  take: string | null
  /** Resolves when the take opened or failed, so Stop can wait for a cold host instead of losing it. */
  asking: Promise<void>
  /** The tail's request, so a Cancel during it drops the answer rather than reading it. */
  ending: AbortController | null
  /** The ending in flight: a second Stop (or a Send behind one) does nothing more. */
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
  /** Whether its audio still belongs on the device: no once its text is in, or it was let go. */
  keeping: boolean
  /** Why the take ended when it wasn't the user who ended it. */
  failure: DictationFailure | null
  /** Whether the words it had committed were already handed to the composer, so once only. */
  handed: boolean
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

/** Holds a slice of the take for the device, written at the pace the keeper writes at. */
function keepSlice(current: TakeSession, blob: Blob) {
  current.kept.push({ blob, text: null })
  void current.keeper.keep({ pieces: [...current.kept], caret: current.caret })
}

/** Whether the host no longer has this take: it expired, was cancelled, or never existed. */
function ended(failure: unknown) {
  return failure instanceof HermesError && (failure.status === 404 || failure.status === 410)
}

/** Whether an ending's answer is one to abandon on rather than to keep the take for: the wait ran
 * out, or the host no longer has the take at all. */
function abandoned(failure: unknown) {
  return (failure instanceof DOMException && failure.name === "AbortError") || ended(failure)
}

type Tail = { answer: DictationAnswer } | { failed: unknown } | null

/**
 * The tail's answer, the reason it failed, or null when the wait ran out. The request is raced
 * rather than merely aborted, so the bound holds even on a host that never answers and a transport
 * that never gives up on a dead connection.
 */
function tailWithin(asking: Promise<DictationAnswer>, ms: number): Promise<Tail> {
  return Promise.race([
    asking.then(
      (answer): Tail => ({ answer }),
      (failed): Tail => ({ failed }),
    ),
    new Promise<null>((done) => window.setTimeout(done, Math.max(1, ms))),
  ])
}

/** Gives the profile's microphone back: every path that ends a take comes through here once. */
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

/** A dictation the bot's host hears as it is spoken, one slice at a time. */
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

  /**
   * Ends a take that can't go on. What the host already committed goes to the composer before the
   * bar changes, so a failure never takes back the words the user has read; the rest of the take is
   * let go — microphone, the host's take and the audio on the device — so nothing is left held.
   * Retry afterwards is a fresh take from the same place.
   */
  const fail = useCallback((current: TakeSession, failed: DictationFailure) => {
    if (session.current !== current || current.failure) return
    current.failure = failed
    current.closed = true
    current.upload?.abort()
    current.upload = null
    // A tail being waited for is let go too: a failed take inserts nothing more.
    current.ending?.abort()
    current.ending = null
    // A take that died is over as far as the microphone goes, Retry or not.
    letGo(current)
    const committed = transcriptText(heard.current)
    if (committed && !current.handed) {
      current.handed = true
      latest.current.onCommitted?.(committed)
    }
    // The host is told to forget the take: nothing of it is waited for any more.
    const take = current.take
    current.take = null
    if (take)
      void cancelDictationTake(latest.current.config, take, AbortSignal.timeout(CANCEL_MS)).catch(
        () => undefined,
      )
    // Its audio goes too: the words it heard are in the composer, and the rest is not wanted.
    void stopRecording(current).then(() => current.keeper.drop())
    release(current)
    setLevels(null)
    setFailure(failed)
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
            // A slice the host refused, or a take it has let go, ends the take: the words it
            // already committed stay, and the bar says what happened rather than going quiet.
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

  /** Ends a take whose text is in: the mic goes, its kept audio goes, and the bar gives way. */
  const clear = useCallback(
    (current: TakeSession) => {
      current.closed = true
      current.upload?.abort()
      current.upload = null
      // A tail being waited for is dropped: its answer must not arrive as words after the end.
      current.ending?.abort()
      current.ending = null
      letGo(current)
      release(current)
      // Its text is in: nothing is left to keep on the device.
      void current.keeper.drop()
      if (session.current === current) session.current = null
      showIdle()
    },
    [showIdle],
  )

  /**
   * Lets a take go with what it already has: the host forgets it rather than decoding a tail nobody
   * is waiting for, nothing is kept on the device, and the words committed so far are the take.
   */
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
    // One take at a time per profile: the host hears one, and the microphone belongs to it.
    if (!lock) throw new Error(TAKE_RUNNING)
    const current = newTake(profile, latest.current.key, caret ?? undefined)
    current.lock = lock
    session.current = current
    setFailure(null)
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
        if (session.current !== current) {
          // The host opened the take after the user let it go — a Cancel while the start was in
          // flight: it is told to forget the take rather than hold it until it expires.
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
        // A refused take, or a model that didn't load, ends here: the bar says which rather than
        // sitting on "Preparing…" while the user talks to nothing.
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
    // Cancelled, or failed, while the mic was asked for: the stream is not this take's to keep.
    if (session.current !== current || current.failure) {
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
    recorder.onerror = (event) => {
      const error = (event as Event & { error?: unknown }).error
      fail(current, microphoneFailure(micError(error, STOPPED), blockedMicrophone(error)))
    }
    // A recorder that has sent nothing by now is dead, not quiet: silence still encodes.
    current.watch = window.setTimeout(() => {
      if (!current.slices) fail(current, microphoneFailure(SILENT))
    }, SILENT_MS)
    recorder.start(SLICE_MS)
    // Another app taking the mic, or the device revoking it, ends the track under the recorder.
    stream
      .getAudioTracks()
      .forEach((track) => track.addEventListener("ended", () => fail(current, microphoneFailure(TAKEN))))
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
      // A second Stop, or a Send behind one, while the take is ending does nothing more.
      if (current.finishing) return current.finishing
      const run = (async () => {
        const deadline = Date.now() + waitMs
        const left = () => Math.max(0, deadline - Date.now())
        // Stop waits for a cold host to open the take, so what was said while it loaded isn't lost.
        await current.asking.catch(() => undefined)
        // A take that failed while it waited (a refused start, a model that didn't load) has
        // already ended: its words are in the composer and the bar holds the reason.
        if (session.current !== current || current.failure) return null
        setStatus("transcribing")
        setLevels(null)
        setFailure(null)
        await stopRecording(current)
        if (session.current !== current || current.failure) return null
        // Everything still queued is sent before the tail is asked for, inside what is left of it.
        await within(pump(current), left())
        if (session.current !== current || current.failure) return null
        const take = current.take
        if (!take) {
          // The host let the take go before Stop: what it already committed is still what was said.
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
          // Cancelled, or let go, while the tail was asked for: its answer inserts nothing.
          if (session.current !== current) return null
          if (!tail) {
            // The wait is up: what the host already committed is the take, and the host is told to
            // stop decoding the tail nobody is waiting for.
            const text = transcriptText(heard.current)
            abandon(current)
            return text
          }
          if ("failed" in tail) {
            if (abandoned(tail.failed)) {
              // The host no longer has the take: what it committed is still what was said.
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
      // A tail being waited for is let go too: a take cancelled inserts nothing, even if the host
      // answers the stop it was already asked for.
      current.ending?.abort()
      current.ending = null
      letGo(current)
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

  /**
   * A failed take has ended — its words are in the composer and its audio is gone — so Retry is a
   * fresh take from the same place, not a second attempt at one nothing is holding. A take the app
   * was killed in the middle of is a recording on the device instead, and is asked for whole.
   */
  const retry = async () => {
    const current = session.current
    if (!current || !current.failure) return null
    if (current.restored) return replay(current)
    const caret = current.caret
    cancel()
    await start(caret)
    return null
  }

  // A take the app was killed in the middle of is offered again, with Retry and Discard: its
  // slices are on the device, and the batch route can still hear them whole.
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
      current.ending?.abort()
      current.ending = null
      // A take let go keeps its microphone no longer than it keeps its audio.
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
