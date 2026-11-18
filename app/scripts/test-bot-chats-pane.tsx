import assert from "node:assert/strict"
import test from "node:test"
import { MemoryRouter, Route, Routes } from "react-router"

import { AppShell } from "@/components/app-shell"
import { db } from "@/lib/db"
import { BotChatsPage } from "@/routes/bot-chats"
import { ChatPage } from "@/routes/chat"
import { SideChatsPage } from "@/routes/side-chats"
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
  Nav,
  nav,
  Path,
  path,
  seedSettings,
  settle,
  spyAnimate,
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
async function seed({ collapsed = false, main = true, flat = false } = {}) {
  // The switch is the flat layout's (ADR 0162): every case here is the new UX's pair of panes unless
  // it says otherwise.
  await seedSettings({
    activeProfileId: bot.id,
    sidebarCollapsed: collapsed,
    ...(flat ? { legacyChat: true } : {}),
  })
  await db.profiles.clear()
  await db.profiles.put(bot)
  await db.messages.clear()
  await db.conversations.clear()
  if (main) {
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
  }
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
  await db.messages.bulkPut([
    ...CHATS.map((chat) => ({
      id: `${chat.id}-said`,
      conversationId: chat.id,
      role: "user" as const,
      content: `${chat.title}, said`,
      status: "done" as const,
      createdAt: chat.at - 1,
    })),
    // A word in Main, so the chat the list stands beside draws a thread rather than a blank.
    {
      id: `${MAIN}-said`,
      conversationId: MAIN,
      role: "assistant" as const,
      content: "Main, said",
      status: "done" as const,
      createdAt: 2,
    },
  ])
  globalThis.fetch = async () => json({})
}

/**
 * The shell over the two addresses the new UX has: a bot's Side Chat List and a chat of it. A chat is
 * one address for every screen — a bot's chat, a project session, a canvas — so which pane it opens is
 * the shell's to decide and this test's to read.
 */
const screen = (entry: string | { pathname: string; state?: unknown }) => (
  <MemoryRouter initialEntries={[entry]}>
    <Path />
    <Nav />
    <Routes>
      <Route element={<AppShell />}>
        <Route path="b/:profileId/sidechats" element={<SideChatsPage />} />
        <Route path="c/:id" element={<ChatPage slot="route" />} />
      </Route>
    </Routes>
  </MemoryRouter>
)

/**
 * The flat layout's own screen, mounted with no shell: it is the list the switch turns back on, and at
 * the split width it is the item lane's empty state the screen draws where the shell would put it. Its
 * address is the bot's own, which is why these two cases seed the switch.
 */
