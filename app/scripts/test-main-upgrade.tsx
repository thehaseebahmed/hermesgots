/**
 * A device that kept a Main from before this build: the `main-*` record an older build wrote loses
 * the flag and stays as an ordinary side chat, history and all. Main is the host's Bot Chat now,
 * resolved and published by the plugin, so a record left claiming the flag would be a second Main —
 * one the list would hide from the reader and no surface could mark — while the conversation it holds
 * is still theirs to read.
 *
 * The database is opened as a build before this one left it, and the app's own schema upgrades it
 * (the shape `test-chat-filter-upgrade.tsx` uses).
 */
import assert from "node:assert/strict"
import test from "node:test"
import Dexie from "dexie"

import { db } from "@/lib/db"

/** The database the app opens, with the rows a v49 build left: a Main and a chat beside it. */
async function asLeftByThePreviousBuild() {
  const before = new Dexie("gots")
  before.version(49).stores({
    settings: "id",
    profiles: "id, createdAt",
    conversations: "id, updatedAt, [profileId+updatedAt]",
    messages: "id, conversationId, [conversationId+createdAt]",
  })
  await before.open()
  await before.table("profiles").put({ id: "bot-1", name: "One", createdAt: 1, updatedAt: 1 })
  await before.table("settings").put({ id: "settings" })
  await before.table("conversations").bulkPut([
    {
      id: "main-bot-1",
      profileId: "bot-1",
      title: "Main",
      main: true,
      createdAt: 1,
      updatedAt: 9,
      changedAt: 9,
    },
    { id: "c-1", profileId: "bot-1", title: "A chat", createdAt: 1, updatedAt: 5, changedAt: 5 },
  ])
  await before.table("messages").bulkPut([
    { id: "m-1", conversationId: "main-bot-1", role: "user", content: "what we said", createdAt: 2 },
    { id: "m-2", conversationId: "main-bot-1", role: "assistant", content: "what I said", createdAt: 3 },
  ])
  before.close()
}

test("an older build's main-* record keeps its history and loses the flag", async () => {
  await asLeftByThePreviousBuild()
  // The app's own open runs the upgrade the app ships.
  await db.open()
  const main = await db.conversations.get("main-bot-1")
  assert.ok(main, "the record is still here, as the side chat it now is")
  assert.equal(main.main, undefined, "and no longer claims to be the bot's Main")
  assert.equal(main.title, "Main", "nothing else about the row moved")
  assert.equal(main.profileId, "bot-1", "nor which bot lists it")
  assert.deepEqual(
    (await db.messages.where("conversationId").equals("main-bot-1").toArray()).map(
      (message) => message.content,
    ),
    ["what we said", "what I said"],
    "its history came through the upgrade",
  )
  assert.equal((await db.conversations.get("c-1"))?.main, undefined, "and no other record was touched")
})
