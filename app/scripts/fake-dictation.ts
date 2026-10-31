import { json } from "./component-kit.tsx"

export class FakeRecorder {
  static slices = 0
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
    FakeRecorder.slices = 0
    this.state = "recording"
    this.timer = setInterval(
      () => {
        FakeRecorder.slices += 1
        this.ondataavailable?.({ data: new Blob(["slice"], { type: "audio/webm" }) })
      },
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

/** One call the app made to a fake host: a Piece, a Confirm or a Cancel (ADR 0074). */
export interface DictationCall {
  path: string
  method: string
  /** The Take id the call names, where it names one. */
  take?: string
  /** A Piece's index in its take. */
  index?: number
  body: unknown
  vocabulary: string[]
}

export interface DictationHostOptions {
  /** What every Piece is heard as, and the words the Confirm answers as heard. */
  heard?: string
  /** The tidied words the Confirm answers with; the heard ones where no cleanup changed anything. */
  tidied?: string
  /** `fail` fails every Upload; `hang` never answers one. */
  upload?: "ok" | "fail" | "hang"
  /** Which Uploads fail, 1-based, so a Retry starts over from the first. */
  uploadFails?: number[]
  uploadError?: string
  /** `hang` never answers the Confirm; `slow` waits `confirmAfter` first. */
  confirm?: "ok" | "hang" | "slow"
  confirmAfter?: number
  /** How many Confirms are refused for a missing Piece before one is answered (the 409 recovery). */
  refuse?: number
  /** What tidied the take, as the Confirm reports it. */
  level?: string
  cleaned?: boolean
  provider?: string
  model?: string
  /** The bound the host states in `info.dictation.wait_ms`. */
  waitMs?: number
}

export function dictationHost(options: DictationHostOptions = {}) {
  const {
    heard = "hello there",
    tidied,
    upload = "ok",
    uploadFails = [],
    uploadError = "Local transcription failed.",
    confirm = "ok",
    confirmAfter = 0,
    refuse = 0,
    level = "light",
    cleaned = true,
    provider = "local",
    model = "base",
    waitMs = 38_000,
  } = options
  const calls: DictationCall[] = []
  // The host's own take registry: the indexes it holds, keyed by the app's Take id.
  const takes = new Map<string, Set<number>>()
  let uploads = 0
  let refusals = 0
  const pieces = () => calls.filter((call) => call.path.endsWith("/piece"))
  const confirms = () => calls.filter((call) => call.path.endsWith("/confirm"))
  const cancels = () => calls.filter((call) => call.method === "DELETE")
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = (init?.method ?? "GET").toUpperCase()
    const piece = /\/dictation\/([^/]+)\/piece$/.exec(url.pathname)
    const confirming = /\/dictation\/([^/]+)\/confirm$/.exec(url.pathname)
    const cancelling = /\/dictation\/([^/]+)$/.exec(url.pathname)
    const take =
      piece?.[1] ?? confirming?.[1] ?? (method === "DELETE" ? cancelling?.[1] : undefined)
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body
    calls.push({
      path: url.pathname,
      method,
      ...(take ? { take: decodeURIComponent(take) } : {}),
      ...(piece ? { index: Number(url.searchParams.get("index")) } : {}),
      body,
      vocabulary: url.searchParams.getAll("vocabulary"),
    })
    if (url.pathname.endsWith("/plugins/memento/info"))
      return json({
        name: "memento",
        features: ["dictation"],
        dictation: { ready: true, model: "base", wait_ms: waitMs },
      })
    if (url.pathname.endsWith("/dictation/warm"))
      return json({ object: "memento.dictation_warm", warmed: true, ms: 0 })
    if (piece?.length && method === "POST") {
      uploads += 1
      if (upload === "hang") return new Promise<Response>(() => {})
      if (upload === "fail" || uploadFails.includes(uploads))
        return json({ error: { message: uploadError } }, 502)
      const id = decodeURIComponent(piece[1])
      const index = Number(url.searchParams.get("index"))
      const held = takes.get(id) ?? new Set<number>()
      held.add(index)
      takes.set(id, held)
      return json({ object: "memento.dictation_piece", take: id, index }, 202)
    }
    if (confirming?.length && method === "POST") {
      const id = decodeURIComponent(confirming[1])
      const held = takes.get(id) ?? new Set<number>()
      const count = Number((body as { pieces?: number } | null)?.pieces)
      const missing = [...Array(count).keys()].filter((index) => !held.has(index))
      if (missing.length)
        return json({ error: { message: "The host is missing Pieces." }, missing }, 409)
      if (refusals < refuse) {
        refusals += 1
        return json(
          { error: { message: "The host is missing Pieces." }, missing: [count - 1] },
          409,
        )
      }
      if (confirm === "hang") return new Promise<Response>(() => {})
      if (confirm === "slow") await new Promise((done) => setTimeout(done, confirmAfter))
      takes.delete(id)
      return json({
        object: "memento.dictation",
        text: cleaned && tidied ? tidied : heard,
        heard,
        ms: count * 1000,
        level,
        cleaned,
        provider,
        model,
      })
    }
    if (cancelling?.length && method === "DELETE") {
      const removed = takes.delete(decodeURIComponent(cancelling[1]))
      return json({ object: "memento.dictation_cancelled", removed })
    }
    return json({}, 404)
  }
  globalThis.fetch = fetch as unknown as typeof globalThis.fetch
  return { calls, pieces, confirms, cancels, takes }
}
