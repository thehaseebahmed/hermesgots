/**
 * A take the Bubble heard with nowhere to put it comes back to the app.
 *
 * The phone keeps the words — the service cannot write a **Dictation**, the page does — so the next
 * time the app opens they are drained and written to the log. That is what the toast promising "this
 * take is saved in Gots" is promising, so it is worth a test rather than a comment.
 */
import { bubbleKept } from "./android-bridge.ts"
import assert from "node:assert/strict"
import test from "node:test"

const { collectTakeaways } = await import("@/lib/bubble")
const { connectionKey } = await import("@/lib/connection")
const { db } = await import("@/lib/db")
const { botProfile, seedSettings } = await import("./component-kit.tsx")

async function seed() {
  await seedSettings({ activeProfileId: "bot-1" })
  await db.profiles.clear()
  await db.dictationLog.clear()
  await db.profiles.put(botProfile("A bot", { id: "bot-1", name: "A bot", apiKey: "key-1" }))
  bubbleKept.length = 0
  globalThis.fetch = (async () =>
    new Response("{}", { status: 404 })) as unknown as typeof globalThis.fetch
}

test("a take the phone could not type lands in the log, under the bot that heard it", async () => {
  await seed()
  bubbleKept.push({
    id: "kept-1",
    at: Date.parse("2026-11-05T07:30:00Z"),
    profileId: "bot-1",
    text: "Send the invoice on Friday",
    heard: "send the invoice on friday",
    ms: 2_400,
    level: "light",
    cleaned: true,
    provider: "local",
    model: "base",
  })

  await collectTakeaways()

  const rows = await db.dictationLog.toArray()
  assert.equal(rows.length, 1, "one take, one row")
  assert.equal(rows[0].text, "Send the invoice on Friday", "the tidied words are what the log keeps")
  assert.equal(rows[0].heard, "send the invoice on friday", "with what was heard beside them")
  assert.equal(rows[0].ms, 2_400)
  assert.equal(rows[0].connection, connectionKey(botProfile("A bot", { apiKey: "key-1" })))
  assert.equal(bubbleKept.length, 0, "and the phone hands each take over once")
})

test("a hand-over with no kept takes writes nothing", async () => {
  await seed()
  await collectTakeaways()
  assert.equal((await db.dictationLog.toArray()).length, 0)
})

test("a take for a bot this device no longer has is dropped, not written under another", async () => {
  await seed()
  bubbleKept.push({
    id: "kept-2",
    at: Date.now(),
    profileId: "bot-gone",
    text: "Somewhere else",
    heard: "somewhere else",
    ms: 900,
  })
  await collectTakeaways()
  assert.equal((await db.dictationLog.toArray()).length, 0, "no bot to attribute it to")
  assert.equal(bubbleKept.length, 0, "and the phone is not left holding it forever")
})
