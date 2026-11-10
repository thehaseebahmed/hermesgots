import assert from "node:assert/strict"
import test from "node:test"
import { MemoryRouter, Route, Routes } from "react-router"

import { AppShell } from "@/components/app-shell"
import { db } from "@/lib/db"
import { BotChatsPage } from "@/routes/bot-chats"
import { ChatPage } from "@/routes/chat"
import {
  atWidth,
  botProfile,
  click,
  find,
  findAll,
  json,
  laptop,
  missing,
  mount,
  Path,
  path,
  seedSettings,
  settle,
  until,
} from "./component-kit.tsx"

const bot = botProfile("bot-chats-pane", { id: "bot-1", name: "Mainly" })
const MAIN = "main-bot-1"
/** The bot's chats, and a project session of its own that is Code's and no row of its list. */
const CHATS = [
  { id: "c-a", title: "Alpha", at: 13 },
  { id: "c-b", title: "Beta", at: 12 },
]

/**
 * A bot of two chats and a project session: settings answering the bot-first layout, and one message
 * in each chat, which is what a row's line and its time are read from.
 */
async function seed({ collapsed = false } = {}) {
  await seedSettings({ activeProfileId: bot.id, sidebarCollapsed: collapsed })
  await db.profiles.clear()
  await db.profiles.put(bot)
  await db.messages.clear()
  await db.conversations.clear()
  await db.conversations.put({
    id: MAIN,
    profileId: bot.id,
    title: "Main",
    titleEdited: true,
    main: true,
    hermesSessionId: `gots-${MAIN}`,
    createdAt: 1,
    updatedAt: 1,
    changedAt: 0,
  })
  await db.conversations.bulkPut([
    ...CHATS.map((chat) => ({
      id: chat.id,
      profileId: bot.id,
      title: chat.title,
      titleEdited: true,
      hermesSessionId: `gots-${chat.id}`,
      createdAt: chat.at - 2,
      updatedAt: chat.at,
      changedAt: chat.at,
    })),
    {
      id: "s-1",
      profileId: bot.id,
      title: "A session",
      hermesSessionId: "gots-s-1",
      projectId: "p-1",
      createdAt: 5,
      updatedAt: 6,
      changedAt: 6,
    },
  ])
  await db.messages.bulkPut(
    CHATS.map((chat) => ({
      id: `${chat.id}-said`,
      conversationId: chat.id,
      role: "user" as const,
      content: `${chat.title}, said`,
      status: "done" as const,
      createdAt: chat.at - 1,
    })),
  )
  globalThis.fetch = async () => json({})
}

/**
 * The shell over the two addresses a bot has: its own list, and a chat of it. A chat is one
 * address for every screen — a bot's chat, a project session, a canvas — so which pane it opens is
 * the shell's to decide and this test's to read.
 */
const screen = (entry: string) => (
  <MemoryRouter initialEntries={[entry]}>
    <Path />
    <Routes>
      <Route element={<AppShell />}>
        <Route path="b/:profileId" element={<BotChatsPage />} />
        <Route path="c/:id" element={<ChatPage slot="route" />} />
      </Route>
    </Routes>
  </MemoryRouter>
)

/** A pane fades its predecessor out over it (`PaneTransition` marks the copy `inert`), so only the
 * live headers are read. */
const live = (node: Element) => node.closest('[aria-hidden="true"]') === null
const titles = () =>
  findAll('[data-slot="header-title"]')
    .filter(live)
    .map((node) => node.textContent?.trim() ?? "")
/** The rows of the bot's list: its chats, as links out of the list's own `<ul>`. */
const listRows = () =>
  findAll('[data-slot="list-lane"] ul a[href^="/c/"]').map((row) => row.getAttribute("href") ?? "")
/** The row of the chat the pane holds, as the list marks it. */
const openRow = () => find(OPEN_ROW)
const laneClass = () => find('[data-slot="list-lane"]')?.getAttribute("class") ?? ""
const LANE = '[data-slot="list-lane"]'
const CHAT_BESIDE = '[data-slot="item-lane"] [data-slot="chat-pane"]'
const BACK_TO_BOT = 'button[aria-label="Back to Mainly"]'
const OPEN_ROW = '[data-slot="list-lane"] ul a[aria-current="page"]'

