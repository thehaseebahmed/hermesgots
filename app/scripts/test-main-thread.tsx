/**
 * A bot's Main as the record keeps it now (G1): a chat like any other, with two things of its own —
 * it cannot be deleted from this device, and it is titled with its own name rather than its bot's.
 * Nothing makes one any more, so nothing here asks for one to be made.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { MemoryRouter, Route, Routes } from "react-router"

import { ChatPage } from "@/routes/chat"
import { db, deleteConversation, type Conversation } from "@/lib/db"

import {
  botProfile,
  click,
  find,
  findText,
  json,
  mount,
  seedSettings,
  settle,
  until,
} from "./component-kit.tsx"

const bot = botProfile("main-thread", { id: "bot-1", name: "Mainly" })

const MAIN: Conversation = {
  id: "main-bot-1",
  profileId: bot.id,
  title: "Main",
  titleEdited: true,
  main: true,
  hermesSessionId: "gots-main-bot-1",
  createdAt: 10,
  updatedAt: 10,
  changedAt: 10,
}

async function seed() {
  await seedSettings({ developer: true, activeProfileId: bot.id })
  await db.profiles.clear()
  await db.profiles.put(bot)
  await db.messages.clear()
  await db.conversations.clear()
  await db.conversations.put(MAIN)
}

test("a Main is titled with its own name, not its bot's", async () => {
  await seed()
  globalThis.fetch = async () => json({})
  await mount(
    <MemoryRouter initialEntries={[`/c/${MAIN.id}`]}>
      <Routes>
        <Route path="/c/:id" element={<ChatPage slot="route" />} />
      </Routes>
    </MemoryRouter>,
    async () => {
      await settle()
      assert.equal(
        find('[data-slot="header-title"]')?.textContent,
        "Main",
        "the name its record carries",
      )
    },
  )
})

test("Main has no Delete, in its settings or in the data layer", async () => {
  await seed()
  globalThis.fetch = async () => json({})
  await mount(
    <MemoryRouter initialEntries={[`/c/${MAIN.id}`]}>
      <Routes>
        <Route path="/c/:id" element={<ChatPage slot="route" />} />
      </Routes>
    </MemoryRouter>,
    async () => {
      await until(async () => Boolean(find("[data-chat-settings-open]")), "the bar's title")
      await click(find("[data-chat-settings-open]"))
      await settle()
      assert.ok(find("[data-chat-name]"), "the chat's own settings opened")
      assert.ok(!findText("button", "Delete chat"), "with no way to delete a Main among them")
    },
  )
  await deleteConversation(MAIN.id)
  assert.ok(await db.conversations.get(MAIN.id), "a local delete leaves it")
  await deleteConversation(MAIN.id, { remote: true })
  assert.equal(
    await db.conversations.get(MAIN.id),
    undefined,
    "another device's delete still applies",
  )
})
