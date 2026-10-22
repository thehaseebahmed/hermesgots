import { useCallback, useEffect, useRef, useState } from "react"

import { db } from "@/lib/db"
import { canRecord } from "@/lib/dictation"
import { quietly } from "@/lib/report"
import { randomId } from "@/lib/utils"

/** The host's limit on one meeting. */
export const MAX_RECORDING_MS = 3 * 60 * 60 * 1000

const TYPES = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4", "audio/webm"]
/** A chunk every few seconds, so a long recording never waits in the recorder's own buffer. */
const SLICE_MS = 5000
const TICK_MS = 250

export type RecorderState = "idle" | "recording" | "paused"

interface Live {
  id: string
  profileId: string
  projectId?: string
  startedAt: number
  recorder: MediaRecorder
  stream: MediaStream
  chunks: Blob[]
  since: number
  banked: number
  lock?: WakeLockSentinel
}

export interface Recorded {
  /** The saved recording the file came from; `forgetRecording` drops it once the host has the file. */
  id: string
  file: File
  ms: number
}

export interface RecordingTarget {
  profileId: string
  projectId?: string
}

const extensionOf = (type: string) =>
  type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "webm"

/** The recordings this page is making now, which the unfinished-recording prompt leaves alone. */
const running = new Set<string>()
export const isRecording = (id: string) => running.has(id)

const typeOf = (recorder: MediaRecorder) =>
  (recorder.mimeType || "audio/webm").split(";")[0] || "audio/webm"

export const recordingFile = (recording: { type: string; chunks: Blob[]; startedAt: number }) =>
  new File(
    recording.chunks,
    `${recordingTitle(new Date(recording.startedAt))}.${extensionOf(recording.type)}`,
    {
      type: recording.type,
    },
  )

/** Keeps what has been recorded so far on the device. A failed write only loses that safety net. */
function keep(current: Live) {
  void db.meetingRecordings
    .put({
      id: current.id,
      profileId: current.profileId,
      projectId: current.projectId,
      type: typeOf(current.recorder),
      chunks: [...current.chunks],
      ms: current.banked + (current.since ? Date.now() - current.since : 0),
      startedAt: current.startedAt,
      at: Date.now(),
    })
    .catch(quietly("meeting recording"))
}

export const forgetRecording = (id: string) =>
  db.meetingRecordings.delete(id).catch(quietly("meeting recording"))

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
    running.delete(current.id)
    current.stream.getTracks().forEach((track) => track.stop())
    void current.lock?.release().catch(() => {})
    setState("idle")
  }, [])

  /**
   * `keep` hands the file on (its saved copy stays until the host has it), `leave` ends without
   * handing it on (the saved copy stays, for the unfinished-recording prompt) and `discard` drops
   * the saved copy too.
   */
  const finish = useCallback(
    (mode: "keep" | "leave" | "discard") => {
      const current = live.current
      if (!current) return
      const ms = spent()
      const type = typeOf(current.recorder)
      const done = () => {
        const chunks = current.chunks
        release()
        if (mode === "discard") void forgetRecording(current.id)
        else if (chunks.length) keep(current)
        if (mode === "keep" && chunks.length) {
          const file = recordingFile({ type, chunks, startedAt: current.startedAt })
          ended.current?.({ id: current.id, file, ms })
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
      if (ms >= MAX_RECORDING_MS) finish("keep")
    }, TICK_MS)
    return () => window.clearInterval(timer)
    // spent reads only refs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, finish])

  // Leaving the screen ends the recording so no microphone stays open; what was recorded stays on
  // the device for the unfinished-recording prompt.
  useEffect(() => () => finish("leave"), [finish])

  const start = useCallback(
    async (target: RecordingTarget) => {
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
        id: randomId(),
        ...target,
        startedAt: Date.now(),
        recorder,
        stream,
        chunks: [],
        since: Date.now(),
        banked: 0,
      }
      live.current = current
      running.add(current.id)
      recorder.addEventListener("dataavailable", (event) => {
        if (!event.data.size) return
        current.chunks.push(event.data)
        keep(current)
      })
      // The microphone going away (another app takes it, the device revokes it) ends the meeting
      // with what was heard, rather than leaving a recording that is no longer recording.
      stream.getAudioTracks().forEach((track) =>
        track.addEventListener("ended", () => {
          setError("The recording stopped.")
          finish("keep")
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
    },
    [finish],
  )

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
    end: useCallback(() => finish("keep"), [finish]),
    discard: useCallback(() => finish("discard"), [finish]),
  }
}
