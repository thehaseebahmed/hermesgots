import { useCallback, useEffect, useRef, useState } from "react"
import type { PluginListenerHandle } from "@capacitor/core"
import { SpeechRecognition as NativeSpeech } from "@capgo/capacitor-speech-recognition"
import { toast } from "sonner"

import { isNative } from "@/lib/native"

/**
 * Dictation with the browser's Web Speech API, or Android's own recognizer in the app, whose
 * WebView has none. Hermes's STT config is only served by its dashboard
 * (`/api/audio/voice-config`, localhost-only CORS), so the app can't use it.
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
  onaudiostart: (() => void) | null
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

const ERRORS: Partial<Record<string, string>> = {
  "not-allowed": "Microphone access is blocked.",
  "service-not-allowed": "Microphone access is blocked.",
  "audio-capture": "No microphone found.",
  network: "Speech recognition needs a connection.",
  "language-not-supported": "Speech recognition doesn't support your language.",
  "no-speech": "Didn't hear anything.",
}

/** Errors a restart can get past; the rest end dictation. */
const PASSING_ERRORS = new Set<string>(["no-speech", "aborted"])

/**
 * Runs in a row that ended without a word before dictation gives up. Chrome ends a run after
 * several seconds of silence, but a recognizer that can't hear ends at once, and restarting it
 * forever looks like listening while nothing ever arrives.
 */
const MAX_EMPTY_RUNS = 3

/** Android's recognizer and a second capture of the mic for the meter can't share it. */
const SHARED_MIC = !/Android/i.test(navigator.userAgent)

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
  /** Runs since the last one that heard something, and the last error seen. */
  emptyRuns: number
  heard: boolean
  error?: string
  metered?: boolean
  stopping: boolean
  ended?: () => void
  stream?: MediaStream
  audio?: AudioContext
  frame?: number
}

export type DictationStatus = "idle" | "listening" | "finishing"

