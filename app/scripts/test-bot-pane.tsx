import assert from "node:assert/strict"
import test from "node:test"
import { MemoryRouter, Route, Routes, useLocation } from "react-router"

import { AppShell } from "@/components/app-shell"
import { ChatPage } from "@/routes/chat"
import { db, ensureMainThread, mainThreadId } from "@/lib/db"
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
  until,
} from "./component-kit.tsx"

const bot = botProfile("bot-pane", { id: "bot-1", name: "Mainly" })
const other = botProfile("bot-other", { id: "bot-2", name: "Otherly" })
const MAIN = mainThreadId(bot.id)

async function seed(threads: string[] = [], patch: { botThreads?: boolean } = {}) {
  await seedSettings({ developer: true, botThreads: true, activeProfileId: bot.id, ...patch })
  await db.profiles.clear()
  await db.profiles.bulkPut([bot, other])
  await db.messages.clear()
  await db.conversations.clear()
  await db.conversations.bulkPut(
    threads.map((id, index) => ({
      id,
      profileId: bot.id,
      title: `Thread ${id}`,
      titleEdited: true,
      hermesSessionId: `memento-${id}`,
      createdAt: 10 + index,
      updatedAt: 10 + index,
      changedAt: 10,
    })),
  )
  // A thread with nothing said in it is "not started", and its header carries no title at all.
  await db.messages.bulkPut(
    threads.map((id, index) => ({
      id: `${id}-open`,
      conversationId: id,
      role: "user" as const,
      content: `Opened ${id}`,
      status: "done" as const,
      createdAt: 11 + index,
    })),
  )
  await ensureMainThread(bot.id)
  globalThis.fetch = async () => json({})
}

/** A laptop's width: the bot's third pane is `xl`'s, so a test has to say the screen is one. */
const laptop = (body: () => Promise<void>) => async () => {
  const width = window.innerWidth
  window.innerWidth = 1440
  try {
    await body()
  } finally {
    window.innerWidth = width
  }
}

const Where = () => <p data-path>{useLocation().pathname}</p>
const where = () => find("[data-path]")?.textContent ?? ""

const screen = (entry: string) => (
  <MemoryRouter initialEntries={[entry]}>
    <Where />
    <Routes>
      <Route element={<AppShell />}>
        <Route path="c/:id" element={<ChatPage />} />
      </Route>
    </Routes>
  </MemoryRouter>
)

/** Every header on screen, the pane's first and the item beside it second. */
const titles = () => findAll('[data-slot="header-title"]').map((node) => node.textContent)
const remembered = (profileId: string) => localStorage.getItem(`memento:last-thread:${profileId}`)

test(
  "a thread opened for a bot is the one its pane keeps",
  laptop(async () => {
    localStorage.clear()
    await seed(["t-a", "t-b"])
    await mount(screen("/c/t-a"), async () => {
      await until(async () => remembered(bot.id) === "t-a", "the thread this device opened last")
    })
    await mount(screen(`/c/${MAIN}`), async () => {
      await until(async () => titles().includes("Thread t-a"), "the remembered thread beside Main")
      assert.deepEqual(titles(), ["Mainly", "Thread t-a"], "Main is the pane, the thread its item")
    })
  }),
)

test(
  "a remembered thread that is gone leaves the pane closed",
  laptop(async () => {
    localStorage.clear()
    await seed(["t-a"])
    localStorage.setItem(`memento:last-thread:${bot.id}`, "t-gone")
    await mount(screen(`/c/${MAIN}`), async () => {
      await until(async () => text().includes("1 thread"), "Main's own threads to load")
      await settle()
      assert.deepEqual(titles(), ["Mainly"], "Main alone is better than a chat nothing holds")
      assert.equal(
        find('[data-slot="bot-pane-empty"]'),
        null,
        "a bot with threads is not the empty one",
      )
    })
  }),
)

