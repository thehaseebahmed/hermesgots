import assert from "node:assert/strict"
import test from "node:test"

import { Composer } from "@/components/chat/composer"
import { db, deleteConversation, deleteProfile, type SavedDictation } from "@/lib/db"
import {
  botProfile,
  click,
  connection,
  find,
  findAll,
  json,
  mount,
  seedSettings,
  text,
  until,
} from "./component-kit.tsx"

const CHAT = "c:chat-1"
const DRAFT = "Before after"
const CARET = 7

const config = connection("kept-take")

function host() {
  const clips: Blob[] = []
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname
    if (path.endsWith("/api/plugins/memento/info"))
      return json({
        name: "memento",
        features: ["dictation", "dictation_stream"],
        dictation: { ready: true, model: "base" },
      })
    if (path.endsWith("/api/plugins/memento/dictation") && init?.method === "POST") {
      clips.push(init.body as Blob)
      return json({ object: "memento.dictation", text: "hello there", ms: 700 })
    }
    return json({}, 404)
  }
  globalThis.fetch = fetch as unknown as typeof globalThis.fetch
  return clips
}

async function seed(name: string, patch: Partial<SavedDictation> = {}) {
  await seedSettings()
  await db.profiles.clear()
  await db.profiles.put(botProfile(name))
  await db.drafts.clear()
  await db.dictations.clear()
  await db.drafts.put({ id: CHAT, text: DRAFT, at: 1 })
  await db.dictations.put({
    id: CHAT,
    pieces: [
      { blob: new Blob(["first "], { type: "audio/webm" }), text: null },
      { blob: new Blob(["second"], { type: "audio/webm" }), text: null },
    ],
    at: 1,
    kind: "stream",
    caret: CARET,
    ...patch,
  })
}

const composer = (
  <Composer
    busy={false}
    onSend={() => {}}
    onQueue={() => {}}
    onStop={() => {}}
    onCommand={() => {}}
    connection={config}
    filesAvailable={false}
    imagesAvailable
    draftKey={CHAT}
  />
)

const button = (label: string) =>
  findAll("button").find((one) => one.textContent?.trim() === label) ?? null
const field = () => (find("textarea") as HTMLTextAreaElement | null)?.value

test("a take the app was killed in is offered, and its text lands where it began", async () => {
  await seed("offered")
  const clips = host()
  await mount(composer, async () => {
    assert.match(text(), /hasn't been transcribed yet/, "the bar offers the take")
    assert.equal(find("textarea"), null, "the bar takes the composer's place")

    await click(button("Retry"))
    await until(async () => field() === `Before hello there after`, "the words in the draft")
    assert.equal(clips.length, 1, "one clip asked for")
    assert.equal(await clips[0].text(), "first second", "the slices went as one recording")
    assert.equal(await db.dictations.count(), 0, "its text is in, so nothing is kept")
  })
})

test("a take with its words already had is asked for only for the audio left", async () => {
  await seed("half-done", {
    pieces: [
      { blob: new Blob(["first "], { type: "audio/webm" }), text: "said already" },
      { blob: new Blob(["second"], { type: "audio/webm" }), text: null },
    ],
  })
  const clips = host()
  await mount(composer, async () => {
    await click(button("Retry"))
    await until(async () => field() === `Before said already hello there after`, "the words")
    assert.equal(await clips[0].text(), "second", "only the piece without text is sent")
  })
})

test("discarding a kept take removes it, and leaves the draft as it was", async () => {
  await seed("discarded")
  const clips = host()
  await mount(composer, async () => {
    assert.match(text(), /hasn't been transcribed yet/)
    await click(find('[aria-label="Discard"]'))
    await until(async () => (await db.dictations.count()) === 0, "the take gone from the device")
    assert.equal(field(), DRAFT, "the draft is untouched")
    assert.equal(clips.length, 0, "nothing was sent")
  })
})

test("deleting the chat, or the bot, takes its kept takes with it", async () => {
  await seed("cascade")
  await db.conversations.put({
    id: "chat-1",
    profileId: "bot-1",
    title: "A chat",
    hermesSessionId: "h1",
    createdAt: 1,
    updatedAt: 1,
    changedAt: 1,
  })
  await db.dictations.put({
    id: "new:bot-1",
    pieces: [{ blob: new Blob(["slice"], { type: "audio/webm" }), text: null }],
    at: 1,
    kind: "stream",
  })

  await deleteConversation("chat-1")
  assert.equal(await db.dictations.get(CHAT), undefined, "the chat's kept take goes with it")
  assert.ok(await db.dictations.get("new:bot-1"), "the bot's own take is not the chat's")

  await deleteProfile("bot-1", { last: true })
  assert.equal(await db.dictations.count(), 0, "the bot's kept takes go with it")
})
