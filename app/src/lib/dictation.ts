import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent,
} from "react"

import { DICTATION_INFO_MS } from "@/lib/freshness"
import { within } from "@/lib/within"
import { createSignal } from "@/lib/store"
import { connectionKey } from "@/lib/connection"
import { db, type DictationPiece, type SavedDictation } from "@/lib/db"
import {
  blockedMicrophone,
  clipFailure,
  failure as failureOf,
  microphoneFailure,
  tookTooLong,
  type DictationFailure,
} from "@/lib/dictation-failure"
import { RESTORED, SAVE_MS } from "@/lib/dictation-kept"
import { holdTake, releaseTake } from "@/lib/dictation-lock"
import { prefersReducedMotion } from "@/lib/media"
import {
  MissingPieces,
  cancelDictation,
  confirmDictation,
  getDictationInfo,
  uploadPiece,
  warmDictation,
  type ConfirmedTake,
  type DictationInfo,
  type HermesConfig,
} from "@/lib/hermes"
import { usePoll } from "@/lib/poll"
import { quietly } from "@/lib/report"
import { randomId } from "@/lib/utils"
import { MIN_PLUGIN_VERSION } from "@/lib/version"

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
  const reason = hit.info.reason || "Speech-to-text is off on this bot's host."
  if (!offs.has(reason)) offs.set(reason, { status: "off", reason })
  return offs.get(reason)!
}

/** A bot's host sends a take to a cloud provider, from the last `info` read. */
function leavesHost(key: string): boolean {
  return infos.get(key)?.info?.provider?.cloud === true
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
/** One hung Upload must not hold the take: the bound the host stated covers the rest (ADR 0074). */
const UPLOAD_MS = 60_000
const UPLOAD_TRIES = 3
const RETRY_MS = 400
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
/** A stop event that hasn't come by now isn't coming: the take goes with what it flushed. */
export const STOP_MS = 1500
export const DICTATION = "dictation"

/** A host that cannot say how long its Confirm takes cannot be held to a bar: it is too old to hear a take. */
const OUTDATED = `This bot's Gots plugin is too old to hear a take. Update it to ${MIN_PLUGIN_VERSION} or newer.`
export const SILENT_MS = 2500
export const STOPPED = "The recording stopped."
export const TAKEN = "The microphone is in use by another app."
export const SILENT = "The microphone isn't picking up any sound."
export const TAKE_RUNNING = "A speech-to-text take is already being heard on this bot."

/** A wait that ran out, told apart from an answer: a Confirm past its bound is a failed take. */
const TIMED_OUT = Symbol("timed out")

/** A Confirm given at most `ms`; a rejection is the host's own, and only the wait running out is ours. */
async function bounded<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: number | undefined
  const wait = new Promise<typeof TIMED_OUT>((done) => {
    timer = window.setTimeout(() => done(TIMED_OUT), ms)
  })
  try {
    return await Promise.race([promise, wait])
  } finally {
    window.clearTimeout(timer)
  }
}

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

/** The take, once it is final: what landed, how long it took to say, and what tidied it. */
export type Committed = (take: ConfirmedTake) => void

interface Segment {
  recorder: MediaRecorder
  chunks: Blob[]
  startedAt: number
  /** Whether the meter has heard speech in it (always, when there's no meter). */
  heard: boolean
  skip?: boolean
  stopped: Promise<void>
  watch?: number
  /** Turns what the recorder flushed into a Piece, once: a stop, an error and the timeout land here. */
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
  profile: string
  lock: symbol | null
  key?: string
  /** The app's Take id, minted when the recording starts and replaced whenever a Retry begins. */
  take: string
  pieces: DictationPiece[]
  caret?: number
  recording: Recording | null
  /** The Uploads in flight, one Piece after another; true when every Piece the take holds is up. */
  uploading: Promise<boolean> | null
  /** The indexes the host has taken, so a Retry and a 409's re-send know what is left. */
  sent: Set<number>
  inflight: AbortController | null
  /** The Confirm in flight: a slot of its own, so an Upload can never clobber it or the other way. */
  asking: AbortController | null
  finishing: Promise<string | null> | null
  error: unknown
  /** Why the take itself died (the recorder errored, the track ended): Retry still sends its Pieces. */
  failure: DictationFailure | null
  /** The recorders still closing after the take died; a retry waits for them. */
  stopping: Promise<void> | null
  /** Cancelled or done: nothing more is kept. */
  closed: boolean
  saving: Promise<unknown>
  saveTimer?: number
}