test(
  "another bot's thread is never the one the pane keeps",
  laptop(async () => {
    localStorage.clear()
    await seed(["t-a"])
    await db.conversations.put({
      id: "t-other",
      profileId: other.id,
      title: "Thread t-other",
      hermesSessionId: "memento-t-other",
      createdAt: 30,
      updatedAt: 30,
      changedAt: 30,
    })
    localStorage.setItem(`memento:last-thread:${bot.id}`, "t-other")
    await mount(screen(`/c/${MAIN}`), async () => {
      await until(async () => Boolean(find('[data-slot="thread-card"]')), "the bot's threads")
      assert.deepEqual(titles(), ["Mainly"], "the other bot's thread stays out of this pane")
    })
  }),
)

test(
  "a bot with no threads keeps the pane and says so",
  laptop(async () => {
    localStorage.clear()
    await seed()
    await mount(screen(`/c/${MAIN}`), async () => {
      await until(async () => Boolean(find('[data-slot="bot-pane-empty"]')), "the pane's own line")
      assert.equal(find('[data-slot="bot-pane-empty"]')?.textContent, "No threads yet")
      assert.ok(find('[data-slot="header-row"]'), "Main is still the pane it stands beside")
    })
  }),
)

test(
  "with the switch off a bot is one screen, as it was",
  laptop(async () => {
    localStorage.clear()
    await seed(["t-a", "t-b"], { botThreads: false })
    localStorage.setItem(`memento:last-thread:${bot.id}`, "t-b")
    await mount(screen("/c/t-a"), async () => {
      await until(async () => titles().length === 1, "one screen")
      await settle()
      assert.deepEqual(titles(), ["Thread t-a"], "one chat, and nothing beside it")
    })
  }),
)

test(
  "a thread beside Main carries no control of its own and no picture",
  laptop(async () => {
    localStorage.clear()
    await seed(["t-a"])
    await mount(screen("/c/t-a"), async () => {
      await until(async () => titles().includes("Thread t-a"), "the thread beside Main")
      const [main, thread] = findAll('[data-slot="header-row"]')
      assert.ok(main?.querySelector('[role="img"]'), "Main keeps the bot's picture beside its name")
      assert.equal(thread?.querySelector('[role="img"]'), null, "the thread beside it carries none")
      assert.equal(
        thread?.querySelector('[aria-label="Close thread"]'),
        null,
        "and no close control: the bot is beside it either way",
      )
      assert.equal(
        thread?.querySelector('[aria-label^="Back to"]'),
        null,
        "and no way back, which it doesn't need where its bot is on screen",
      )
      assert.ok(thread?.querySelector('[aria-label="Chat options"]'), "its own menu is still there")
    })
  }),
)

test(
  "the thread beside Main is the card Main marks open, and naming it keeps the pane it is in",
  laptop(async () => {
    localStorage.clear()
    await seed(["t-a", "t-b"])
    localStorage.setItem(`memento:last-thread:${bot.id}`, "t-a")
    const openCards = () => findAll('[data-slot="thread-card"] [aria-current="page"]')
    await mount(screen(`/c/${MAIN}`), async () => {
      await until(async () => titles().includes("Thread t-a"), "the thread beside Main")
      await until(async () => openCards().length === 1, "the card marked open")
      assert.equal(openCards()[0]?.getAttribute("href"), "/c/t-a", "the card of the thread on screen")
      const pane = findAll('[data-slot="header-row"]')[1]

      await click(openCards()[0])
      await until(async () => where() === "/c/t-a", "the address names the thread")
      assert.deepEqual(titles(), ["Mainly", "Thread t-a"], "Main and its thread are both still there")
      assert.equal(
        findAll('[data-slot="header-row"]')[1]?.isSameNode(pane),
        true,
        "the same pane is still on screen: naming the thread it already held drew it again",
      )
    })
  }),
)

test(
  "a card whose thread is already the screen says so and goes nowhere",
  laptop(async () => {
    localStorage.clear()
    await seed(["t-a", "t-b"])
    localStorage.setItem(`memento:last-thread:${bot.id}`, "t-a")
    await mount(screen("/c/t-a"), async () => {
      await until(
        async () => findAll('[data-slot="thread-card"] [aria-current="page"]').length === 1,
        "the card marked open",
      )
      const open = findAll('[data-slot="thread-card"] [aria-current="page"]')[0]

      await click(open)
      assert.equal(where(), "/c/t-a", "the address doesn't move: the thread is the screen")
    })
  }),
)
