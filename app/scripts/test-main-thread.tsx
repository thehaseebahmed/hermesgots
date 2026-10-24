import assert from "node:assert/strict"
import test from "node:test"
import { MemoryRouter, Route, Routes } from "react-router"

import { ChatPage } from "@/routes/chat"
import { BotThreadsPage } from "@/routes/bot-threads"
import { db, deleteConversation, ensureMainThread, mainThreadId } from "@/lib/db"
import { useThreads } from "@/lib/threads"
import {
  botProfile,
  click,
  find,
  findAll,
  json,
  mount,
  seedSettings,
  settle,
  until,
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
      <Route path="c/:id" element={<ChatPage slot="route" />} />
    </Routes>
  </MemoryRouter>
)

test("the bot's old address opens Main, which is made once", async () => {
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

test("a Main row that lost its flag is healed, not left reading as a thread", async () => {
  await seed()
  const id = mainThreadId(bot.id)
  await db.conversations.put({
    id,
    profileId: bot.id,
    title: "Main",
    titleEdited: true,
    hermesSessionId: `memento-${id}`,
    createdAt: 5,
    updatedAt: 5,
    changedAt: 5,
  })
  const healed = await ensureMainThread(bot.id)
  assert.equal(healed.main, true, "the returned row carries the flag")
  assert.equal((await db.conversations.get(id))?.main, true, "and so does the stored one")
  const again = await ensureMainThread(bot.id)
  assert.equal(again.changedAt, healed.changedAt, "a healed row is not written again")
})

function ThreadNames({ profileId }: { profileId: string }) {
  const threads = useThreads(profileId)
  return (
    <p data-threads>{threads?.map((one) => (one.chat.main ? "Main" : one.chat.title)).join("|")}</p>
  )
}

const threadsShown = () => document.querySelector("[data-threads]")?.textContent ?? ""

test("a bot's chats are its threads, Main first, and project sessions are not", async () => {
  await seed([{ id: "c1" }, { id: "s1", projectId: "p" }])
  await ensureMainThread(bot.id)
  await mount(
    <MemoryRouter>
      <ThreadNames profileId={bot.id} />
    </MemoryRouter>,
    async () => {
      await until(async () => threadsShown().includes("Chat c1"), "the bot's threads")
      assert.ok(threadsShown().startsWith("Main"), "Main comes first")
      assert.ok(!threadsShown().includes("A session"), "a project session is not a thread")
    },
  )
})

test("Main has no Delete or Discard, in its menu or in the data layer", async () => {
  await seed()
  await ensureMainThread(bot.id)
  const id = mainThreadId(bot.id)
  globalThis.fetch = async () => json({})
  await mount(
    <MemoryRouter initialEntries={[`/c/${id}`]}>
      <Routes>
        <Route path="/c/:id" element={<ChatPage slot="route" />} />
      </Routes>
    </MemoryRouter>,
    async () => {
      await click(find('[aria-label="Bot options"]'))
      await settle()
      const items = findAll('[role="menuitem"]').map((item) => item.textContent)
      assert.ok(
        items.some((label) => label?.includes("Bot settings")),
        "the menu opened",
      )
      assert.ok(!items.some((label) => /Delete|Discard/.test(label ?? "")))
    },
  )
  await deleteConversation(id)
  assert.ok(await db.conversations.get(id), "a local delete leaves it")
  await deleteConversation(id, { remote: true })
  assert.equal(await db.conversations.get(id), undefined, "another device's delete still applies")
})