const newSession = (
  profile: string,
  key: string | undefined,
  pieces: DictationPiece[] = [],
  caret?: number,
): Session => ({
  profile,
  lock: null,
  key,
  take: randomId(),
  pieces,
  caret,
  recording: null,
  uploading: null,
  sent: new Set(),
  inflight: null,
  asking: null,
  finishing: null,
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
    }))
  // A take keeps its audio, never its words: the words exist on the host until the take is answered.
  const pieces = [...session.pieces, ...live]
  session.saving = session.saving
    .then(async () => {
      if (pieces.length)
        await db.dictations.put({
          id: key,
          pieces,
          at: Date.now(),
          kind: "pieces",
          caret: session.caret,
        })
      else await db.dictations.delete(key)
    })
    .catch(() => undefined)
}

export async function readKept(key: string): Promise<SavedDictation | undefined> {
  return db.dictations.get(key).catch(() => undefined)
}

/** The bound the bar holds to, as the bot's own host states it; null on a plugin too old to say. */
function boundOf(profile: string): number | null {
  const wait = infos.get(profile)?.info?.wait_ms
  return typeof wait === "number" && wait > 0 ? wait : null
}

function stopInflight(current: Session) {
  const inflight = current.inflight
  const asking = current.asking
  current.inflight = null
  current.asking = null
  inflight?.abort()
  asking?.abort()
}

