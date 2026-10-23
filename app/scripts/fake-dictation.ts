import { json } from "./component-kit.tsx"

export class FakeRecorder {
  static isTypeSupported() {
    return true
  }
  state = "inactive"
  mimeType = "audio/webm"
  ondataavailable: ((event: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  onerror: (() => void) | null = null
  private listeners: (() => void)[] = []
  private timer?: ReturnType<typeof setInterval>
  addEventListener(name: string, listener: () => void) {
    if (name === "stop") this.listeners.push(listener)
  }
  start(ms: number) {
    this.state = "recording"
    this.timer = setInterval(
      () => this.ondataavailable?.({ data: new Blob(["slice"], { type: "audio/webm" }) }),
      Math.max(ms, 40),
    )
  }
  stop() {
    if (this.state === "inactive") return
    clearInterval(this.timer)
    this.state = "inactive"
    for (const listener of this.listeners) listener()
  }
}

export function fakeMic() {
  const track = () => ({ stop() {}, addEventListener() {}, kind: "audio" })
  return async () => ({
    getTracks: () => [track()],
    getAudioTracks: () => [track()],
  })
}

export function installFakeMedia() {
  window.MediaRecorder = FakeRecorder as unknown as typeof MediaRecorder
  Object.assign(globalThis, { MediaRecorder: FakeRecorder })
  Object.defineProperty(globalThis.navigator, "mediaDevices", {
    value: { getUserMedia: fakeMic() },
    configurable: true,
  })
}

/** A call the fake host was asked, with what it carried and the bot's words on its query. */
export interface DictationCall {
  method: string
  path: string
  /** The request's body: parsed when it was JSON, and the recording itself when it was audio. */
  body: unknown
  vocabulary: string[]
}

export interface DictationHostOptions {
  /** What a clip answers: the words the speech model heard, filler and all. */
  heard?: string
  /** A clip's answer: the words, a host that fails it, or one that never answers it. */
  clip?: "ok" | "fail" | "hang"
  /** Which clips fail, 1-based, so a Retry hears the next one. */
  clipFails?: number[]
  /** What a failed clip says. */
  clipError?: string
  /** How long the host takes over a clip. */
  clipAfter?: number
  /** The end cleanup: a tidied answer, a refusal, an answer in the wrong shape, or none at all. */
  cleanup?: "ok" | "fail" | "junk" | "hang"
  /** What the cleanup answers. */
  tidied?: string
  /** How long the cleanup takes, so a Cancel can land inside it. */
  cleanupAfter?: number
}

/**
 * The host's dictation routes, faked for one take: its info, its warm, its clips and the cleanup
 * that tidies a finished one. Every call is kept, so a test can assert what was asked for — and
 * the knobs are the shapes the flows differ by, so a take's words and failures are stated once.
 */
export function dictationHost(options: DictationHostOptions = {}) {
  const {
    heard = "hello there",
    clip = "ok",
    clipFails = [],
    clipError = "Local transcription failed.",
    clipAfter = 50,
    cleanup = "ok",
    tidied,
    cleanupAfter = 0,
  } = options
  const calls: DictationCall[] = []
  const clips = () => calls.filter((call) => call.path.endsWith("/dictation"))
  const cleanups = () => calls.filter((call) => call.path.endsWith("/dictation/cleanup"))
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = (init?.method ?? "GET").toUpperCase()
    calls.push({
      method,
      path: url.pathname,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
      vocabulary: url.searchParams.getAll("vocabulary"),
    })
    if (url.pathname.endsWith("/plugins/memento/info"))
      return json({
        name: "memento",
        features: ["dictation"],
        dictation: { ready: true, model: "base" },
      })
    if (url.pathname.endsWith("/dictation/warm"))
      return json({ object: "memento.dictation_warm", warmed: true, ms: 0 })
    if (url.pathname.endsWith("/dictation/cleanup") && method === "POST") {
      if (cleanup === "hang") return new Promise<Response>(() => {})
      if (cleanupAfter) await new Promise((done) => setTimeout(done, cleanupAfter))
      if (cleanup === "fail")
        return json({ error: { message: "Couldn't tidy the dictation." } }, 502)
      if (cleanup === "junk") return json({ object: "memento.dictation_cleanup", text: 42 })
      return json({
        object: "memento.dictation_cleanup",
        text: tidied ?? heard,
        cleaned: true,
        ms: 900,
      })
    }
    if (url.pathname.endsWith("/dictation") && method === "POST") {
      const number = clips().length
      if (clip === "hang") return new Promise<Response>(() => {})
      if (clipAfter) await new Promise((done) => setTimeout(done, clipAfter))
      if (clip === "fail" || clipFails.includes(number))
        return json({ error: { message: clipError } }, 502)
      return json({ object: "memento.dictation", text: heard, ms: 50 })
    }
    return json({}, 404)
  }
  globalThis.fetch = fetch as unknown as typeof globalThis.fetch
  return { calls, clips, cleanups }
}

