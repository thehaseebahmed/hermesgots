import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent,
} from "react"

import { DICTATION_INFO_MS } from "@/lib/freshness"
import { createSignal } from "@/lib/store"
import { connectionKey } from "@/lib/connection"
import { db, type DictationPiece } from "@/lib/db"
import { EMPTY_TRANSCRIPT } from "@/lib/dictation-transcript"
import {
  getDictationInfo,
  transcribeClip,
  warmDictation,
  type DictationInfo,
  type HermesConfig,
} from "@/lib/hermes"
import { usePoll } from "@/lib/poll"

const infos = new Map<string, { at: number; info?: DictationInfo }>()
const { subscribe, notify } = createSignal()

const infoKey = connectionKey

async function readDictationInfo(config: HermesConfig, force = false) {
  const key = infoKey(config)
  const hit = infos.get(key)
  if (!force && hit && Date.now() - hit.at < DICTATION_INFO_MS) return
  const info = await getDictationInfo(config).catch(() => undefined)
  // A check that fails keeps the last answer, so the mic doesn't flicker on a bad connection.
  const known = info ?? infos.get(key)?.info
  infos.set(key, { at: Date.now(), info: known })
  notify()
}

export type DictationAvailability =
  | { status: "checking" }
  | { status: "ready" }
  | { status: "off"; reason: string }
  | { status: "failed" }

const CHECKING: DictationAvailability = { status: "checking" }
const READY: DictationAvailability = { status: "ready" }
const FAILED: DictationAvailability = { status: "failed" }
const offs = new Map<string, DictationAvailability>()

function availability(key: string): DictationAvailability {
  const hit = infos.get(key)
  if (!hit) return CHECKING
  if (!hit.info) return FAILED
  if (hit.info.ready) return READY
  const reason = hit.info.reason || "Dictation is off on this bot's host."
  if (!offs.has(reason)) offs.set(reason, { status: "off", reason })
  return offs.get(reason)!
}

/** Whether the bot's host can dictate, and a way to ask it again; null for a bot without a key. */
export function useDictationInfo(config: HermesConfig) {
  const key = config.apiKey && config.baseUrl ? infoKey(config) : ""
  const state = useSyncExternalStore(subscribe, () => availability(key))
  const { baseUrl, apiKey } = config
  usePoll(() => void readDictationInfo({ baseUrl, apiKey }), DICTATION_INFO_MS, [baseUrl, apiKey], {
    active: Boolean(key),
    onShow: false,
  })
  const recheck = useCallback(() => {
    if (key) void readDictationInfo({ baseUrl, apiKey }, true)
  }, [key, baseUrl, apiKey])
  return key ? { ...state, recheck } : null
}

/** The longest recording; at 24 kbps it stays far under the API server's 10 MB body limit. */
export const MAX_MS = 10 * 60 * 1000
const MIN_MS = 300
/** A cold host may load (or first download) its model inside this request. */
const TRANSCRIBE_MS = 120_000
const TYPES = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4", "audio/webm"]
export const BARS = 32
export const SAMPLE_MS = 50
const PIECE_MS = 6000
const PAUSE_MS = 700
const LONG_PIECE_MS = 25_000
const SHORT_PAUSE_MS = 350
// Loudness (RMS of the wave, 0 to 1) under which the mic counts as quiet.
export const QUIET_MIN = 0.012
export const QUIET_MAX = 0.05
const SAVE_MS = 2000
const RESTORED = "This recording hasn't been transcribed yet."
/** A stop event that hasn't come by now isn't coming: the take goes with what it flushed. */
export const STOP_MS = 1500
/** A live track whose recorder has sent nothing by now is a dead one: silence still encodes. */
export const SILENT_MS = 2500
export const STOPPED = "The recording stopped."
export const TAKEN = "The microphone is in use by another app."
export const SILENT = "The microphone isn't picking up any sound."

/** A click from Enter or Space: no pointer made it (a touch's click can also have no detail). */
export function keyboardClick(event: MouseEvent) {
  return event.detail === 0 && !(event.nativeEvent as Partial<PointerEvent>).pointerType
}

export const canRecord = () =>
  typeof window !== "undefined" &&
  typeof window.MediaRecorder === "function" &&
  Boolean(navigator.mediaDevices?.getUserMedia)

export function recordingType() {
  return TYPES.find((type) => MediaRecorder.isTypeSupported?.(type))
}

export function micError(error: unknown, otherwise: string) {
  const name = error instanceof DOMException ? error.name : ""
  if (name === "NotAllowedError" || name === "SecurityError") return "Microphone access is blocked."
  if (name === "NotFoundError") return "No microphone found."
  if (name === "NotReadableError") return TAKEN
  return otherwise
}

export type DictationStatus = "idle" | "listening" | "transcribing" | "failed"