test(
  "a bot's list keeps its 412px lane beside the chat it opened, on a laptop",
  laptop(async () => {
    localStorage.clear()
    await seed()
    await mount(screen("/c/c-a"), async () => {
      await until(async () => titles().includes("Alpha"), "the chat's own header")
      assert.equal(missing(LANE), false, "the shell keeps the bot's list on screen")
      assert.match(laneClass(), /\bw-103\b/, "at the 412px lane every list of the app's keeps")
      assert.deepEqual(
        listRows().sort(),
        [
          `/c/${MAIN}`,
          ...CHATS.map((chat) => `/c/${chat.id}`),
        ].sort(),
        "every one of the bot's chats is a row of it",
      )
      assert.equal(
        findAll('[data-slot="list-lane"] [data-slot="chat-pane"]').length,
        0,
        "and no chat is drawn in the list's lane",
      )
      assert.equal(missing(CHAT_BESIDE), false, "the chat stands in the pane beside it")
      assert.equal(
        openRow()?.getAttribute("href"),
        "/c/c-a",
        "the row of the chat on screen is the one the list marks open",
      )
      assert.equal(
        missing(BACK_TO_BOT),
        true,
        "and the chat carries no way back: the list is beside it",
      )
    })
  }),
)

test(
  "with the sidebar a rail at 1024px the list is still beside the chat",
  atWidth(1024, async () => {
    localStorage.clear()
    await seed({ collapsed: true })
    await mount(screen("/c/c-b"), async () => {
      await until(async () => titles().includes("Beta"), "the chat's own header")
      assert.match(laneClass(), /\bw-103\b/, "the list keeps the 412px lane a rail leaves room for")
      assert.equal(openRow()?.getAttribute("href"), "/c/c-b", "and marks the chat the address names")
      assert.equal(missing(BACK_TO_BOT), true, "the chat has nothing to go back to")
    })
  }),
)

test(
  "with the sidebar open at 1024px the list is a screen the chat pushes",
  atWidth(1024, async () => {
    localStorage.clear()
    await seed()
    await mount(screen("/c/c-a"), async () => {
      await until(async () => titles().includes("Alpha"), "the chat's own header")
      assert.equal(missing(LANE), true, "no list stands beside it")
      assert.equal(
        missing(BACK_TO_BOT),
        false,
        "and the chat is a screen of its own, leading back to the list",
      )
    })
  }),
)

test(
  "a phone shows the bot's list as the screen its chat pushes",
  atWidth(390, async () => {
    localStorage.clear()
    await seed()
    await mount(screen("/c/c-a"), async () => {
      await until(async () => titles().includes("Alpha"), "the chat's own header")
      assert.equal(missing(LANE), true, "no list stands beside it")
      assert.equal(missing(BACK_TO_BOT), false, "and the chat leads back to it")
    })
  }),
)

test(
  "a bot's own screen opens with nothing selected beside the list",
  laptop(async () => {
    localStorage.clear()
    await seed()
    await mount(screen(`/b/${bot.id}`), async () => {
      await until(async () => listRows().length === CHATS.length + 1, "the bot's chats in its list")
      assert.equal(missing(CHAT_BESIDE), true, "no chat is drawn beside the list")
      assert.equal(missing(OPEN_ROW), true, "and no row is marked open")
      assert.equal(
        missing('[data-slot="bot-chats-empty"]'),
        false,
        "the lane beside the list says there is nothing open in it",
      )
    })
  }),
)

test(
  "the list marks the chat its address names, and keeps its lane across the switch",
  laptop(async () => {
    localStorage.clear()
    await seed()
    await mount(screen("/c/c-a"), async () => {
      await until(
        async () => openRow()?.getAttribute("href") === "/c/c-a",
        "the open chat's row",
      )
      await click(find('[data-slot="list-lane"] ul a[href="/c/c-b"]'))
      await until(async () => path() === "/c/c-b", "the address to name the chat")
      await until(
        async () => openRow()?.getAttribute("href") === "/c/c-b",
        "the row of the chat now on screen",
      )
      assert.equal(missing(CHAT_BESIDE), false, "the chat still stands beside the list")
      assert.match(laneClass(), /\bw-103\b/, "and the list keeps its lane through the switch")
    })
  }),
)

test(
  "a project session opens Code's list, never the list of the bot that holds its record",
  laptop(async () => {
    localStorage.clear()
    await seed()
    await mount(screen("/c/s-1"), async () => {
      await until(async () => find('[data-slot="list-lane"]') !== null, "a list beside the session")
      await settle()
      assert.equal(
        listRows().includes(`/c/${CHATS[0].id}`),
        false,
        "the bot's own chats are no rows of the list drawn beside a session",
      )
      assert.equal(
        missing('[data-slot="bot-chats-empty"]'),
        true,
        "and the bot's screen is not the pane a session opens",
      )
    })
  }),
)
