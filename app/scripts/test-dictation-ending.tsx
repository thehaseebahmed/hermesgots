import assert from "node:assert/strict"
import test from "node:test"

import { Composer } from "@/components/chat/composer"
import { db, type Attachment } from "@/lib/db"
import {
  click,
  connection,
  json,
  mount,
  seedSettings,
  settle,
  type,
  until,
} from "./component-kit.tsx"

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

const bot = connection("dictation-ending")

interface HostOptions {
  stop?: "hang" | { after?: number; phrases?: { id: number; text: string }[] }
}

function host({ stop = {} }: HostOptions = {}) {
  const calls: string[] = []
  const answered = new Map<string, number>()
  let takes = 0
  let cancels = 0
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname
    const method = (init?.method ?? "GET").toUpperCase()
    calls.push(`${method} ${path}`)
    if (path.endsWith("/plugins/memento/info"))
      return json({
        name: "memento",
        features: ["dictation", "dictation_stream"],
        dictation: { ready: true, model: "base" },
      })
    if (path.endsWith("/dictation/take") && method === "POST") {
      takes += 1
      return json({ object: "memento.dictation_take", take: `dt_${takes}`, ready: true })
    }
    const route = /\/dictation\/take\/([^/]+)\/(audio|stop|cancel)$/.exec(path)
    if (route) {
      const [, take, action] = route
      if (action === "cancel") {
        cancels += 1
        return json({ object: "memento.dictation_cancel", cancelled: true })
      }
      if (action === "stop") {
        if (stop === "hang") return new Promise<Response>(() => {})
        if (stop.after) await new Promise((done) => setTimeout(done, stop.after))
        return json({
          object: "memento.dictation_stop",
          take,
          words: "",
          phrases: stop.phrases ?? [],
          behind: false,
        })
      }
      const heard = answered.get(take) ?? 0
      answered.set(take, heard + 1)
      return json({
        object: "memento.dictation_audio",
        take,
        words: heard ? "" : "hello there",
        phrases: [],
        behind: false,
      })
    }
    return json({}, 404)
  }
  globalThis.fetch = fetch as unknown as typeof globalThis.fetch
  return {
    calls,
    starts: () => takes,
    cancels: () => cancels,
    stops: () => calls.filter((call) => call.endsWith("/stop")).length,
  }
}

const TAIL = { id: 2, text: "hello there and that is all" }
const TAKEN = "hello there and that is all"

const composer = (draftKey: string, sent: { text: string; attachments: Attachment[] }[]) => (
  <Composer
    busy={false}
    onSend={(text, attachments) => {
      sent.push({ text, attachments })
    }}
    onQueue={() => {}}
    onStop={() => {}}
    onCommand={() => {}}
    connection={bot}
    filesAvailable={false}
    imagesAvailable
    draftKey={draftKey}
  />
)

const field = (scope: ParentNode = document) =>
  scope.querySelector("textarea") as HTMLTextAreaElement | null
const bar = (scope: ParentNode = document) =>
  scope.querySelector('[role="region"][aria-label="Dictation"]')
const barText = (scope: ParentNode = document) => bar(scope)?.textContent ?? ""
const button = (label: string, scope: ParentNode = document) =>
  scope.querySelector(`[aria-label="${label}"]`)

async function openTake(hosted: ReturnType<typeof host>, scope: ParentNode = document) {
  await until(async () => Boolean(button("Voice", scope)), "the microphone")
  await settle()
  await click(button("Voice", scope))
  await until(async () => hosted.starts() === 1, "the take opened on the host")
  await until(async () => barText(scope).includes("hello there"), "the take's words in the bar")
}

async function reset(...keys: string[]) {
  await seedSettings()
  await db.drafts.clear()
  await db.dictations.clear()
  for (const key of keys) await db.drafts.put({ id: key, text: "", at: 1 })
}

test("a Stop finishes the take, and its tail lands where the caret was", async () => {
  const sent: { text: string; attachments: Attachment[] }[] = []
  const hosted = host({ stop: { after: 50, phrases: [TAIL] } })
  await reset("c:stop")
  await mount(composer("c:stop", sent), async () => {
    await type(field(), "Before after")
    field()!.setSelectionRange(7, 7)
    await openTake(hosted)

    await click(button("Stop"))
    await until(
      async () => field()?.value === "Before hello there and that is all after",
      "the take",
    )
    assert.equal(hosted.stops(), 1, "the host was asked to finish the take once")
    assert.equal(sent.length, 0, "a Stop puts the words in the field, it does not send them")
    assert.equal(await db.dictations.count(), 0, "a take that ended keeps nothing on the device")
  })
})

