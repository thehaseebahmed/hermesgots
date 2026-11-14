import assert from "node:assert/strict"
import test from "node:test"
import { MemoryRouter, Route, Routes } from "react-router"

import { AppShell } from "@/components/app-shell"
import { db } from "@/lib/db"
import { forgetRead, markRead } from "@/lib/read-marks"
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
const screen = (entry: string | { pathname: string; state?: unknown }) => (
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
const LIST_CONTROL = 'a[aria-label="Chats with Mainly"]'
const DRAWER = 'button[aria-label="Open conversations"]'
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
      assert.ok(
        find(`[data-slot="header-actions"] ${BACK_TO_BOT}`),
        "and the chat's bar carries its way back to the bot's list in its corner",
      )
      assert.equal(
        missing(`[data-slot="header-leading"] ${BACK_TO_BOT}`),
        true,
        "in the corner alone: the left of the bar still leads with the app's menu",
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
      assert.ok(
        find(`[data-slot="header-actions"] ${BACK_TO_BOT}`),
        "the chat's corner carries its way back, the list beside it or not",
      )
      assert.equal(missing(LIST_CONTROL), true, "and no way to it in the bar: it stands on screen beside")
    })
  }),
)

test(
  "with the sidebar open at 1024px the chat stands alone, its bar leading with the drawer",
  atWidth(1024, async () => {
    localStorage.clear()
    await seed()
    await mount(screen("/c/c-a"), async () => {
      await until(async () => titles().includes("Alpha"), "the chat's own header")
      assert.equal(missing(LANE), true, "no list stands beside it")
      assert.ok(
        find(`[data-slot="header-actions"] ${BACK_TO_BOT}`),
        "and the chat leads with a control, its way back standing in the corner",
      )
      assert.match(
        find(DRAWER)?.getAttribute("class") ?? "",
        /\bmd:hidden\b/,
        "the drawer's own control leads instead, hidden from md up where the sidebar is the menu",
      )
    })
  }),
)

test(
  "a phone draws the chat alone, its bar leading with the drawer",
  atWidth(390, async () => {
    localStorage.clear()
    await seed()
    await mount(screen("/c/c-a"), async () => {
      await until(async () => titles().includes("Alpha"), "the chat's own header")
      assert.equal(missing(LANE), true, "no list stands beside it")
      assert.equal(missing(DRAWER), false, "and the bar leads with the drawer's own control")
      assert.ok(
        find(`[data-slot="header-actions"] ${BACK_TO_BOT}`),
        "with its way back to the list in the corner",
      )
    })
  }),
)

test(
  "a phone's chat's corner carries its way back and its context, no menu: the title is its settings",
  atWidth(390, async () => {
    localStorage.clear()
    await seed()
    await mount(screen("/c/c-a"), async () => {
      await until(async () => titles().includes("Alpha"), "the chat's own header")
      assert.equal(missing(LIST_CONTROL), true, "no separate control opens the bot's chats from the bar")
      assert.deepEqual(
        findAll('[data-slot="header-actions"] a, [data-slot="header-actions"] button').map(
          (node) => node.getAttribute("aria-label")?.split(",")[0],
        ),
        ["Context", "Back to Mainly"],
        "and the corner holds the chat's context, with the way back drawn last",
      )
      assert.equal(
        find("[data-chat-settings-open]")?.getAttribute("aria-haspopup"),
        "dialog",
        "the title is the press that opens the chat's settings",
      )
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

/**
 * A room is a row of every bot's list its roster seats, so the list it was picked from is the lane it
 * opens beside — the shell asks the record which bot it answers, and a room answers for its Host, so
 * the row's own state is what names the list (ADR 0153).
 */
test(
  "a room's row opens beside the list it was picked from, at 1280px",
  atWidth(1280, async () => {
    localStorage.clear()
    await seed()
    await db.profiles.update(bot.id, { hermesProfile: "default" })
    await db.conversations.put({
      id: "room-1",
      profileId: bot.id,
      title: "Standup",
      hermesSessionId: "gots-room-1",
      createdAt: 2,
      updatedAt: 14,
      changedAt: 14,
      room: { id: "room-1", members: [{ profile: "default" }] },
    })
    await mount(screen({ pathname: "/c/room-1", state: { bot: bot.id } }), async () => {
      await until(async () => titles().includes("Standup"), "the room's own screen")
      assert.equal(missing(LANE), false, "the bot's list keeps its lane beside the room")
      assert.deepEqual(
        listRows().sort(),
        [`/c/${MAIN}`, ...CHATS.map((chat) => `/c/${chat.id}`), "/c/room-1"].sort(),
        "with the room a row of it, marked as the one open",
      )
      assert.equal(openRow()?.getAttribute("href"), "/c/room-1", "the row the pane holds")
      assert.equal(missing(CHAT_BESIDE), false, "and the room drawn in the pane beside it")
      assert.equal(missing(LIST_CONTROL), true, "no bar control repeats the list beside it")
      assert.equal(
        findAll('[data-slot="item-lane"] [data-slot="header-row"] [role="img"]').length,
        0,
        "and the room's bar repeats no face the list's bar already draws",
      )
    })
  }),
)

/**
 * The record a row opens is the authority on which list stands beside it: a link that names another
 * bot, or a link that names one at all on a session, cannot seat a list the record does not belong to.
 */
test(
  "a chat's link naming another bot opens the list of the bot that owns it",
  atWidth(1280, async () => {
    localStorage.clear()
    await seed()
    const other = botProfile("bot-chats-pane-other", { id: "bot-2", name: "Elsewhere" })
    await db.profiles.put(other)
    await mount(screen({ pathname: `/c/${CHATS[0].id}`, state: { bot: other.id } }), async () => {
      await until(() => listRows().length > 0, "the list beside the chat")
      assert.equal(missing(`[data-slot="list-lane"] a[href="/c/${CHATS[1].id}"]`), false,
        "the owning bot's list, not the one the link named")
      assert.equal(
        findAll("p").some((node) => node.textContent === "No chats yet."),
        false,
        "which is not the other bot's empty list",
      )
    })
  }),
)

test(
  "a session's link naming a bot seats no bot's list beside it",
  atWidth(1280, async () => {
    localStorage.clear()
    await seed()
    await db.conversations.put({
      id: "c-project",
      profileId: bot.id,
      title: "A session",
      projectId: "p-1",
      hermesSessionId: "gots-c-project",
      createdAt: 3,
      updatedAt: 15,
      changedAt: 15,
    })
    await mount(screen({ pathname: "/c/c-project", state: { bot: bot.id } }), async () => {
      await until(() => titles().includes("A session"), "the session's own screen")
      assert.equal(
        missing(`[data-slot="list-lane"] a[href="/c/${CHATS[1].id}"]`),
        true,
        "the bot's list is not seated beside a project's session, whatever its link says",
      )
    })
  }),
)

/**
 * The bot is named once on a screen: its list's bar carries its face, and the chat beside that list
 * does not repeat it (ADR 0153).
 */
test(
  "the bot's face is drawn once, in the list's bar, not again in the chat's",
  laptop(async () => {
    localStorage.clear()
    await seed()
    await mount(screen("/c/c-a"), async () => {
      await until(async () => titles().includes("Alpha"), "the chat's own header")
      assert.ok(
        find('[data-slot="list-lane"] [data-slot="header-row"] [role="img"]'),
        "the list's bar carries the bot's face",
      )
      assert.equal(
        findAll('[data-slot="item-lane"] [data-slot="header-row"] [role="img"]').length,
        0,
        "and the chat beside it repeats no face",
      )
    })
  }),
)
