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
  mount,
  seedSettings,
  text,
  until,
} from "./component-kit.tsx"
import { dictationHost } from "./fake-dictation.ts"

const CHAT = "c:chat-1"
const DRAFT = "Before after"
const CARET = 7

const config = connection("kept-take")

const host = () => dictationHost({ heard: "hello there" })

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
      { blob: new Blob(["first "], { type: "audio/webm" }) },
      { blob: new Blob(["second"], { type: "audio/webm" }) },
    ],
    at: 1,
    kind: "pieces",
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
    files="unknown"
    imagesAvailable
    draftKey={CHAT}
  />
)

const button = (label: string) =>
  findAll("button").find((one) => one.textContent?.trim() === label) ?? null
const field = () => (find("textarea") as HTMLTextAreaElement | null)?.value

test("a take the app was killed in is offered, and its text lands where it began", async () => {
  await seed("offered")
  const hosted = host()
  await mount(composer, async () => {
    assert.match(text(), /hasn't been transcribed yet/, "the bar offers the take")
    assert.equal(find("textarea"), null, "the bar takes the composer's place")

    await click(button("Retry"))
    await until(async () => field() === `Before hello there after`, "the words in the draft")
    assert.equal(hosted.pieces().length, 2, "every Piece the device holds goes up again")
    assert.deepEqual(
      hosted.pieces().map((one) => one.index),
      [0, 1],
      "in the order they were recorded",
    )
    assert.equal(
      await (hosted.pieces()[0].body as Blob).text(),
      "first ",
      "each Piece is the audio it was recorded as",
    )
    assert.equal(await db.dictations.count(), 0, "its text is in, so nothing is kept")
  })
})

test("a kept take is sent under a Take id of its own", async () => {
  await seed("kept")
  const hosted = host()
  await mount(composer, async () => {
    await click(button("Retry"))
    await until(async () => field() === `Before hello there after`, "the words")
    assert.equal(hosted.pieces().length, 2, "both Pieces went up")
    assert.match(
      hosted.pieces()[0].take ?? "",
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      "a take restored after a reload mints its own id",
    )
    assert.equal(
      new Set(hosted.pieces().map((one) => one.take)).size,
      1,
      "and every Piece of it names the same take",
    )
  })
})

test("discarding a kept take removes it, and leaves the draft as it was", async () => {
  await seed("discarded")
  const hosted = host()
  await mount(composer, async () => {
    assert.match(text(), /hasn't been transcribed yet/)
    await click(find('[aria-label="Discard"]'))
    await until(async () => (await db.dictations.count()) === 0, "the take gone from the device")
    assert.equal(field(), DRAFT, "the draft is untouched")
    assert.equal(hosted.pieces().length, 0, "nothing was sent")
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
    pieces: [{ blob: new Blob(["slice"], { type: "audio/webm" }) }],
    at: 1,
    kind: "pieces",
  })

  await deleteConversation("chat-1")
  assert.equal(await db.dictations.get(CHAT), undefined, "the chat's kept take goes with it")
  assert.ok(await db.dictations.get("new:bot-1"), "the bot's own take is not the chat's")

  await deleteProfile("bot-1", { last: true })
  assert.equal(await db.dictations.count(), 0, "the bot's kept takes go with it")
})
