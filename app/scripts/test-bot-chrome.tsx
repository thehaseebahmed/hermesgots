import assert from "node:assert/strict"
import test from "node:test"
import { MemoryRouter, Route, Routes } from "react-router"

import { ConversationList } from "@/components/conversation-list"
import { ChatPage } from "@/routes/chat"
import { db, ensureMainThread, mainThreadId, type Message } from "@/lib/db"
import { formatRelative } from "@/lib/format"
import {
  botProfile,
  click,
  find,
  findAll,
  findText,
  json,
  mount,
  Path,
  path,
  seedSettings,
  settle,
  text,
  until,
} from "./component-kit.tsx"

const bot = botProfile("bot-chrome", { id: "bot-1", name: "Chrome" })
const other = botProfile("bot-other", { id: "bot-2", name: "Other" })
const MAIN = mainThreadId(bot.id)
const HOUR = 3_600_000

const msg = (
  id: string,
  conversationId: string,
  role: Message["role"],
  content: string,
  createdAt: number,
): Message => ({ id, conversationId, role, content, status: "done", createdAt })

async function seedMain() {
  await seedSettings({ developer: true, botThreads: true, activeProfileId: bot.id })
  await db.profiles.clear()
  await db.profiles.put(bot)
  await db.messages.clear()
  await db.conversations.clear()
  await ensureMainThread(bot.id)
  await db.conversations.bulkPut(
    ["t-a", "t-b"].map((id, index) => ({
      id,
      profileId: bot.id,
      title: `Thread ${id}`,
      hermesSessionId: `memento-${id}`,
      createdAt: 10 + index,
      updatedAt: 10 + index,
      changedAt: 0,
    })),
  )
}

const mainScreen = (
  <MemoryRouter initialEntries={[`/c/${MAIN}`]}>
    <Routes>
      <Route
        path="/c/:id"
        element={
          <>
            <ChatPage slot="route" />
            <Path />
          </>
        }
      />
      <Route path="/settings/bots" element={<Path />} />
    </Routes>
  </MemoryRouter>
)

const headerLine = () => find('[data-slot="header-line"]')?.textContent
const menuItems = () => findAll('[role="menuitem"]').map((item) => item.textContent?.trim() ?? "")

test("Main's header is the bot's face: the bot's name, its thread count, and the bot's menu", async () => {
  await seedMain()
  globalThis.fetch = async () => json({})
  await mount(mainScreen, async () => {
    assert.equal(
      find('[data-slot="header-title"]')?.textContent,
      "Chrome",
      'the title is the bot\'s name, not the "Main" its record is stored under',
    )
    assert.equal(headerLine(), "2 threads", "the bot's threads, Main not counted as one")

    await click(find('[aria-label="Bot options"]'))
    await settle()
    const items = menuItems()
    assert.ok(items.includes("Mute notifications"), "the bot can be muted from here")
    assert.ok(items.includes("Bot settings"), "and its settings opened")
    assert.ok(
      !items.includes("Rename"),
      "its name is edited in Bot settings, so Main is never renamed from here",
    )
    assert.ok(!items.includes("Context"), "and Main carries no reading of the context window")
    assert.ok(
      !items.some((label) => /Delete|Discard/.test(label)),
      "but a bot's Main is never deleted or discarded",
    )
  })
})

test("mute from Main's menu mutes the bot, and Main's header reads it back", async () => {
  await seedMain()
  globalThis.fetch = async () => json({})
  await mount(mainScreen, async () => {
    await click(find('[aria-label="Bot options"]'))
    await click(findText('[role="menuitem"]', "Mute notifications"))
    await until(async () => Boolean((await db.profiles.get(bot.id))?.muted), "the bot's mute")

    assert.ok(find('[data-slot="header-middle"] [aria-label="Muted"]'), "the header marks it")
    await click(find('[aria-label="Bot options"]'))
    assert.ok(menuItems().includes("Unmute notifications"), "and offers to undo it")
  })
})

test("Bot settings from Main's menu opens the bots screen", async () => {
  await seedMain()
  globalThis.fetch = async () => json({})
  await mount(mainScreen, async () => {
    await click(find('[aria-label="Bot options"]'))
    await click(findText('[role="menuitem"]', "Bot settings"))
    await until(async () => path() === "/settings/bots", "the bots screen")
  })
})

async function seedSidebar() {
  const now = Date.now()
  await seedSettings({ developer: true, botThreads: true, activeProfileId: bot.id })
  await db.profiles.clear()
  await db.profiles.bulkPut([bot, other])
  await db.messages.clear()
  await db.conversations.clear()

  await ensureMainThread(bot.id)
  await db.conversations.update(MAIN, { updatedAt: now - 5 * HOUR })
  await db.conversations.put({
    id: "t-newer",
    profileId: bot.id,
    title: "A newer thread",
    hermesSessionId: "memento-t-newer",
    createdAt: now - 2 * HOUR,
    updatedAt: now - 60_000,
    changedAt: 0,
  })
  await db.messages.bulkPut([
    msg("m-1", MAIN, "user", "The last thing said in Main", now - 5 * HOUR),
    msg("t-1", "t-newer", "user", "A newer thread's opener", now - 2 * HOUR),
  ])
  await db.conversations.put({
    id: "o-1",
    profileId: other.id,
    title: "Its only thread",
    hermesSessionId: "memento-o-1",
    createdAt: now - HOUR,
    updatedAt: now - HOUR,
    changedAt: 0,
  })
  return now
}

const row = (botId: string) =>
  findAll("a").find((one) => one.getAttribute("href") === `/c/main-${botId}`) ?? null

test("the sidebar's bot row previews Main's latest line, not its newest thread's", async () => {
  const now = await seedSidebar()
  globalThis.fetch = async () => json({})
  await mount(
    <MemoryRouter initialEntries={["/"]}>
      <ConversationList />
    </MemoryRouter>,
    async () => {
      await until(async () => Boolean(row(bot.id)), "the bot row")
      const line = row(bot.id)?.textContent ?? ""
      assert.ok(line.includes("The last thing said in Main"), "what Main last said")
      assert.ok(!line.includes("A newer thread"), "not the newest thread's title")
      assert.ok(
        line.includes(formatRelative(now - 5 * HOUR, Date.now())),
        "aged by Main, since Main is what it opens",
      )
    },
  )
})

test("a bot never opened still previews its newest thread", async () => {
  await seedSidebar()
  globalThis.fetch = async () => json({})
  await mount(
    <MemoryRouter initialEntries={["/"]}>
      <ConversationList />
    </MemoryRouter>,
    async () => {
      await until(async () => Boolean(row(other.id)), "the other bot's row")
      assert.ok((row(other.id)?.textContent ?? "").includes("Its only thread"))
      assert.ok(!text().includes("A newer thread"), "no thread title leaks into another row")
    },
  )
})
