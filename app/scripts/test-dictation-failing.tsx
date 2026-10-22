/**
 * A take that fails says so: a start the host refuses keeps the host's own reason, a speech model
 * that won't load fails the take with a retry rather than sitting on "Preparing…", a host that goes
 * away mid-take ends it with the words it already had and says what happened, and a clip the batch
 * route couldn't transcribe says so too — each with what to try, dismissible, and with nothing left
 * held: the microphone, the profile's take and the host's take are all let go.
 *
 * The microphone and the recorder are faked at the edge the app uses them; the host is faked at
 * `fetch`, so the take really records, slices, pumps and ends.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { Composer } from "@/components/chat/composer"
import { db, type Attachment } from "@/lib/db"
import {
  click,
  connection,
  find,
  findAll,
  json,
  mount,
  seedSettings,
  settle,
  type,
  until,
} from "./component-kit.tsx"

/** A recorder that makes a slice every 40 ms, as a real one makes one every 250. */
class FakeRecorder {
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

/** A microphone that hands out a stream with one track, as the browser's does. */
function fakeMic() {
  const track = () => ({ stop() {}, addEventListener() {}, kind: "audio" })
  return async () => ({
    getTracks: () => [track()],
    getAudioTracks: () => [track()],
  })
}

window.MediaRecorder = FakeRecorder as unknown as typeof MediaRecorder
Object.assign(globalThis, { MediaRecorder: FakeRecorder })
Object.defineProperty(globalThis.navigator, "mediaDevices", {
  value: { getUserMedia: fakeMic() },
  configurable: true,
})

const bot = connection("dictation-failing")
// A host that answers one clip at a time names its own connection: an answer is remembered per
// connection, so a host that answers differently must not share one with the streaming host.
const clipBot = connection("dictation-failing-clip")
const SENTENCE = "Let's ship the dictation feature today."
const TAIL = { id: 2, text: "hello there and that is all" }

interface HostOptions {
  /** What the host answers the first take's start with. A retry afterwards opens a take. */
  start?: "refuse" | "model" | "unreachable"
  /** The slice that fails, counting from one: a host that goes away mid-take. */
  slice?: number
  /** A host that hears the take while it is spoken (default), or one that answers one clip. */
  hears?: boolean
  /** The batch route's clip: answered, or failing once so a retry can land. */
  clip?: "ok" | "fail-once"
  /** Held back until it resolves, so a start can be let go while the host is still answering. */
  gate?: Promise<void>
}

/** A host, as the app talks to it: the take routes a streaming plugin has, and the batch route. */
function host({ start, slice, hears = true, clip = "ok", gate }: HostOptions = {}) {
  let starts = 0
  let slices = 0
  let clips = 0
  let cancels = 0
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname
    const method = (init?.method ?? "GET").toUpperCase()
    if (path.endsWith("/plugins/memento/info"))
      return json({
        name: "memento",
        features: hears ? ["dictation", "dictation_stream"] : ["dictation"],
        dictation: { ready: true, model: "base" },
      })
    if (path.endsWith("/dictation/warm")) return json({ object: "memento.dictation_warm", warmed: true })
    if (path.endsWith("/dictation/take") && method === "POST") {
      const refused = starts === 0 ? start : undefined
      starts += 1
      if (refused === "unreachable") throw new TypeError("Failed to fetch")
      if (refused === "refuse")
        return json(
          { error: { message: "This Hermes can't decode audio while it is spoken." } },
          409,
        )
      if (refused === "model")
        return json(
          { error: { message: "The host couldn't load its small speech model: no such file" } },
          502,
        )
      if (gate) await gate
      return json({ object: "memento.dictation_take", take: `dt_${starts}`, ready: true })
    }
    const take = /\/dictation\/take\/([^/]+)\/(audio|stop|cancel)$/.exec(path)
    if (take) {
      const [, id, action] = take
      if (action === "cancel") {
        cancels += 1
        return json({ object: "memento.dictation_cancel", cancelled: true })
      }
      if (action === "stop")
        return json({
          object: "memento.dictation_stop",
          take: id,
          words: "",
          phrases: [TAIL],
          behind: false,
        })
      slices += 1
      if (slice && slices === slice)
        return json({ error: { message: "Couldn't decode the recording: bad container" } }, 502)
      return json({
        object: "memento.dictation_audio",
        take: id,
        words: slices === 1 ? "hello there" : "",
        phrases: [],
        behind: false,
      })
    }
    if (path.endsWith("/plugins/memento/dictation") && method === "POST") {
      clips += 1
      if (clip === "fail-once" && clips === 1)
        return json(
          { error: { message: "Local transcription failed: the model ran out of memory." } },
          502,
        )
      return json({ object: "memento.dictation", text: SENTENCE, ms: 700 })
    }
    return json({}, 404)
  }
  globalThis.fetch = fetch as unknown as typeof globalThis.fetch
  return {
    starts: () => starts,
    slices: () => slices,
    clips: () => clips,
    cancels: () => cancels,
  }
}