interface Segment {
  recorder: MediaRecorder
  chunks: Blob[]
  startedAt: number
  /** Whether the meter has heard speech in it (always, when there's no meter). */
  heard: boolean
  skip?: boolean
  stopped: Promise<void>
  watch?: number
  /** Turns what the recorder flushed into a phrase, once: a stop, an error and the timeout land here. */
  close: () => void
}

interface Recording {
  stream: MediaStream
  mimeType?: string
  segments: Segment[]
  startedAt: number
  stoppedAt?: number
  measured: boolean
  audio?: AudioContext
  timer?: number
  cap?: number
}

interface Session {
  key?: string
  pieces: DictationPiece[]
  recording: Recording | null
  upload: AbortController | null
  draining: Promise<boolean> | null
  error: unknown
  /** Why the take itself died (the recorder errored, the track ended): Retry still sends its phrases. */
  failure: Error | null
  /** The recorders still closing after the take died; a retry waits for them. */
  stopping: Promise<void> | null
  /** Cancelled or done: nothing more is kept. */
  closed: boolean
  saving: Promise<unknown>
  saveTimer?: number
}

const newSession = (key: string | undefined, pieces: DictationPiece[] = []): Session => ({
  key,
  pieces,
  recording: null,
  upload: null,
  draining: null,
  error: null,
  failure: null,
  stopping: null,
  closed: false,
  saving: Promise.resolve(),
})

export function joinText(...parts: string[]) {
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" ")
}

function save(session: Session, now = false) {
  if (!session.key || session.closed) return
  if (!now) {
    session.saveTimer ??= window.setTimeout(() => save(session, true), SAVE_MS)
    return
  }
  window.clearTimeout(session.saveTimer)
  session.saveTimer = undefined
  const key = session.key
  const live = (session.recording?.segments ?? [])
    .filter((segment) => segment.chunks.length)
    .map((segment) => ({
      blob: new Blob(segment.chunks, { type: segment.recorder.mimeType || "audio/webm" }),
      text: null,
    }))
  const pieces = [...session.pieces.map((piece) => ({ ...piece })), ...live]
  session.saving = session.saving
    .then(async () => {
      if (pieces.length) await db.dictations.put({ id: key, pieces, at: Date.now() })
      else await db.dictations.delete(key)
    })
    .catch(() => undefined)
}

/** A take that ended stops transcribing: whatever is in flight is dropped. */
function stopUpload(current: Session) {
  const upload = current.upload
  current.upload = null
  upload?.abort()
}

function forget(session: Session) {
  session.closed = true
  window.clearTimeout(session.saveTimer)
  const key = session.key
  if (key) session.saving = session.saving.then(() => db.dictations.delete(key)).catch(() => {})
}

function release(recording: Recording) {
  window.clearInterval(recording.timer)
  window.clearTimeout(recording.cap)
  recording.stream.getTracks().forEach((track) => track.stop())
  void recording.audio?.close().catch(() => {})
  recording.timer = undefined
  recording.audio = undefined
}

/** Stops the recorders and lets the mic go; resolves once the last phrase is in. */
async function end(recording: Recording) {
  const stopping = stopSegments(recording)
  release(recording)
  await stopping
}

function stopSegments(recording: Recording) {
  const open = [...recording.segments]
  for (const segment of open) if (segment.recorder.state !== "inactive") segment.recorder.stop()
  recording.stoppedAt ??= Date.now()
  // A recorder that errored fires no stop of its own: close it with the audio it flushed.
  return Promise.all(
    open.map(
      (segment) =>
        new Promise<void>((done) => {
          const timer = window.setTimeout(() => {
            segment.close()
            done()
          }, STOP_MS)
          void segment.stopped.then(() => {
            window.clearTimeout(timer)
            done()
          })
        }),
    ),
  )
}

/**
 * The chunked implementation: a recording cut at the user's pauses, each piece sent once it has
 * ended. Kept as it was for a host that doesn't advertise `dictation_stream`, which is why nothing
 * below here knows about a live transcript — `transcript` is always empty.
 */
