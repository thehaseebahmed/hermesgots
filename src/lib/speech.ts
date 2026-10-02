import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"

/**
 * Dictation with the browser's Web Speech API. Hermes's STT config is only served by its
 * dashboard (`/api/audio/voice-config`, localhost-only CORS), so the PWA can't use it.
 */

// lib.dom ships the event types but not the recognizer itself.
interface Recognizer {
  lang: string
  continuous: boolean
  interimResults: boolean
  start(): void
  stop(): void
  abort(): void
  onresult: ((event: SpeechRecognitionEvent) => void) | null
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null
  onend: (() => void) | null
}

type RecognizerClass = new () => Recognizer

function recognizerClass(): RecognizerClass | undefined {
  if (typeof window === "undefined") return undefined
  const w = window as unknown as {
    SpeechRecognition?: RecognizerClass
    webkitSpeechRecognition?: RecognizerClass
  }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition
}

const ERRORS: Partial<Record<SpeechRecognitionErrorCode, string>> = {
  "not-allowed": "Microphone access is blocked.",
  "service-not-allowed": "Microphone access is blocked.",
  "audio-capture": "No microphone found.",
  network: "Speech recognition needs a connection.",
  "language-not-supported": "Speech recognition doesn't support your language.",
}

const BARS = 32
const SAMPLE_MS = 50

export function joinText(...parts: string[]) {
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" ")
}

interface Session {
  recognizer: Recognizer
  /** Text finalized by earlier recognizer runs; Chrome ends a run on silence and we restart it. */
  committed: string
  final: string
  interim: string
  stopping: boolean
  ended?: () => void
  stream?: MediaStream
  audio?: AudioContext
  frame?: number
}

export type DictationStatus = "idle" | "listening" | "finishing"

export function useDictation() {
  const [status, setStatus] = useState<DictationStatus>("idle")
  const [final, setFinal] = useState("")
  const [interim, setInterim] = useState("")
  const [levels, setLevels] = useState<number[] | null>(null)
  const session = useRef<Session | null>(null)

  const teardown = useCallback((current: Session) => {
    if (current.frame !== undefined) cancelAnimationFrame(current.frame)
    current.stream?.getTracks().forEach((track) => track.stop())
    void current.audio?.close().catch(() => {})
    if (session.current === current) {
      session.current = null
      setStatus("idle")
      setFinal("")
      setInterim("")
      setLevels(null)
    }
  }, [])

  const meter = useCallback(async (current: Session) => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      if (session.current !== current || current.stopping) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      const audio = new AudioContext()
      const analyser = audio.createAnalyser()
      analyser.fftSize = 512
      audio.createMediaStreamSource(stream).connect(analyser)
      current.stream = stream
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
        const level = Math.min(1, Math.sqrt(sum / samples.length) * 5)
        history = [...history.slice(1), level]
        setLevels(history)
      }
      current.frame = requestAnimationFrame(tick)
    } catch {
      // The meter is cosmetic; some phones won't share the mic with the recognizer.
    }
  }, [])

  const start = useCallback(() => {
    const Recognition = recognizerClass()
    if (!Recognition || session.current) return

    const recognizer = new Recognition()
    recognizer.lang = navigator.language
    recognizer.continuous = true
    recognizer.interimResults = true
    const current: Session = { recognizer, committed: "", final: "", interim: "", stopping: false }

    recognizer.onresult = (event) => {
      let final = ""
      let interim = ""
      for (let i = 0; i < event.results.length; i++) {
        const result = event.results[i]
        if (result.isFinal) final = joinText(final, result[0].transcript)
        else interim = joinText(interim, result[0].transcript)
      }
      current.final = final
      current.interim = interim
      setFinal(joinText(current.committed, final))
      setInterim(interim)
    }
    recognizer.onerror = (event) => {
      const message = ERRORS[event.error]
      if (!message) return
      toast.error(message)
      current.stopping = true
      teardown(current)
    }
    recognizer.onend = () => {
      if (current.stopping) {
        current.ended?.()
        return
      }
      current.committed = joinText(current.committed, current.final, current.interim)
      current.final = ""
      current.interim = ""
      try {
        recognizer.start()
      } catch {
        teardown(current)
      }
    }

    session.current = current
    setStatus("listening")
    try {
      recognizer.start()
    } catch {
      teardown(current)
      return
    }
    void meter(current)
  }, [meter, teardown])

  /** Stops listening and resolves with everything heard, including words not yet finalized. */
  const finish = useCallback(async () => {
    const current = session.current
    if (!current) return ""
    current.stopping = true
    setStatus("finishing")
    await new Promise<void>((resolve) => {
      const timer = window.setTimeout(resolve, 1500)
      current.ended = () => {
        window.clearTimeout(timer)
        resolve()
      }
      current.recognizer.stop()
    })
    // Cancelled while we waited.
    if (session.current !== current) return ""
    const text = joinText(current.committed, current.final, current.interim)
    teardown(current)
    return text
  }, [teardown])

  const cancel = useCallback(() => {
    const current = session.current
    if (!current) return
    current.stopping = true
    current.recognizer.abort()
    teardown(current)
  }, [teardown])

  useEffect(
    () => () => {
      const current = session.current
      if (!current) return
      current.stopping = true
      current.recognizer.abort()
      teardown(current)
    },
    [teardown],
  )

  return {
    supported: recognizerClass() !== undefined,
    status,
    final,
    interim,
    levels,
    start,
    finish,
    cancel,
  }
}