test("a Send mid-take waits for the tail and sends the whole take", async () => {
  const sent: { text: string; attachments: Attachment[] }[] = []
  const hosted = host({ stop: { after: 50, phrases: [TAIL] } })
  await reset("c:send")
  await mount(composer("c:send", sent), async () => {
    await openTake(hosted)

    await click(button("Send"))
    await until(async () => sent.length === 1, "the message sent")
    assert.equal(sent[0].text, TAKEN, "the tail the send waited for is in the message")
    await until(async () => Boolean(field()), "the composer is back")
    assert.equal(field()?.value, "", "the message took the words")
    assert.equal(hosted.cancels(), 0, "a tail that answered is not abandoned")
  })
})

test("a Send whose tail hangs sends what the bar has, and gives the composer back", async () => {
  const sent: { text: string; attachments: Attachment[] }[] = []
  const hosted = host({ stop: "hang" })
  await reset("c:hang")
  await mount(composer("c:hang", sent), async () => {
    await openTake(hosted)
    const started = Date.now()

    await click(button("Send"))
    await until(async () => sent.length === 1, "the message sent with what the take had")
    const waited = Date.now() - started
    assert.equal(sent[0].text, "hello there", "exactly the words the bar had shown, once")
    assert.ok(waited < 4000, `the send was bounded rather than hanging (${waited} ms)`)
    assert.equal(hosted.cancels(), 1, "the host is told to forget a take nobody waits for")
    await until(async () => Boolean(field()), "the composer is back")
  })
})

test("a Stop whose tail hangs gives the composer back with the words it has", async () => {
  const sent: { text: string; attachments: Attachment[] }[] = []
  const hosted = host({ stop: "hang" })
  await reset("c:stop-hang")
  await mount(composer("c:stop-hang", sent), async () => {
    await type(field(), "Before")
    await openTake(hosted)
    const started = Date.now()

    await click(button("Stop"))
    for (let end = started + 11_000; !field() && Date.now() < end;)
      await new Promise((done) => setTimeout(done, 20))
    assert.ok(field(), "the composer came back rather than staying in the ending")
    assert.ok(Date.now() - started < 11_000, "and inside its bound")
    assert.equal(field()!.value, "Before hello there", "the words the take had, at the caret")
    assert.equal(sent.length, 0, "a Stop puts them in the field")
    assert.equal(hosted.cancels(), 1, "the host is told to forget the take it never finished")
  })
})

test("a Cancel while the tail is being waited for inserts nothing, even when it answers", async () => {
  const sent: { text: string; attachments: Attachment[] }[] = []
  const hosted = host({ stop: { after: 900, phrases: [TAIL] } })
  await reset("c:cancel")
  await mount(composer("c:cancel", sent), async () => {
    await type(field(), "Before")
    await openTake(hosted)

    await click(button("Stop"))
    await click(button("Cancel"))
    await until(async () => Boolean(field()), "the composer is back")
    await new Promise((done) => setTimeout(done, 1200))
    assert.equal(field()?.value, "Before", "the draft is as it was")
    assert.equal(sent.length, 0, "nothing was sent")
    assert.equal(await db.dictations.count(), 0, "a cancelled take keeps nothing")
  })
})

test("a profile hears one take at a time, and the mic is free once it ends", async () => {
  const sent: { text: string; attachments: Attachment[] }[] = []
  const hosted = host({ stop: { after: 50, phrases: [TAIL] } })
  await reset("c:one", "c:two")
  const both = (
    <div>
      <div data-test="one">{composer("c:one", sent)}</div>
      <div data-test="two">{composer("c:two", sent)}</div>
    </div>
  )
  await mount(both, async () => {
    const one = document.querySelector('[data-test="one"]') as HTMLElement
    const two = document.querySelector('[data-test="two"]') as HTMLElement
    await openTake(hosted, one)

    await until(async () => Boolean(button("Voice", two)), "the second composer's microphone")
    await click(button("Voice", two))
    await settle()
    assert.equal(hosted.starts(), 1, "the second take never reached the host")
    assert.equal(bar(two), null, "the second composer never took the bar")
    assert.ok(field(two), "its field is still its own")

    await click(button("Cancel", one))
    await until(async () => !bar(one), "the first take let go")
    await click(button("Voice", two))
    await until(async () => hosted.starts() === 2, "the second take opened")
    await until(async () => barText(two).includes("hello there"), "its words in the bar")
    await click(button("Cancel", two))
    await until(async () => !bar(two), "the second take let go")
  })
})
