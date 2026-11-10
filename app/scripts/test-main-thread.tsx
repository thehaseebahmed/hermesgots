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
  findAll,
  json,
  mount,
  seedSettings,
  settle,
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

test("Main has no Delete, in its menu or in the data layer", async () => {
  await seed()
  globalThis.fetch = async () => json({})
  await mount(
    <MemoryRouter initialEntries={[`/c/${MAIN.id}`]}>
      <Routes>
        <Route path="/c/:id" element={<ChatPage slot="route" />} />
      </Routes>
    </MemoryRouter>,
    async () => {
      await click(find('[aria-label="Chat options"]'))
      await settle()
      const items = findAll('[role="menuitem"]').map((item) => item.textContent)
      assert.ok(items.length > 0, "the chat's own menu opened")
      assert.ok(items.some((label) => label?.includes("Rename")), "a chat's menu, not a bot's")
      assert.ok(!items.some((label) => /Delete|Discard/.test(label ?? "")))
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
