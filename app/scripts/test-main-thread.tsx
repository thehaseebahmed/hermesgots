/**
 * A bot's Main thread, over a seeded device database: made once on its screen's first open, one
 * record however often or from wherever it is asked for, led with in the list while project
 * sessions stay out, and with no Delete or Discard in its menu or in the data layer.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { MemoryRouter, Route, Routes } from "react-router"

import { ChatPage } from "@/routes/chat"
import { BotThreadsPage } from "@/routes/bot-threads"
import { db, deleteConversation, ensureMainThread, mainThreadId } from "@/lib/db"
import {
  botProfile,
  click,
  find,
  findAll,
  json,
  mount,
  seedSettings,
  settle,
  text,
} from "./component-kit.tsx"

const bot = botProfile("main-thread", { id: "bot-1", name: "Mainly" })

async function seed(chats: { id: string; projectId?: string }[] = []) {
  await seedSettings({ developer: true, botThreads: true })
  await db.profiles.clear()
  await db.profiles.put(bot)
  await db.messages.clear()
  await db.conversations.clear()
  await db.conversations.bulkPut(
    chats.map(({ id, projectId }) => ({
      id,
      profileId: bot.id,
      title: projectId ? "A session" : `Chat ${id}`,
      hermesSessionId: `${id}-hermes`,
      projectId,
      createdAt: 10,
      updatedAt: 10,
      changedAt: 10,
    })),
  )
}

const botScreen = (
  <MemoryRouter initialEntries={["/b/bot-1"]}>
    <Routes>
      <Route path="b/:profileId" element={<BotThreadsPage />} />
    </Routes>
  </MemoryRouter>
)

test("opening the bot's screen makes its Main thread once", async () => {
  await seed()
  globalThis.fetch = async () => json({})
  await mount(botScreen, async () => {
    const mains = await db.conversations.filter((c) => Boolean(c.main)).toArray()
    assert.equal(mains.length, 1)
    assert.equal(mains[0].id, mainThreadId(bot.id))
    assert.equal(mains[0].changedAt, 0, "an empty copy never wins a merge over a synced one")
  })
  await mount(botScreen, async () => {
    assert.equal(await db.conversations.count(), 1, "a second visit makes no second one")
  })
})

test("asking from two places yields one record, and a synced one is kept", async () => {
  await seed()
  const [a, b] = await Promise.all([ensureMainThread(bot.id), ensureMainThread(bot.id)])
  assert.equal(a.id, b.id)
  assert.equal(await db.conversations.count(), 1)
  await db.conversations.update(a.id, { title: "Renamed elsewhere", changedAt: 99 })
  assert.equal((await ensureMainThread(bot.id)).title, "Renamed elsewhere")
})

test("Main leads the list, chats are threads beside it and sessions are not", async () => {
  await seed([{ id: "c1" }, { id: "s1", projectId: "p" }])
  await mount(botScreen, async () => {
    const shown = text()
    assert.ok(shown.includes("Chat c1"), "an existing chat shows as a thread")
    assert.ok(!shown.includes("A session"), "a project session does not")
    assert.ok(shown.indexOf("Main") < shown.indexOf("Chat c1"), "Main comes first")
  })
})

test("Main has no Delete or Discard, in its menu or in the data layer", async () => {
  await seed()
  await ensureMainThread(bot.id)
  const id = mainThreadId(bot.id)
  globalThis.fetch = async () => json({})
  await mount(
    <MemoryRouter initialEntries={[`/c/${id}`]}>
      <Routes>
        <Route path="/c/:id" element={<ChatPage />} />
      </Routes>
    </MemoryRouter>,
    async () => {
      await click(find('[aria-label="Chat options"]'))
      await settle()
      const items = findAll('[role="menuitem"]').map((item) => item.textContent)
      assert.ok(items.some((label) => label?.includes("Rename")), "the menu opened")
      assert.ok(!items.some((label) => /Delete|Discard/.test(label ?? "")))
    },
  )
  await deleteConversation(id)
  assert.ok(await db.conversations.get(id), "a local delete leaves it")
  await deleteConversation(id, { remote: true })
  assert.equal(await db.conversations.get(id), undefined, "another device's delete still applies")
})