function forget(session: Session) {
  session.closed = true
  window.clearTimeout(session.saveTimer)
  releaseTake(session.profile, session.lock)
  session.lock = null
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

/** Stops the recorders and lets the mic go; resolves once the last Piece is in. */
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

/** One Piece, tried twice more before the take gives up on it (ADR 0074). */
async function sendPiece(
  config: HermesConfig,
  take: string,
  index: number,
  piece: DictationPiece,
  hint: string,
  vocabulary: string[],
  signal: AbortSignal,
) {
  for (let attempt = 1; ; attempt++) {
    try {
      await uploadPiece(config, take, index, piece.blob, {
        hint,
        vocabulary,
        ms: piece.ms ?? 0,
        signal,
      })
      return
    } catch (error) {
      if (signal.aborted || attempt >= UPLOAD_TRIES) throw error
      await new Promise((done) => window.setTimeout(done, RETRY_MS * attempt))
    }
  }
}

export function useChunkedDictation(
  config: HermesConfig,
  hint: string,
  key?: string,
  vocabulary: string[] = [],
  /** The take's words, once they are final, with what tidied them (ADR 0062, ADR 0074). */
  onCommitted?: Committed,
) {
  const [status, setStatus] = useState<DictationStatus>("idle")
  const [levels, setLevels] = useState<number[] | null>(null)
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [failure, setFailure] = useState<DictationFailure | null>(null)
  const session = useRef<Session | null>(null)
  const latest = useRef({ config, hint, key, vocabulary, onCommitted })
  useEffect(() => {
    latest.current = { config, hint, key, vocabulary, onCommitted }
  })

  const showIdle = useCallback(() => {
    setStatus("idle")
    setLevels(null)
    setStartedAt(null)
    setFailure(null)
  }, [])

  const showFailure = useCallback((failed: DictationFailure) => {
    setFailure(failed)
    setStatus("failed")
  }, [])

  /** Sends every Piece the host has not taken yet, one after another, off the recording's path. */
  const push = useCallback((current: Session): Promise<boolean> => {
    if (current.uploading) return current.uploading
    const run = (async () => {
      for (;;) {
        if (current.closed) return false
        const index = current.pieces.findIndex((_, at) => !current.sent.has(at))
        if (index < 0) return true
        const controller = new AbortController()
        current.inflight = controller
        const timer = window.setTimeout(() => controller.abort(), UPLOAD_MS)
        try {
          const { config, hint, vocabulary } = latest.current
          await sendPiece(
            config,
            current.take,
            index,
            current.pieces[index],
            hint,
            vocabulary,
            controller.signal,
          )
          if (current.inflight !== controller) return false
          current.sent.add(index)
          current.error = null
          save(current)
        } catch (error) {
          if (current.inflight === controller) current.error = error
          return false
        } finally {
          window.clearTimeout(timer)
          if (current.inflight === controller) current.inflight = null
        }
      }
    })()
    const tracked: Promise<boolean> = run.finally(() => {
      if (current.uploading === tracked) current.uploading = null
    })
    current.uploading = tracked
    return tracked
  }, [])

  /** Ends a take whose recorder died, keeping the Pieces already cut so Retry can send them. */
  const fail = useCallback(
    (current: Session, recording: Recording, failed: DictationFailure) => {
      if (session.current !== current || current.recording !== recording || current.stopping) return
      current.failure = failed
      current.recording = null
      current.stopping = end(recording)
      stopInflight(current)
      releaseTake(current.profile, current.lock)
      current.lock = null
      setLevels(null)
      showFailure({ ...failed, discard: true })
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
      // A stop, an error and the stop timeout can all land, and only one may make the segment a Piece.
      let closed = false
      const close = () => {
        if (closed) return
        closed = true
        window.clearTimeout(segment.watch)
        recording.segments = recording.segments.filter((open) => open !== segment)
        if (segment.chunks.length && !segment.skip) {
          const type = recorder.mimeType || recording.mimeType || "audio/webm"
          const ms = Math.max(0, Date.now() - segment.startedAt)
          current.pieces.push({ blob: new Blob(segment.chunks, { type }), ms })
        }
        save(current, true)
        // A take that died waits for Retry instead, so its failure stays the bar's one message.
        if (session.current === current && !current.failure) void push(current)
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
        const error = (event as Event & { error?: unknown }).error
        fail(
          current,
          recording,
          microphoneFailure(micError(error, STOPPED), blockedMicrophone(error)),
        )
        close()
      }
      recording.segments.push(segment)
      recorder.start(1000)
      segment.watch = window.setTimeout(() => {
        if (!segment.chunks.length) fail(current, recording, microphoneFailure(SILENT))
      }, SILENT_MS)
      return segment
    },
    [fail, push],
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
        const motion = !prefersReducedMotion()
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
        // Without a meter the recording goes whole, as one Piece.
      }
    },
    [openSegment],
  )

  const start = async (caret?: number | null) => {
    if (session.current || !canRecord()) return
    const profile = connectionKey(latest.current.config)
    const lock = holdTake(profile)
    if (!lock) throw new Error(TAKE_RUNNING)
    const current = newSession(profile, latest.current.key, [], caret ?? undefined)
    current.lock = lock
    session.current = current
    setFailure(null)
    setStatus("listening")
    if (!leavesHost(profile)) void warmDictation(latest.current.config).catch(() => {})
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
      releaseTake(current.profile, current.lock)
      current.lock = null
      throw new Error(micError(failure, "Couldn't start the microphone."))
    }
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
      .forEach((track) =>
        track.addEventListener("ended", () => fail(current, recording, microphoneFailure(TAKEN))),
      )
    setStartedAt(recording.startedAt)
    // Past the cap the recording stops growing; Stop or Send still turns it into a take.
    recording.cap = window.setTimeout(() => {
      void end(recording)
      if (session.current === current) setLevels(null)
    }, MAX_MS)
  }

  const land = useCallback(
    (current: Session, answer: ConfirmedTake) => {
      forget(current)
      session.current = null
      showIdle()
      const text = answer.text.trim()
      if (text) latest.current.onCommitted?.(answer)
      return text
    },
    [showIdle],
  )

  /**
   * A take that could not be finished: its audio stays for a Retry, which sends it again under a
   * fresh Take id, and nothing of it lands (ADR 0074).
   */
  const giveUp = useCallback(
    (current: Session, failed: DictationFailure) => {
      if (session.current !== current) return null
      stopInflight(current)
      current.error = null
      current.sent.clear()
      save(current, true)
      // The host may have lost its speech provider since, and it holds audio this take can never
      // confirm again — a Retry mints a fresh id — so it is taken off the host now.
      void readDictationInfo(latest.current.config, true)
      void cancelDictation(latest.current.config, current.take).catch(
        quietly("Taking a failed take off its bot's host"),
      )
      showFailure({ ...failed, discard: true })
      return null
    },
    [showFailure],
  )

  const settle = useCallback(
    async (current: Session) => {
      setStatus("transcribing")
      setLevels(null)
      setFailure(null)
      // The recorders closing and the host's own answer about itself are independent, so they go
      // together: both are in front of the Confirm.
      await Promise.all([
        current.stopping,
        infos.has(current.profile) ? null : readDictationInfo(latest.current.config),
      ])
      if (session.current !== current) return null
      let bound = boundOf(current.profile)
      if (!bound) {
        await readDictationInfo(latest.current.config, true)
        bound = boundOf(current.profile)
      }
      if (!bound) return giveUp(current, failureOf("clip", OUTDATED, { discard: true }))
      const deadline = Date.now() + bound
      const left = () => Math.max(0, deadline - Date.now())
      const ranOut = () => giveUp(current, failureOf("clip", tookTooLong(bound), { discard: true }))
      const controller = new AbortController()
      current.asking = controller
      const timer = window.setTimeout(() => controller.abort(), bound)
      try {
        const uploaded = await within(push(current), left())
        if (session.current !== current) return null
        if (uploaded === undefined) return ranOut()
        if (!uploaded) return giveUp(current, clipFailure(current.error, bound))
        for (let attempt = 0; ; attempt++) {
          try {
            const answered = await bounded(
              confirmDictation(
                latest.current.config,
                current.take,
                current.pieces.length,
                controller.signal,
              ),
              left(),
            )
            if (answered === TIMED_OUT) return ranOut()
            if (session.current !== current) return null
            return land(current, answered)
          } catch (error) {
            if (attempt > 0 || !(error instanceof MissingPieces) || !error.missing.length)
              return giveUp(current, clipFailure(error, bound))
            // A host that names an index its own take never had can't send the app round in circles.
            for (const index of error.missing) {
              if (index >= 0 && index < current.pieces.length) current.sent.delete(index)
            }
            const resent = await within(push(current), left())
            if (session.current !== current) return null
            if (resent === undefined) return ranOut()
            if (!resent) return giveUp(current, clipFailure(current.error, bound))
          }
        }
      } finally {
        window.clearTimeout(timer)
        if (current.asking === controller) current.asking = null
      }
    },
    [giveUp, land, push],
  )

  const cancel = useCallback(() => {
    const current = session.current
    session.current = null
    if (current) {
      forget(current)
      stopInflight(current)
      if (current.recording) void end(current.recording)
      void cancelDictation(latest.current.config, current.take).catch(
        quietly("Taking a cancelled take off its bot's host"),
      )
    }
    showIdle()
  }, [showIdle])

  /**
   * Ends the recording and returns its words: `""` for a recording too short to hold speech, null
   * when the take could not be finished (it's kept for `retry`).
   */
  const finish = useCallback(() => {
    const current = session.current
    if (!current || (!current.recording && !current.failure)) {
      cancel()
      return Promise.resolve("")
    }
    if (current.finishing) return current.finishing
    const run = (async () => {
      if (current.recording) {
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
      }
      return settle(current)
    })()
    current.finishing = run
    const done = () => {
      if (current.finishing === run) current.finishing = null
    }
    void run.then(done, done)
    return run
  }, [cancel, settle])

  /** Sends the take again, under a fresh Take id, so no late Piece of the dead one can join it. */
  const retry = useCallback(async () => {
    const current = session.current
    if (!current) return null
    if (!current.pieces.length) {
      cancel()
      return ""
    }
    current.take = randomId()
    current.sent.clear()
    current.error = null
    return settle(current)
  }, [cancel, settle])

  useEffect(() => {
    let live = true
    if (key)
      void readKept(key).then((saved) => {
        if (!live || session.current || !saved?.pieces.length || saved.kind === "stream") return
        session.current = newSession(
          connectionKey(latest.current.config),
          key,
          saved.pieces.map((piece) => ({ blob: piece.blob, ms: piece.ms })),
          saved.caret,
        )
        session.current.failure = failureOf("clip", RESTORED, { discard: true })
        setFailure(session.current.failure)
        setStatus("failed")
      })
    return () => {
      live = false
      const current = session.current
      session.current = null
      if (!current) return
      stopInflight(current)
      releaseTake(current.profile, current.lock)
      current.lock = null
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
    failure,
    /** When the recorder started, for a hold that ends before the mic was granted. */
    recordingSince: () => session.current?.recording?.startedAt ?? null,
    anchor: () => session.current?.caret ?? null,
    start,
    finish,
    retry,
    cancel,
  }
}