const composer = (
  server: typeof bot,
  draftKey: string,
  sent: { text: string; attachments: Attachment[] }[],
) => (
  <Composer
    busy={false}
    onSend={(text, attachments) => {
      sent.push({ text, attachments })
    }}
    onQueue={() => {}}
    onStop={() => {}}
    onCommand={() => {}}
    connection={server}
    filesAvailable={false}
    imagesAvailable
    draftKey={draftKey}
  />
)

const field = () => find("textarea") as HTMLTextAreaElement | null
const bar = () => find('[role="region"][aria-label="Dictation"]')
const alert = () => find('[role="alert"]')
/** The failure line: the host's own sentence, and what to try beneath it. */
const line = () => alert()?.parentElement?.textContent ?? ""
const button = (label: string) =>
  findAll("button").find((one) => one.getAttribute("aria-label") === label) ?? null
const textButton = (label: string) =>
  findAll("button").find((one) => one.textContent?.trim() === label) ?? null

/** Waits for the bar's failure line, and answers what it says. */
async function failedWith(says: string) {
  await until(
    async () => line().includes(says),
    `the bar to say "${says}" (it says "${line()}", screen: "${(document.body.textContent ?? "").slice(0, 300)}")`,
  )
  return line()
}

async function reset(server: typeof bot, ...keys: string[]) {
  await seedSettings()
  await db.profiles.clear()
  await db.profiles.put({
    id: "bot-1",
    name: "A bot",
    baseUrl: server.baseUrl,
    apiKey: server.apiKey,
    model: "test/model",
    botId: "bot-1",
    createdAt: 1,
    updatedAt: 1,
  } as never)
  await db.drafts.clear()
  await db.dictations.clear()
  for (const key of keys) await db.drafts.put({ id: key, text: "", at: 1 })
}

test("a start the host refuses keeps the host's reason, and the composer is as it was", async () => {
  const sent: { text: string; attachments: Attachment[] }[] = []
  const hosted = host({ start: "refuse" })
  await reset(bot, "c:refused")
  await mount(composer(bot, "c:refused", sent), async () => {
    await until(async () => Boolean(button("Voice")), "the microphone")
    await settle()
    await type(field(), "Note:")
    await click(button("Voice"))

    const line = await failedWith("This Hermes can't decode audio while it is spoken.")
    assert.match(line, /host can dictate/, "the line says what to try")
    assert.equal(findAll("button").some((one) => one.textContent?.trim() === "Retry"), true)
    assert.equal(
      document.body.textContent?.includes("Preparing…"),
      false,
      "a refused take is not left preparing",
    )
    assert.ok(button("Dismiss"), "the line can be dismissed")
    assert.equal(button("Discard"), null, "nothing was heard, so there is nothing to discard")
    assert.equal(bar(), null, "a refused start never shows the take's own bar")
    assert.equal(hosted.starts(), 1, "the host was asked once")

    await click(button("Dismiss"))
    await until(async () => Boolean(button("Voice")), "the bar back to idle")
    assert.equal(field()?.value, "Note:", "the composer is as it was")
    assert.equal(sent.length, 0)
  })
})

test("a speech model that won't load fails the take with a retry rather than preparing for ever", async () => {
  const sent: { text: string; attachments: Attachment[] }[] = []
  const hosted = host({ start: "model" })
  await reset(bot, "c:model")
  await mount(composer(bot, "c:model", sent), async () => {
    await until(async () => Boolean(button("Voice")), "the microphone")
    await settle()
    await click(button("Voice"))

    const line = await failedWith("The host couldn't load its small speech model")
    assert.match(line, /speech model on the Dictation tab/, "the picker is what to try")
    assert.equal(document.body.textContent?.includes("Preparing…"), false)

    // Retry is a fresh take from the same composer, and this time the host loads its model.
    await click(textButton("Retry"))
    await until(async () => hosted.starts() === 2, "a fresh take on the host")
    await until(async () => Boolean(button("Stop")), "the bar listening again")
    assert.equal(alert(), null, "the failure line is gone")
    await click(button("Cancel"))
    await until(async () => Boolean(button("Voice")), "the bar back to idle")
    assert.equal(field()?.value ?? "", "", "nothing was inserted")
  })
})

