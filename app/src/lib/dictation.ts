import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react"

import {
  getDictationInfo,
  transcribeClip,
  warmDictation,
  type DictationInfo,
  type HermesConfig,
} from "@/lib/hermes"

/**
 * Dictation: the clip is recorded here and turned into text by the bot's own faster-whisper,
 * through the Memento plugin (`plugin/dictation.py`). Hermes's local model doesn't stream, so the
 * text arrives once the clip is done. A bot whose host can't is never offered a mic.
 */

const INFO_MS = 5 * 60 * 1000
const infos = new Map<string, { at: number; info: DictationInfo | null }>()
const listeners = new Set<() => void>()
const notify = () => listeners.forEach((listener) => listener())

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const infoKey = (config: HermesConfig) => `${config.baseUrl}\n${config.apiKey}`

async function readDictationInfo(config: HermesConfig, force = false) {
  const key = infoKey(config)
  const hit = infos.get(key)
  if (!force && hit && Date.now() - hit.at < INFO_MS) return hit.info
  const info = await getDictationInfo(config).catch(() => null)
  infos.set(key, { at: Date.now(), info })
  notify()
  return info
}

/** What the bot's host says about dictating, or null while it's asked (or unreachable). */
export function useDictationInfo(config: HermesConfig) {
  const key = config.apiKey && config.baseUrl ? infoKey(config) : ""
  const info = useSyncExternalStore(subscribe, () => infos.get(key)?.info ?? null)
  const { baseUrl, apiKey } = config
  useEffect(() => {
    if (!key) return
    void readDictationInfo({ baseUrl, apiKey })
    const timer = window.setInterval(() => void readDictationInfo({ baseUrl, apiKey }), INFO_MS)
    return () => window.clearInterval(timer)
  }, [key, baseUrl, apiKey])
  return key ? info : null
}

/** The longest clip; at 24 kbps it stays far under the API server's 10 MB body limit. */
const MAX_MS = 10 * 60 * 1000
/** Shorter than this is a stray tap, not speech. */
const MIN_MS = 300
/** A cold host may load (or first download) its model inside this request. */
const TRANSCRIBE_MS = 120_000
const TYPES = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4", "audio/webm"]
const BARS = 32
const SAMPLE_MS = 50

export const canRecord = () =>
  typeof window !== "undefined" &&
  typeof window.MediaRecorder === "function" &&
  Boolean(navigator.mediaDevices?.getUserMedia)

function recordingType() {
  return TYPES.find((type) => MediaRecorder.isTypeSupported?.(type))
}

function micError(error: unknown) {
  const name = error instanceof DOMException ? error.name : ""
  if (name === "NotAllowedError" || name === "SecurityError") return "Microphone access is blocked."
  if (name === "NotFoundError") return "No microphone found."
  if (name === "NotReadableError") return "The microphone is in use by another app."
  return "Couldn't start the microphone."
}

export type DictationStatus = "idle" | "listening" | "transcribing" | "failed"

interface Recording {
  stream: MediaStream
  recorder: MediaRecorder
  chunks: Blob[]
  audio?: AudioContext
  frame?: number
  cap?: number
  /** When the recorder started; null while the mic is still being asked for. */
  startedAt: number | null
  stoppedAt?: number
  stopped: Promise<void>
}

export function joinText(...parts: string[]) {
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" ")
}