export function useChunkedDictation(config: HermesConfig, hint: string, key?: string) {
  const [status, setStatus] = useState<DictationStatus>("idle")
  const [levels, setLevels] = useState<number[] | null>(null)
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const session = useRef<Session | null>(null)
  const latest = useRef({ config, hint, key })
  useEffect(() => {
    latest.current = { config, hint, key }
  })

  const showIdle = useCallback(() => {
    setStatus("idle")
    setLevels(null)
    setStartedAt(null)
    setError(null)
  }, [])

  /** Sends each piece still without text, in order, each after the text before it. */
  const showFailure = useCallback((failure: unknown) => {
    setError(
      failure instanceof DOMException && failure.name === "AbortError"
        ? "The bot took too long to transcribe."
        : failure instanceof Error
          ? failure.message
          : "Couldn't transcribe the recording.",
    )
    setStatus("failed")
  }, [])

  const drain = useCallback((current: Session) => {
    const run = async () => {
      for (;;) {
        const index = current.pieces.findIndex((piece) => piece.text === null)
        if (index < 0) return true
        const piece = current.pieces[index]
        const before = joinText(...current.pieces.slice(0, index).map((done) => done.text ?? ""))
        const controller = new AbortController()
        current.upload = controller
        const timer = window.setTimeout(() => controller.abort(), TRANSCRIBE_MS)
        try {
          const { config, hint } = latest.current
          const text = await transcribeClip(config, piece.blob, hint, before, controller.signal)
          if (current.upload !== controller) return false
          piece.text = text
          current.error = null
        } catch (failure) {
          if (current.upload === controller) current.error = failure
          return false
        } finally {
          window.clearTimeout(timer)
          if (current.upload === controller) current.upload = null
        }
        save(current, true)
      }
    }
    if (!current.draining) {
      const draining: Promise<boolean> = run().finally(() => {
        if (current.draining === draining) current.draining = null
      })
      current.draining = draining
    }
    return current.draining
  }, [])

  /** Ends a take whose recorder died, keeping the phrases already cut so Retry can send them. */
  const fail = useCallback(
    (current: Session, recording: Recording, message: string) => {
      if (session.current !== current || current.recording !== recording || current.stopping) return
      current.failure = new Error(message)
      current.recording = null
      current.stopping = end(recording)
      stopUpload(current)
      setLevels(null)
      showFailure(current.failure)
    },
    [showFailure],
  )

  const openSegment = useCallback(
    (current: Session, recording: Recording) => {
      const recorder = new MediaRecorder(recording.stream, {
        mimeType: recording.mimeType,
        audioBitsPerSecond: 24_000,
      })
      let stopped!: () => void
      // A stop, an error and the stop timeout can all land, and only one may make the segment a piece.
      let closed = false
      const close = () => {
        if (closed) return
        closed = true
        window.clearTimeout(segment.watch)
        recording.segments = recording.segments.filter((open) => open !== segment)
        if (segment.chunks.length && !segment.skip) {
          const type = recorder.mimeType || recording.mimeType || "audio/webm"
          current.pieces.push({ blob: new Blob(segment.chunks, { type }), text: null })
        }
        save(current, true)
        // A take that died waits for Retry instead, so its failure stays the bar's one message.
        if (session.current === current && !current.failure) void drain(current)
        stopped()
      }
      const segment: Segment = {
        recorder,
        chunks: [],
        startedAt: Date.now(),
        heard: !recording.measured,
        stopped: new Promise((resolve) => (stopped = resolve)),
        close,
      }
      recorder.ondataavailable = (event) => {
        if (!event.data.size) return
        window.clearTimeout(segment.watch)
        segment.chunks.push(event.data)
        save(current)
      }
      recorder.onstop = close
      recorder.onerror = (event) => {
        fail(current, recording, micError((event as Event & { error?: unknown }).error, STOPPED))
        close()
      }
      recording.segments.push(segment)
      recorder.start(1000)
      // A recorder that has sent nothing by now is dead, not quiet: silence still encodes.
      segment.watch = window.setTimeout(() => {
        if (!segment.chunks.length) fail(current, recording, SILENT)
      }, SILENT_MS)
      return segment
    },
    [drain, fail],
  )

  const monitor = useCallback(
    (current: Session, recording: Recording) => {
      try {
        const audio = new AudioContext()
        void audio.resume().catch(() => {})
        const analyser = audio.createAnalyser()
        analyser.fftSize = 512
        audio.createMediaStreamSource(recording.stream).connect(analyser)
        recording.audio = audio
        recording.measured = true
        const motion = !window.matchMedia("(prefers-reduced-motion: reduce)").matches
        const samples = new Uint8Array(analyser.fftSize)
        let history = Array<number>(BARS).fill(0)
        let floor = Infinity
        let quietSince: number | null = null
        recording.timer = window.setInterval(() => {
          analyser.getByteTimeDomainData(samples)
          let sum = 0
          for (const sample of samples) sum += ((sample - 128) / 128) ** 2
          const loudness = Math.sqrt(sum / samples.length)
          // The quietest the room gets, creeping up slowly so a noisier room is learnt.
          floor = loudness < floor ? loudness : floor + (loudness - floor) * 0.002
          const quiet = loudness < Math.min(Math.max(QUIET_MIN, floor * 2.5), QUIET_MAX)
          const now = Date.now()
          const segment = recording.segments.at(-1)
          if (!quiet) quietSince = null
          else quietSince ??= now
          if (segment && !quiet) segment.heard = true
          if (segment?.heard && quietSince !== null && segment.recorder.state === "recording") {
            const length = now - segment.startedAt
            const pause = now - quietSince
            if (
              (length >= PIECE_MS && pause >= PAUSE_MS) ||
              (length >= LONG_PIECE_MS && pause >= SHORT_PAUSE_MS)
            ) {
              openSegment(current, recording)
              segment.recorder.stop()
            }
          }
          if (motion && session.current === current) {
            history = [...history.slice(1), Math.min(1, loudness * 5)]
            setLevels(history)
          }
        }, SAMPLE_MS)
      } catch {
        // Without a meter the recording goes whole, as one piece.
      }
    },
    [openSegment],
  )

  const start = useCallback(async () => {
    if (session.current || !canRecord()) return
    const current = newSession(latest.current.key)
    session.current = current
    setError(null)
    setStatus("listening")
    void warmDictation(latest.current.config).catch(() => {})
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
    const recording: Recording = {
      stream,
      mimeType: recordingType(),
      segments: [],
      startedAt: Date.now(),
      measured: false,
    }
    current.recording = recording
    monitor(current, recording)
    openSegment(current, recording)
    // Another app taking the mic, or the device revoking it, ends the track under the recorder.
    stream
      .getAudioTracks()
      .forEach((track) => track.addEventListener("ended", () => fail(current, recording, TAKEN)))
    setStartedAt(recording.startedAt)
    // Past the cap the recording stops growing; Stop or Send still turns it into text.
    recording.cap = window.setTimeout(() => {
      void end(recording)
      if (session.current === current) setLevels(null)
    }, MAX_MS)
  }, [fail, monitor, openSegment, showIdle])

  /** Waits for every piece's text: the whole of it, or null with the recording kept for `retry`. */
  const settle = useCallback(
    async (current: Session) => {
      setStatus("transcribing")
      setLevels(null)
      setError(null)
      if (current.stopping) await current.stopping
      const done = await drain(current)
      if (session.current !== current) return null
      if (done) {
        forget(current)
        session.current = null
        showIdle()
        return joinText(...current.pieces.map((piece) => piece.text ?? ""))
      }
      showFailure(current.error ?? current.failure)
      // The host may have lost faster-whisper since; ask again so the mic hides if so.
      void readDictationInfo(latest.current.config, true)
      return null
    },
    [drain, showFailure, showIdle],
  )

  const cancel = useCallback(() => {
    const current = session.current
    session.current = null
    if (current) {
      forget(current)
      stopUpload(current)
      if (current.recording) void end(current.recording)
    }
    showIdle()
  }, [showIdle])

  /**
   * Ends the recording and returns its text: `""` for a recording too short to hold speech, null
   * when the host couldn't transcribe it (it's kept for `retry`).
   */
  const finish = useCallback(async () => {
    const current = session.current
    // Nothing to end: no take, or one that died before Stop with nothing left to send.
    if (!current || (!current.recording && !current.failure)) {
      cancel()
      return ""
    }
    // A take that died before Stop (the recorder errored, the track ended) still sends what it recorded.
    if (!current.recording) return settle(current)
    const recording = current.recording
    const last = recording.segments.at(-1)
    if (last && current.pieces.length && Date.now() - last.startedAt < MIN_MS) last.skip = true
    const stopping = end(recording)
    current.stopping = stopping
    await stopping
    if (session.current !== current) return null
    current.recording = null
    const length = (recording.stoppedAt ?? Date.now()) - recording.startedAt
    if (length < MIN_MS || !current.pieces.length) {
      cancel()
      return ""
    }
    return settle(current)
  }, [cancel, settle])

  const retry = useCallback(async () => {
    const current = session.current
    if (!current) return null
    // A take that recorded nothing has nothing to send: it is dropped, as Discard would.
    if (!current.pieces.length) {
      cancel()
      return ""
    }
    return settle(current)
  }, [cancel, settle])

  // A recording left unfinished (another chat, the screen closed) is kept for when it's back.
  useEffect(() => {
    let live = true
    if (key)
      void db.dictations
        .get(key)
        .catch(() => undefined)
        .then((saved) => {
          if (!live || session.current || !saved?.pieces.length) return
          session.current = newSession(key, saved.pieces)
          setError(RESTORED)
          setStatus("failed")
        })
    return () => {
      live = false
      const current = session.current
      session.current = null
      if (!current) return
      current.upload?.abort()
      current.upload = null
      const recording = current.recording
      if (recording) {
        void end(recording).then(() => {
          current.recording = null
          save(current, true)
        })
      }
      showIdle()
    }
  }, [key, showIdle])

  return {
    status,
    levels,
    startedAt,
    error,
    transcript: EMPTY_TRANSCRIPT,
    /** When the recorder started, for a hold that ends before the mic was granted. */
    recordingSince: () => session.current?.recording?.startedAt ?? null,
    start,
    finish,
    retry,
    cancel,
  }
}