test("a host that goes away mid-take ends the take with its words, and nothing is left held", async () => {
  const sent: { text: string; attachments: Attachment[] }[] = []
  const hosted = host({ slice: 2 })
  await reset(bot, "c:gone")
  await mount(composer(bot, "c:gone", sent), async () => {
    await until(async () => Boolean(button("Voice")), "the microphone")
    await settle()
    await type(field(), "Before after")
    field()!.setSelectionRange(7, 7)
    await click(button("Voice"))
    await until(async () => (bar()?.textContent ?? "").includes("hello there"), "the take's words")

    const line = await failedWith("Couldn't decode the recording: bad container")
    assert.match(line, /words it already heard are kept/, "the line says what to try")
    assert.match(
      alert()?.getAttribute("title") ?? "",
      /Couldn't decode the recording: bad container Try again; the words it already heard are kept\./,
      "the tooltip carries both sentences",
    )
    assert.equal(
      document.body.textContent?.includes("Transcribing…"),
      false,
      "a failed take is not left transcribing",
    )
    assert.equal(hosted.cancels(), 1, "the host's take is freed")

    await click(button("Dismiss"))
    await until(async () => Boolean(field()), "the composer back")
    assert.equal(
      field()?.value,
      "Before hello there after",
      "the words the host had committed land where the take began",
    )
    assert.equal(hosted.cancels(), 1, "dismissing the line does not cancel the take twice")
    assert.equal(await db.dictations.count(), 0, "a failed take keeps nothing on the device")

    // The microphone and the profile's take were let go with it: the next take opens.
    await click(button("Voice"))
    await until(async () => hosted.starts() === 2, "a take after the failure")
    await click(button("Cancel"))
    await until(async () => Boolean(button("Voice")), "the bar back to idle")
  })
})

test("a clip the batch route couldn't transcribe says so, and the recording is retried", async () => {
  const sent: { text: string; attachments: Attachment[] }[] = []
  const hosted = host({ hears: false, clip: "fail-once" })
  await reset(clipBot, "c:clip")
  await mount(composer(clipBot, "c:clip", sent), async () => {
    await until(async () => Boolean(button("Voice")), "the microphone")
    await settle()
    await click(button("Voice"))
    await until(async () => Boolean(button("Stop")), "the take recording")
    // A recorder flushes its first chunk a second in, so the take needs one before Stop closes it.
    await new Promise((done) => setTimeout(done, 1200))
    await click(button("Stop"))

    const line = await failedWith("Local transcription failed: the model ran out of memory.")
    assert.match(line, /Try again, or type it instead/, "the line says what to try")
    assert.equal(button("Discard"), button("Discard"), "its recording is still kept, so it discards")

    await click(textButton("Retry"))
    await until(async () => field()?.value === SENTENCE, "the clip's words")
    assert.equal(hosted.clips(), 2, "the recording was sent again")
    await until(async () => Boolean(button("Voice")), "the bar back to idle")
  })
})

test("a take the host opens after the user let it go is let go on the host too", async () => {
  const sent: { text: string; attachments: Attachment[] }[] = []
  let answer: () => void = () => {}
  const hosted = host({ gate: new Promise<void>((done) => (answer = done)) })
  await reset(bot, "c:late")
  await mount(composer(bot, "c:late", sent), async () => {
    await until(async () => Boolean(button("Voice")), "the microphone")
    await settle()
    await click(button("Voice"))
    await until(async () => hosted.starts() === 1, "the host asked for a take")
    // The user lets the take go while the host is still answering.
    await click(button("Cancel"))
    await until(async () => Boolean(button("Voice")), "the bar back to idle")
    answer()
    await until(async () => hosted.cancels() === 1, "the host told to forget the take it opened")
    // Nothing was inserted and the mic is free: the next take opens.
    assert.equal(field()?.value ?? "", "")
    await click(button("Voice"))
    await until(async () => hosted.starts() === 2, "a take after it")
    await click(button("Cancel"))
    await until(async () => Boolean(button("Voice")), "the bar back to idle")
  })
})