const flatList = () => (
  <MemoryRouter initialEntries={[`/b/${bot.id}`]}>
    <Path />
    <Nav />
    <Routes>
      <Route path="b/:profileId" element={<BotChatsPage />} />
      <Route path="c/:id" element={<ChatPage slot="route" />} />
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
/** Main's control in its bar: the Side Chat List, offered only where that list is not on screen. */
const SIDE_CHATS_CONTROL = 'a[aria-label="Side chats"]'
const DRAWER = 'button[aria-label="Open conversations"]'
const OPEN_ROW = '[data-slot="list-lane"] ul a[aria-current="page"]'
/** Main's own row in the Side Chat List, above the side chats at the split width. */
const MAIN_ROW = '[data-slot="main-row"] a[href^="/c/"]'
/** The side chats the list draws, in the order it draws them — read off the rows, since the heading
 * that names them draws only where Main's row stands above them (`main-row` is Main's own list). */
const sideRows = () =>
  findAll('[data-slot="chat-rows"] a[href^="/c/"]').map((row) => row.getAttribute("href") ?? "")

test(
  "a chat opened cold draws the Side Chat List beside it, in its 412px lane",
  laptop(async () => {
    localStorage.clear()
    await seed()
    await mount(screen("/c/c-a"), async () => {
      await until(async () => titles().includes("Alpha"), "the chat's own header")
      assert.equal(missing(LANE), false, "the shell keeps the bot's list on screen")
      assert.match(laneClass(), /\bw-103\b/, "at the 412px lane every list of the app's keeps")
      assert.ok(titles().includes("Mainly"), "the lane wears the bot's bar")
      assert.equal(
        missing('[data-slot="main-row"]'),
        false,
        "over the Side Chat List, Main above it, not the flat one",
      )
      assert.equal(
        missing('[data-slot="bot-chats-empty"]'),
        true,
        "and draws none of the flat list's empty item lane",
      )
      assert.deepEqual(
        sideRows().sort(),
        CHATS.map((chat) => `/c/${chat.id}`).sort(),
        "its side chats are its rows",
      )
      assert.equal(
        find(MAIN_ROW)?.getAttribute("href"),
        `/c/${MAIN}`,
        "with Main above them, the chat the pane does not hold",
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
        "and the chat's bar has no way back to the list already beside it",
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
      assert.equal(
        openRow()?.getAttribute("href"),
        "/c/c-b",
        "and marks the chat the address names",
      )
      assert.equal(
        missing(BACK_TO_BOT),
        true,
        "the chat has no way back to the list beside it",
      )
      assert.equal(
        missing(SIDE_CHATS_CONTROL),
        true,
        "and no way to it in the bar: it stands on screen beside",
      )
    })
  }),
)

test(
  "with the sidebar open at 1024px the chat stands alone, its bar leading back",
  atWidth(1024, async () => {
    localStorage.clear()
    await seed()
    await mount(screen("/c/c-a"), async () => {
      await until(async () => titles().includes("Alpha"), "the chat's own header")
      assert.equal(missing(LANE), true, "no list stands beside it")
      assert.ok(
        find(`[data-slot="header-leading"] ${BACK_TO_BOT}`),
        "and the bar leads with the chat's way back",
      )
      assert.equal(
        missing(DRAWER),
        true,
        "with no drawer beside it: a bar that leads back has nowhere for the app's menu",
      )
    })
  }),
)

test(
  "a phone draws the chat alone, its bar leading back",
  atWidth(390, async () => {
    localStorage.clear()
    await seed()
    await mount(screen("/c/c-a"), async () => {
      await until(async () => titles().includes("Alpha"), "the chat's own header")
      assert.equal(missing(LANE), true, "no list stands beside it")
      assert.equal(missing(DRAWER), true, "and no drawer leads the bar")
      assert.ok(
        find(`[data-slot="header-leading"] ${BACK_TO_BOT}`),
        "which leads with its way back to the list instead",
      )
    })
  }),
)

test(
  "a phone's chat keeps its context in the corner, its way back leading: the title is its settings",
  atWidth(390, async () => {
    localStorage.clear()
    await seed()
    await mount(screen("/c/c-a"), async () => {
      await until(async () => titles().includes("Alpha"), "the chat's own header")
      assert.equal(
        missing(SIDE_CHATS_CONTROL),
        true,
        "no separate control opens the bot's chats from the bar",
      )
      assert.deepEqual(
        findAll('[data-slot="header-actions"] a, [data-slot="header-actions"] button').map(
          (node) => node.getAttribute("aria-label")?.split(",")[0],
        ),
        ["Context"],
        "and the corner holds the chat's context alone",
      )
      assert.ok(
        find(`[data-slot="header-leading"] ${BACK_TO_BOT}`),
        "the way back leading the bar, where a phone's back sits",
      )
      assert.equal(
        find("[data-chat-settings-open]")?.getAttribute("aria-haspopup"),
        "dialog",
        "the title is the press that opens the chat's settings",
      )
    })
  }),
)

/**
 * The flat layout's list address keeps the state it has always had: the item lane beside the list says
 * nothing is open, and marks no chat. The new UX draws Main beside its list at an address of its own.
 */
test(
  'the flat list\'s own address keeps its "No chat selected" lane',
  laptop(async () => {
    localStorage.clear()
    await seed({ flat: true })
    await mount(flatList(), async () => {
      await until(
        async () => missing('[data-slot="bot-chats-empty"]') === false,
        "the item lane's empty state",
      )
      assert.equal(missing(CHAT_BESIDE), true, "no chat is drawn beside the list")
      assert.equal(missing(LANE), true, "and no lane is opened for a chat that is not there")
      assert.equal(missing(OPEN_ROW), true, "with no row marked open")
    })
  }),
)

/**
 * The lane beside the flat list, with nothing open in it, says so properly: a chat's mark on one line
 * and the words under it on the next, both standing centred in the lane the state fills (F5).
 */
test(
  "the item pane says what is not there",
  laptop(async () => {
    localStorage.clear()
    await seed({ flat: true })
    await mount(flatList(), async () => {
      await until(
        async () => missing('[data-slot="bot-chats-empty"]') === false,
        "the item lane's empty state",
      )
      const empty = find('[data-slot="bot-chats-empty"]')
      assert.ok(empty, "the lane beside the list says there is nothing open in it")
      const mark = empty?.querySelector("svg")
      assert.ok(mark, "and draws a chat's mark")
      assert.equal(
        mark?.parentElement,
        empty,
        "with the mark a line of the lane's own, not wrapped in the words' paragraph",
      )
      const words = [...(empty?.children ?? [])].find((child) => child.tagName === "P")
      assert.equal(words?.textContent?.trim(), "No chat selected", "the words on the line under it")
      assert.equal(empty?.textContent?.trim(), "No chat selected", "and no other words in the lane")
      assert.match(
        empty?.getAttribute("class") ?? "",
        /\bflex-col\b/,
        "the two stand as separate lines, one above the other",
      )
      assert.match(
        empty?.getAttribute("class") ?? "",
        /\bitems-center\b.*\bjustify-center\b/,
        "and centred on both axes of the lane",
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
      await until(async () => openRow()?.getAttribute("href") === "/c/c-a", "the open chat's row")
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

/**
 * Two rows of one list are siblings, not steps: a second conversation picked while one already stands
 * beside the list takes its place, so a step back from it is still the list rather than the chat
 * before it.
 */
test(
  "a row pressed beside an open conversation replaces it, so back is still one rung",
  laptop(async () => {
    localStorage.clear()
    await seed()
    await mount(screen("/c/c-a"), async () => {
      await until(
        async () => openRow()?.getAttribute("href") === "/c/c-a",
        "the chat the list opened",
      )
      await click(find('[data-slot="list-lane"] ul a[href="/c/c-b"]'))
      await until(async () => path() === "/c/c-b", "the row's own chat")
      assert.equal(
        nav(),
        "REPLACE:/c/c-b",
        "the row takes the item's place rather than stacking a second",
      )
      assert.equal(missing(CHAT_BESIDE), false, "the new conversation stands beside the same list")
      assert.equal(openRow()?.getAttribute("href"), "/c/c-b", "with its row the one marked open")
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
      assert.equal(missing(SIDE_CHATS_CONTROL), true, "no bar control repeats the list beside it")
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
      assert.equal(
        missing(`[data-slot="list-lane"] a[href="/c/${CHATS[1].id}"]`),
        false,
        "the owning bot's list, not the one the link named",
      )
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
 * The bot is named once on the pair of panes: the Side Chat List's line names it, and the chat beside
 * that list repeats neither its face nor its name (ADR 0153).
 */
test(
  "the Side Chat List names the bot once, and the chat beside it repeats no face",
  laptop(async () => {
    localStorage.clear()
    await seed()
    await mount(screen("/c/c-a"), async () => {
      await until(async () => titles().includes("Alpha"), "the chat's own header")
      assert.match(
        find('[data-slot="list-lane"] [data-slot="header-title"]')?.textContent ?? "",
        /Mainly/,
        "the list's bar names the bot",
      )
      assert.equal(
        findAll('[data-slot="item-lane"] [data-slot="header-row"] [role="img"]').length,
        0,
        "and the chat beside it repeats no face",
      )
    })
  }),
)

test(
  "Main beside its list is drawn as a side chat is: its title, and no face",
  laptop(async () => {
    localStorage.clear()
    await seed()
    await mount(screen(`/b/${bot.id}/sidechats`), async () => {
      await until(async () => titles().includes("Main"), "Main in the item lane")
      assert.equal(
        findAll('[data-slot="item-lane"] [data-slot="header-row"] [role="img"]').length,
        0,
        "Main's bar repeats no face beside the list that wears it",
      )
    })
  }),
)

/**
 * The bot's list address draws the pair the new UX is made of (G6): the Side Chat List in the lane and
 * the bot's **Main** in the item lane beside it — not the list twice, and nowhere the flat layout's
 * "No chat selected". Main is a chat with an id of its own that no rung of the address spells out, so
 * the item lane is drawn by the screen at that address for the chat the pane names.
 */
test(
  "the list's own address draws the Side Chat List in the lane and Main in the item lane",
  laptop(async () => {
    localStorage.clear()
    await seed()
    await mount(screen(`/b/${bot.id}/sidechats`), async () => {
      await until(async () => titles().includes("Mainly"), "the list in the lane")
      await until(async () => titles().includes("Main"), "Main in the item lane")
      assert.equal(
        path(),
        `/b/${bot.id}/sidechats`,
        "the address the reader gave it, rewritten for nobody",
      )
      assert.equal(missing(LANE), false, "the list keeps its lane")
      assert.match(laneClass(), /\bw-103\b/, "at the 412px the app's lists keep")
      assert.deepEqual(
        [...titles()].sort(),
        ["Main", "Mainly"],
        "one list and one chat: the list in the lane, Main beside it",
      )
      assert.equal(
        findAll('[data-slot="list-lane"] [data-slot="chat-pane"]').length,
        0,
        "and no chat in the list's lane",
      )
      assert.equal(missing(CHAT_BESIDE), false, "Main stands in the item lane")
      assert.equal(
        find(CHAT_BESIDE)?.querySelector('[data-slot="header-title"]')?.textContent?.trim(),
        "Main",
        "as the bot's own conversation",
      )
      assert.equal(
        find('[data-slot="main-row"] a[aria-current="page"]')?.getAttribute("href"),
        `/c/${MAIN}`,
        "with Main's row marked as the chat the pane holds",
      )
      assert.equal(
        findAll("p").some((node) => node.textContent?.trim() === "No chat selected"),
        false,
        "and no state for nothing being open: Main is open",
      )
      assert.deepEqual(
        sideRows().sort(),
        CHATS.map((chat) => `/c/${chat.id}`).sort(),
        "the side chats stand under it, as the list's rows",
      )
    })
  }),
)

/**
 * A side chat picked from the list is a sibling of Main rather than a step above it: it takes the item
 * lane, its own row the one marked, and the way back lands the list again — where Main stands beside
 * it, since the list's address is what it draws. No transition plays over the pair: the pane names the
 * bot's one screen for the list and for every chat of it.
 */
test(
  "a picked side chat takes the item lane, its row marked, and back is the list",
  laptop(async () => {
    localStorage.clear()
    await seed()
    await mount(screen(`/b/${bot.id}/sidechats`), async () => {
      await until(async () => titles().includes("Main"), "Main beside the list")
      const spy = spyAnimate()
      try {
        await click(find(`[data-slot="list-lane"] ul a[href="/c/c-b"]`))
        await until(async () => path() === "/c/c-b", "the chat's own address")
        await until(async () => titles().includes("Beta"), "the chat's header")
        await settle()
      } finally {
        spy.restore()
      }
      assert.equal(
        spy.onScreen().length,
        0,
        "the pair never re-animates: the list and its chats are one screen",
      )
      assert.equal(missing(CHAT_BESIDE), false, "the chat stands in the item lane")
      assert.equal(
        openRow()?.getAttribute("href"),
        "/c/c-b",
        "the row of the chat the pane holds is the one marked",
      )
      assert.equal(missing(LANE), false, "and the list keeps its lane beside it")

      await click(find(MAIN_ROW))
      await until(async () => path() === `/c/${MAIN}`, "Main, from its row in the list")
      await until(async () => titles().includes("Main"), "Main standing beside the list again")
      assert.equal(
        find('[data-slot="main-row"] a[aria-current="page"]')?.getAttribute("href"),
        `/c/${MAIN}`,
        "with Main the chat the pane holds",
      )
      assert.equal(openRow()?.getAttribute("href"), `/c/${MAIN}`, "and the row the list marks")
    })
  }),
)

/**
 * Nothing is remembered: the list's address is Main's, whatever the pane held when it was last open —
 * a picked side chat, a side chat opened cold, the list left behind a chat. A fresh mount reads the
 * bot's Main rather than a stored pick.
 */
test(
  "a fresh mount at the list's address is Main, whatever was open before",
  laptop(async () => {
    localStorage.clear()
    await seed()
    await mount(screen("/c/c-b"), async () => {
      await until(
        async () => openRow()?.getAttribute("href") === "/c/c-b",
        "the side chat open beside the list",
      )
    })
    await mount(screen(`/b/${bot.id}/sidechats`), async () => {
      await until(async () => titles().includes("Main"), "Main in the item lane")
      assert.equal(
        openRow()?.getAttribute("href"),
        `/c/${MAIN}`,
        "Main is the chat beside the list, not the one left open there",
      )
      assert.equal(
        titles().includes("Beta"),
        false,
        "and no memory of the chat the last visit held",
      )
      assert.equal(missing(CHAT_BESIDE), false, "Main drawn in the item lane, as on any visit")
    })
  }),
)

/**
 * One pane holds the list alone: the split width is what puts Main beside it, so a phone's list address
 * draws no Main row and no item lane. Nothing of the second pane is left standing empty.
 */
test(
  "a phone's list address is the list alone, with no Main row",
  atWidth(390, async () => {
    localStorage.clear()
    await seed()
    await mount(screen(`/b/${bot.id}/sidechats`), async () => {
      await until(async () => titles().includes("Sidechats"), "the list, whole")
      assert.equal(missing(LANE), true, "no lane: the list is the screen")
      assert.equal(missing(CHAT_BESIDE), true, "and no chat stands beside it")
      assert.equal(missing('[data-slot="main-row"]'), true, "with no row for Main")
      assert.deepEqual(
        sideRows().sort(),
        CHATS.map((chat) => `/c/${chat.id}`).sort(),
        "the side chats are the rows, as at the split width",
      )
    })
  }),
)

/**
 * A bot whose Main this device does not hold — a host no plugin has published one for — keeps its list
 * standing whole rather than beside a blank: the lane opens only where there is a chat to put in the
 * second pane.
 */
test(
  "a bot with no Main keeps its list whole at the split width, beside no blank",
  laptop(async () => {
    localStorage.clear()
    await seed({ main: false })
    await mount(screen(`/b/${bot.id}/sidechats`), async () => {
      await until(async () => titles().includes("Sidechats"), "the list")
      assert.match(laneClass(), /\bw-full\b/, "the list takes the whole width")
      assert.equal(missing(CHAT_BESIDE), true, "with nothing drawn beside it")
      assert.equal(findAll('[data-slot="header-title"]').length, 1, "one list, not one per pane")
      assert.equal(
        missing('[data-slot="main-row"]'),
        true,
        "and no Main row for a Main there is none of",
      )
    })
  }),
)