export function useDictation(config: HermesConfig, hint: string) {
  const [status, setStatus] = useState<DictationStatus>("idle")
  const [levels, setLevels] = useState<number[] | null>(null)
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const recording = useRef<Recording | null>(null)
  // Set from `start` until the session ends, so a second press can't start another.
  const active = useRef(false)
  const clip = useRef<Blob | null>(null)
  const pending = useRef<AbortController | null>(null)
  const latest = useRef({ config, hint })
  useEffect(() => {
    latest.current = { config, hint }
  })

  const release = useCallback((current: Recording) => {
    if (current.frame !== undefined) cancelAnimationFrame(current.frame)
    if (current.cap !== undefined) window.clearTimeout(current.cap)
    current.stream.getTracks().forEach((track) => track.stop())
    void current.audio?.close().catch(() => {})
    current.frame = undefined
    current.audio = undefined
  }, [])

  const reset = useCallback(() => {
    const current = recording.current
    recording.current = null
    if (current) {
      if (current.recorder.state !== "inactive") current.recorder.stop()
      release(current)
    }
    pending.current?.abort()
    pending.current = null
    clip.current = null
    active.current = false
    setStatus("idle")
    setLevels(null)
    setStartedAt(null)
    setError(null)
  }, [release])

  const meter = useCallback((current: Recording) => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return
    try {
      const audio = new AudioContext()
      const analyser = audio.createAnalyser()
      analyser.fftSize = 512
      audio.createMediaStreamSource(current.stream).connect(analyser)
      current.audio = audio
      const samples = new Uint8Array(analyser.fftSize)
      let history = Array<number>(BARS).fill(0)
      let last = 0
      const tick = (now: number) => {
        current.frame = requestAnimationFrame(tick)
        if (now - last < SAMPLE_MS) return
        last = now
        analyser.getByteTimeDomainData(samples)
        let sum = 0
        for (const sample of samples) sum += ((sample - 128) / 128) ** 2
        history = [...history.slice(1), Math.min(1, Math.sqrt(sum / samples.length) * 5)]
        setLevels(history)
      }
      current.frame = requestAnimationFrame(tick)
    } catch {
      // The meter is cosmetic.
    }
  }, [])

  /** Starts recording; false when the mic couldn't be had. */
  const start = useCallback(async () => {
    if (active.current || !canRecord()) return false
    active.current = true
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
      active.current = false
      setStatus("idle")
      throw new Error(micError(failure))
    }
    // Cancelled while the mic was asked for.
    if (!active.current) {
      stream.getTracks().forEach((track) => track.stop())
      return false
    }
    const mimeType = recordingType()
    const recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 24_000 })
    const chunks: Blob[] = []
    let stopped!: () => void
    const current: Recording = {
      stream,
      recorder,
      chunks,
      startedAt: null,
      stopped: new Promise((resolve) => (stopped = resolve)),
    }
    recorder.ondataavailable = (event) => {
      if (event.data.size) chunks.push(event.data)
    }
    recorder.onstop = () => {
      current.stoppedAt ??= Date.now()
      stopped()
    }
    recording.current = current
    recorder.start(1000)
    current.startedAt = Date.now()
    setStartedAt(current.startedAt)
    // Past the cap the clip stops growing; Stop or Send still turns it into text.
    current.cap = window.setTimeout(() => {
      if (recorder.state !== "inactive") recorder.stop()
      release(current)
      setLevels(null)
    }, MAX_MS)
    meter(current)
    return true
  }, [meter, release])

  const transcribe = useCallback(
    async (audio: Blob) => {
      setStatus("transcribing")
      setLevels(null)
      const controller = new AbortController()
      pending.current = controller
      const timer = window.setTimeout(() => controller.abort(), TRANSCRIBE_MS)
      try {
        const { config, hint } = latest.current
        const text = await transcribeClip(config, audio, hint, controller.signal)
        if (pending.current !== controller) return null
        reset()
        return text
      } catch (failure) {
        if (pending.current !== controller) return null
        pending.current = null
        const timedOut = failure instanceof DOMException && failure.name === "AbortError"
        setError(
          timedOut
            ? "The bot took too long to transcribe."
            : failure instanceof Error
              ? failure.message
              : "Couldn't transcribe the recording.",
        )
        setStatus("failed")
        // The host may have lost faster-whisper since; ask again so the mic hides if so.
        void readDictationInfo(latest.current.config, true)
        return null
      } finally {
        window.clearTimeout(timer)
      }
    },
    [reset],
  )

  /**
   * Ends the recording and returns its text: `""` for a clip too short to hold speech, null when
   * the host couldn't transcribe it (the clip is kept for `retry`).
   */
  const finish = useCallback(async () => {
    const current = recording.current
    if (!current || current.startedAt === null) {
      reset()
      return ""
    }
    if (current.recorder.state !== "inactive") current.recorder.stop()
    release(current)
    await current.stopped
    recording.current = null
    const length = (current.stoppedAt ?? Date.now()) - current.startedAt
    const audio = new Blob(current.chunks, { type: current.recorder.mimeType || "audio/webm" })
    if (length < MIN_MS || !audio.size) {
      reset()
      return ""
    }
    clip.current = audio
    return transcribe(audio)
  }, [release, reset, transcribe])

  const retry = useCallback(async () => {
    const audio = clip.current
    if (!audio) return null
    setError(null)
    return transcribe(audio)
  }, [transcribe])

  useEffect(() => () => reset(), [reset])

  return {
    status,
    levels,
    startedAt,
    error,
    /** When the recorder started, for a hold that ends before the mic was granted. */
    recordingSince: () => recording.current?.startedAt ?? null,
    start,
    finish,
    retry,
    cancel: reset,
  }
}