function useWebDictation() {
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
    const current: Session = {
      recognizer,
      committed: "",
      final: "",
      interim: "",
      emptyRuns: 0,
      heard: false,
      stopping: false,
    }

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
      current.heard = true
      setFinal(joinText(current.committed, final))
      setInterim(interim)
    }
    recognizer.onerror = (event) => {
      current.error = event.error
      if (current.stopping || PASSING_ERRORS.has(event.error)) return
      toast.error(ERRORS[event.error] ?? `Speech recognition failed (${event.error}).`)
      current.stopping = true
      teardown(current)
    }
    // Opening the meter's own stream only once the recognizer holds the mic keeps it from losing it.
    recognizer.onaudiostart = () => {
      if (!SHARED_MIC || current.metered) return
      current.metered = true
      void meter(current)
    }
    recognizer.onend = () => {
      if (current.stopping) {
        current.ended?.()
        return
      }
      current.emptyRuns = current.heard ? 0 : current.emptyRuns + 1
      const code = current.error ?? "no-speech"
      current.heard = false
      current.error = undefined
      if (current.emptyRuns >= MAX_EMPTY_RUNS) {
        toast.error(ERRORS[code] ?? `Speech recognition failed (${code}).`)
        current.stopping = true
        teardown(current)
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
    }
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

/** Android ends each utterance on silence; these mean it heard nothing, not that it broke. */
const NATIVE_PASSING = new Set(["NO_MATCH", "SPEECH_TIMEOUT", "RECOGNIZER_BUSY"])

const NATIVE_ERRORS: Record<string, string> = {
  INSUFFICIENT_PERMISSIONS: "Microphone access is blocked.",
  AUDIO: "No microphone found.",
  NETWORK: "Speech recognition needs a connection.",
  NETWORK_TIMEOUT: "Speech recognition needs a connection.",
}

interface NativeSession {
  /** Text from earlier utterances; the recognizer stops after each one and we start it again. */
  committed: string
  /** The current utterance, as the recognizer last reported it. */
  text: string
  emptyRuns: number
  heard: boolean
  error?: string
  stopping: boolean
  ended?: () => void
  handles: PluginListenerHandle[]
  levels: number[]
}

function useNativeDictation() {
  const [status, setStatus] = useState<DictationStatus>("idle")
  const [final, setFinal] = useState("")
  const [interim, setInterim] = useState("")
  const [levels, setLevels] = useState<number[] | null>(null)
  const session = useRef<NativeSession | null>(null)

  const teardown = useCallback((current: NativeSession) => {
    current.stopping = true
    for (const handle of current.handles) void handle.remove()
    current.handles = []
    if (session.current === current) {
      session.current = null
      setStatus("idle")
      setFinal("")
      setInterim("")
      setLevels(null)
    }
  }, [])

  const fail = useCallback(
    (current: NativeSession, message: string) => {
      if (session.current !== current) return
      toast.error(message)
      void NativeSpeech.forceStop().catch(() => {})
      teardown(current)
    },
    [teardown],
  )

  // Android beeps each time listening starts; only the first one says anything.
  const listen = useCallback(
    (current: NativeSession, again = false) =>
      NativeSpeech.start({
        language: navigator.language,
        partialResults: true,
        popup: false,
        muteRecognizerBeep: again,
      }).catch((error: unknown) =>
        fail(current, error instanceof Error ? error.message : "Speech recognition failed."),
      ),
    [fail],
  )

  const stopped = useCallback(
    (current: NativeSession) => {
      current.committed = joinText(current.committed, current.text)
      current.text = ""
      if (current.stopping) {
        current.ended?.()
        return
      }
      const code = current.error
      current.error = undefined
      if (code && !NATIVE_PASSING.has(code)) {
        fail(current, NATIVE_ERRORS[code] ?? `Speech recognition failed (${code}).`)
        return
      }
      current.emptyRuns = current.heard ? 0 : current.emptyRuns + 1
      current.heard = false
      if (current.emptyRuns >= MAX_EMPTY_RUNS) {
        fail(current, ERRORS["no-speech"]!)
        return
      }
      setFinal(current.committed)
      setInterim("")
      void listen(current, true)
    },
    [fail, listen],
  )

  const begin = useCallback(async () => {
    if (session.current) return
    const current: NativeSession = {
      committed: "",
      text: "",
      emptyRuns: 0,
      heard: false,
      stopping: false,
      handles: [],
      levels: Array<number>(BARS).fill(0),
    }
    session.current = current
    setStatus("listening")
    try {
      let { speechRecognition } = await NativeSpeech.checkPermissions()
      if (speechRecognition !== "granted") {
        ;({ speechRecognition } = await NativeSpeech.requestPermissions())
      }
      if (speechRecognition !== "granted") return fail(current, ERRORS["not-allowed"]!)
      if (!(await NativeSpeech.available()).available) {
        return fail(current, "Speech recognition isn't available on this device.")
      }
      const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches
      current.handles = await Promise.all([
        NativeSpeech.addListener("partialResults", (event) => {
          const text = event.matches?.[0]?.trim()
          if (!text || current.stopping) return
          current.text = text
          current.heard = true
          setFinal(current.committed)
          setInterim(text)
        }),
        NativeSpeech.addListener("error", (event) => {
          current.error = event.code
        }),
        NativeSpeech.addListener("listeningState", (event) => {
          if ((event.state ?? event.status) === "stopped") stopped(current)
        }),
        ...(still
          ? []
          : [
              NativeSpeech.addListener("audioLevel", ({ level }) => {
                current.levels = [...current.levels.slice(1), level]
                setLevels(current.levels)
              }),
            ]),
      ])
      // Cancelled while permissions were asked for.
      if (session.current !== current) {
        teardown(current)
        return
      }
      await listen(current)
    } catch (error) {
      fail(current, error instanceof Error ? error.message : "Speech recognition failed.")
    }
  }, [fail, listen, stopped, teardown])

  const start = useCallback(() => void begin(), [begin])

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
      void NativeSpeech.stop().catch(() => current.ended?.())
    })
    if (session.current !== current) return ""
    const text = joinText(current.committed, current.text)
    teardown(current)
    return text
  }, [teardown])

  const cancel = useCallback(() => {
    const current = session.current
    if (!current) return
    void NativeSpeech.forceStop().catch(() => {})
    teardown(current)
  }, [teardown])

  useEffect(
    () => () => {
      const current = session.current
      if (!current) return
      void NativeSpeech.forceStop().catch(() => {})
      teardown(current)
    },
    [teardown],
  )

  return {
    supported: true,
    status,
    final,
    interim,
    levels,
    start,
    finish,
    cancel,
  }
}

/** Picked once: the platform doesn't change while the app runs. */
export const useDictation = isNative ? useNativeDictation : useWebDictation
