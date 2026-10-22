import { useCallback, useEffect, useRef, useState } from "react"

import { canRecord } from "@/lib/dictation"

/** The host's limit on one meeting. */
export const MAX_RECORDING_MS = 3 * 60 * 60 * 1000

const TYPES = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4", "audio/webm"]
/** A chunk every few seconds, so a long recording never waits in the recorder's own buffer. */
const SLICE_MS = 5000
const TICK_MS = 250

export type RecorderState = "idle" | "recording" | "paused"

interface Live {
  recorder: MediaRecorder
  stream: MediaStream
  chunks: Blob[]
  since: number
  banked: number
  lock?: WakeLockSentinel
}

export interface Recorded {
  file: File
  ms: number
}

const extensionOf = (type: string) =>
  type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "webm"

function micError(error: unknown) {
  const name = error instanceof DOMException ? error.name : ""
  if (name === "NotAllowedError" || name === "SecurityError") return "Microphone access is blocked."
  if (name === "NotFoundError") return "No microphone found."
  if (name === "NotReadableError") return "The microphone is in use by another app."
  return "Couldn't start the recording."
}

/** Writes the clock a recording is titled with, like `Meeting 22 Oct, 09:30`. */
export function recordingTitle(at = new Date()) {
  const day = at.toLocaleDateString(undefined, { day: "numeric", month: "short" })
  const time = at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
  return `Meeting ${day}, ${time}`
}

/**
 * Records the room as one continuous file with a single `MediaRecorder`, so what the host decodes
 * is a whole recording and not pieces to stitch. The audio stays in this page's memory until the
 * recording ends (24 kbps Opus is about 11 MB an hour); a page closed mid-meeting loses it.
 */
export function useMeetingRecorder(onEnded?: (recorded: Recorded) => void) {
  const [state, setState] = useState<RecorderState>("idle")
  const [elapsed, setElapsed] = useState(0)
  const [error, setError] = useState<string>()
  const live = useRef<Live>(undefined)
  const ended = useRef(onEnded)
  useEffect(() => {
    ended.current = onEnded
  })

  const spent = () => {
    const current = live.current
    if (!current) return 0
    return current.banked + (current.since ? Date.now() - current.since : 0)
  }

  const release = useCallback(() => {
    const current = live.current
    if (!current) return
    live.current = undefined
    current.stream.getTracks().forEach((track) => track.stop())
    void current.lock?.release().catch(() => {})
    setState("idle")
  }, [])

  const finish = useCallback(
    (keep: boolean) => {
      const current = live.current
      if (!current) return
      const ms = spent()
      const type = current.recorder.mimeType || "audio/webm"
      const done = () => {
        const chunks = current.chunks
        release()
        if (keep && chunks.length) {
          const base = type.split(";")[0]
          const file = new File(chunks, `${recordingTitle()}.${extensionOf(base)}`, { type: base })
          ended.current?.({ file, ms })
        }
      }
      if (current.recorder.state === "inactive") done()
      else {
        current.recorder.addEventListener("stop", done, { once: true })
        current.recorder.stop()
      }
    },
    // spent reads only refs
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [release],
  )

  useEffect(() => {
    if (state === "idle") return
    const timer = window.setInterval(() => {
      const ms = spent()
      setElapsed(ms)
      if (ms >= MAX_RECORDING_MS) finish(true)
    }, TICK_MS)
    return () => window.clearInterval(timer)
    // spent reads only refs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, finish])

  // Leaving the screen ends the recording without keeping it, so no microphone stays open.
  useEffect(() => () => finish(false), [finish])

  const start = useCallback(async () => {
    if (live.current) return false
    setError(undefined)
    if (!canRecord()) {
      setError("This browser can't record.")
      return false
    }
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      })
    } catch (failure) {
      setError(micError(failure))
      return false
    }
    const mimeType = TYPES.find((type) => MediaRecorder.isTypeSupported?.(type))
    const recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 24_000 })
    const current: Live = {
      recorder,
      stream,
      chunks: [],
      since: Date.now(),
      banked: 0,
    }
    live.current = current
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size) current.chunks.push(event.data)
    })
    // The microphone going away (another app takes it, the device revokes it) ends the meeting
    // with what was heard, rather than leaving a recording that is no longer recording.
    stream.getAudioTracks().forEach((track) =>
      track.addEventListener("ended", () => {
        setError("The recording stopped.")
        finish(true)
      }),
    )
    recorder.start(SLICE_MS)
    setElapsed(0)
    setState("recording")
    try {
      current.lock = await navigator.wakeLock?.request("screen")
    } catch {
      // The screen may sleep; the recording carries on.
    }
    return true
  }, [finish])

  const pause = useCallback(() => {
    const current = live.current
    if (!current || current.recorder.state !== "recording") return
    current.banked = spent()
    current.since = 0
    current.recorder.pause()
    setState("paused")
    // spent reads only refs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const resume = useCallback(() => {
    const current = live.current
    if (!current || current.recorder.state !== "paused") return
    current.since = Date.now()
    current.recorder.resume()
    setState("recording")
  }, [])

  return {
    state,
    elapsed,
    error,
    start,
    pause,
    resume,
    end: useCallback(() => finish(true), [finish]),
    discard: useCallback(() => finish(false), [finish]),
  }
}
