/**
 * A bot's Side Chat List: the screen one press from Main, at the bot's list address. Its bar leads
 * back to Main, says "Sidechats" over the bot and the count of what stands in it, and trails the
 * routines control; its pills are the five this screen holds — no Routines, since a run is not a
 * conversation of the bot's — and the rows run pins first, ordered by when each chat last moved at
 * all (a chat the reader has just written in is the one they are in). At the split width the bot's
 * Main stands above them with a Home glyph, under a separator and a "Side Chats" heading, since it is
 * the chat drawn beside the list; at one pane there is no row for it and no heading over the rows,
 * because the screen is a list of side chats and its own bar already names it.
 *
 * The rows, the subtitle's count and Main's badge all read one rule (`sideChats`), so an archived
 * side chat leaves the rows and the count and stands under the Archived pill, where the badge that
 * reads the same rule never sees it either (`test-main-navigation.tsx` holds the badge).
 */
import assert from "node:assert/strict"
import test from "node:test"
import { MemoryRouter, Route, Routes } from "react-router"

import { AppShell } from "@/components/app-shell"
import { db, saveChatFilter } from "@/lib/db"
import { markRead } from "@/lib/read-marks"
import { SideChatsPage } from "@/routes/side-chats"

import {
  Nav,
  Path,
  atWidth,
  botProfile,
  click,
  find,
  findAll,
  json,
  laptop,
  missing,
  mount,
  nav,
  path,
  seedSettings,
  until,
  wordsOf,
} from "./component-kit.tsx"

const bot = botProfile("side-chats", { id: "bot-1", name: "Mainly", hermesProfile: "default" })
const LABEL = "Mainly"
const MAIN = "main-bot-1"

interface Seed {
  id: string
  title: string
  /** The record's own clock, and the time a message falls back to. */
  at: number
  pinned?: boolean
  archived?: boolean
  /** The bot's own Main: permanent, never a side chat, and drawn above the rows at the split width. */
  main?: boolean
  /** A room the bot's roster seats, wearing its members' pictures. */
  room?: boolean
  /** A routine's run: a row of the routines page, never one of this list's. */
  routine?: string
  /** What was said in it, oldest first: the row's line and its two clocks are read from these. */
  said?: { content: string; at: number; role?: "assistant" | "user" }[]
}

async function seed(chats: Seed[]) {
  await seedSettings({ developer: true, activeProfileId: bot.id })
  await db.profiles.clear()
  await db.profiles.put(bot)
  await db.conversations.clear()
  await db.messages.clear()
  await db.conversations.bulkPut(
    chats.map((one) => ({
      id: one.id,
      profileId: bot.id,
      title: one.title,
      pinned: one.pinned,
      ...(one.archived ? { archived: true } : {}),
      ...(one.main ? { main: true } : {}),
      ...(one.routine ? { routine: true, line: one.routine } : {}),
      ...(one.room
        ? { room: { id: `room-${one.id}`, members: [{ profile: "default", displayName: LABEL }] } }
        : {}),
      hermesSessionId: `gots-${one.id}`,
      createdAt: one.at,
      updatedAt: one.at,
      changedAt: one.at,
    })),
  )
  await db.messages.bulkPut(
    chats.flatMap((one) =>
      (one.said ?? []).map((said, index) => ({
        id: `${one.id}-${index}`,
        conversationId: one.id,
        role: said.role ?? ("assistant" as const),
        content: said.content,
        status: "done" as const,
        createdAt: said.at,
      })),
    ),
  )
  globalThis.fetch = async () => json({})
}

const screen = () => (
  <MemoryRouter initialEntries={[`/b/${bot.id}/sidechats`]}>
    <Path />
    <Routes>
      <Route path="b/:profileId/sidechats" element={<SideChatsPage />} />
      <Route path="c/:id" element={<p data-chat />} />
    </Routes>
  </MemoryRouter>
)

/**
 * The same address as the app draws it: the list in the shell's lane and the chat it stands beside in
 * the item lane. At the split width that chat is the bot's Main, so the row for it is drawn here — the
 * list itself is the lane's, and the address is what puts Main beside it.
 */
const pair = () => (
  <MemoryRouter initialEntries={[`/b/${bot.id}/sidechats`]}>
    <Path />
    <Routes>
      <Route element={<AppShell />}>
        <Route path="b/:profileId/sidechats" element={<SideChatsPage />} />
        <Route path="c/:id" element={<p data-chat />} />
      </Route>
    </Routes>
  </MemoryRouter>
)

/** The side chats the list draws, in the order it draws them — read off the rows, since the heading
 * that names them draws only where Main stands above them. */
const rowIds = () =>
  findAll('[data-slot="chat-rows"] a[href^="/c/"]').map((row) =>
    (row.getAttribute("href") ?? "").slice(3),
  )
/** Main's own row, drawn above the rows at the split width and nowhere else. */
const mainRow = () => find(`[data-slot="main-row"] a[href="/c/${MAIN}"]`)
const filterPill = (label: string) =>
  findAll('[role="group"][aria-label="Filter chats"] button').find(
    (one) => (one.textContent ?? "").trim() === label,
  ) ?? null
const pills = () =>
  findAll('[role="group"][aria-label="Filter chats"] button').map((one) =>
    (one.textContent ?? "").trim(),
  )
const heading = () => find('section[aria-label="Side Chats"] h2')
const bar = (slot: string) => find(`[data-slot="${slot}"]`)

test("the bar leads back to Main, names the screen over the bot's count, and trails the routines", async () => {
  await seed([
    { id: MAIN, title: "Bot Chat", main: true, at: 10 },
    { id: "trip", title: "Trip to Lisbon", at: 300, said: [{ content: "Booked", at: 300 }] },
    {
      id: "packed",
      title: "Packing list",
      at: 200,
      archived: true,
      said: [{ content: "Two pairs", at: 200 }],
    },
    { id: "job", title: "Morning watch", at: 150, routine: "The tide turns at 06:40." },
    { id: "planning", title: "Planning", at: 100, room: true },
  ])
  await mount(screen(), async () => {
    await until(async () => rowIds().length > 0, "the bot's side chats")
    // Main, the archived chat and the run are no side chats of this screen's count: what stands in
    // it is one chat and one room.
    assert.equal(wordsOf(bar("header-title")), "Sidechats", "the screen's own word")
    assert.equal(
      wordsOf(bar("header-line")),
      `${LABEL} · 2 side chats`,
      "and the bot over how many side chats it has, less what it archived",
    )
    // The way back is a step rather than a link: from Main's own control this list stands one rung
    // under it, so a link would push a second copy of Main over a list that came from it.
    const back = find('button[aria-label="Back to Main"]')
    assert.ok(back, "the bar leads with the way back")
    assert.equal(
      back?.closest('[data-slot="header-leading"]') !== null,
      true,
      "in the leading slot",
    )
    const routines = find('header a[aria-label="Routines"]')
    assert.equal(
      routines?.getAttribute("href"),
      `/b/${bot.id}/routines`,
      "and the routines control trails the bar",
    )
    assert.deepEqual(
      rowIds().sort(),
      ["planning", "trip"],
      "the rows are the unarchived side chats",
    )
    assert.ok(missing(`[data-slot="main-row"]`), "and no row of Main at one pane")
  })
})

test("a bot whose Main was never minted leads with the drawer, not a step back to nowhere", async () => {
  // Main is Hermes's to mint, and a host that would not leaves this list where the bot's address
  // opens: the app's first entry. The leading slot is then the app's own door, since a way back would
  // lead to a chat that is not there.
  await seed([
    { id: "trip", title: "Trip to Lisbon", at: 300, said: [{ content: "Booked", at: 300 }] },
  ])
  await mount(screen(), async () => {
    await until(async () => rowIds().length > 0, "the bot's side chats")
    assert.ok(
      missing('button[aria-label="Back to Main"]'),
      "nothing leads back to a Main that isn't there",
    )
    assert.ok(
      find('button[aria-label="Open conversations"]'),
      "the app's own door leads in its place",
    )
  })
})

test("the pills are the five this list holds: no Routines, and a stored Routines reads as All", async () => {
  await seed([
    { id: "trip", title: "Trip to Lisbon", at: 300, said: [{ content: "Booked", at: 300 }] },
    { id: "planning", title: "Planning", at: 100, room: true },
  ])
  // The key is the bot's own and shared with the flat list, which has a pill this screen has not: a
  // device that pressed Routines there opens this list on All rather than on nothing.
  await saveChatFilter(bot.id, "routines")
  await mount(screen(), async () => {
    await until(async () => rowIds().length === 2, "the bot's side chats")
    assert.deepEqual(pills(), ["All", "Unread", "Archived", "Chats", "Rooms"], "the five, in order")
    assert.equal(filterPill("All")?.getAttribute("aria-pressed"), "true", "a Routines reads as All")
    await click(filterPill("Rooms"))
    await until(async () => rowIds().length === 1, "the room the pill keeps")
    assert.deepEqual(rowIds(), ["planning"], "and the pills narrow the rows they name")
  })
})

test(
  "at one pane there is no Main row and no heading over the rows, and at the split width Main stands above a separator",
  atWidth(390, async () => {
    await seed([
      { id: MAIN, title: "Bot Chat", main: true, at: 10, said: [{ content: "Morning", at: 10 }] },
      { id: "trip", title: "Trip to Lisbon", at: 300, said: [{ content: "Booked", at: 300 }] },
    ])
    await mount(screen(), async () => {
      await until(async () => rowIds().length === 1, "the bot's side chats")
      assert.ok(
        missing(`[data-slot="main-row"]`),
        "the list is side chats: Main is the bot's screen",
      )
      assert.ok(
        missing(`[data-slot="main-separator"]`),
        "and nothing separates a row it does not draw",
      )
      // The heading names the divider between Main and its chats: over a list that holds nothing
      // but side chats it separates nothing, and the bar's own line already names the screen.
      assert.ok(
        missing('section[aria-label="Side Chats"] h2'),
        "and no Side Chats heading over rows it does not divide",
      )
    })
  }),
)

test(
  "at the split width Main is the row above the list, marked with a Home glyph",
  laptop(async () => {
    await seed([
      { id: MAIN, title: "Bot Chat", main: true, at: 10, said: [{ content: "Morning", at: 10 }] },
      { id: "trip", title: "Trip to Lisbon", at: 300, said: [{ content: "Booked", at: 300 }] },
    ])
    await mount(pair(), async () => {
      await until(async () => Boolean(mainRow()), "Main's row")
      assert.equal(wordsOf(mainRow()).includes("Main"), true, "drawn at the app's own word")
      assert.ok(
        mainRow()?.querySelector("svg.lucide-house"),
        "with a Home glyph where a chat wears its own icon",
      )
      const separator = find(`[data-slot="main-separator"]`)
      assert.ok(separator, "and a separator under it")
      assert.ok(
        mainRow()!.compareDocumentPosition(separator!) & Node.DOCUMENT_POSITION_FOLLOWING,
        "under the row",
      )
      assert.ok(
        separator!.compareDocumentPosition(heading()!) & Node.DOCUMENT_POSITION_FOLLOWING,
        "and above the rows it divides the screen from",
      )
      // The heading is the divider's own name, so it draws with the row it divides here and nowhere
      // else — over a Main-less list it separated nothing.
      assert.equal(wordsOf(heading()).includes("Side Chats"), true, "the rows are named")
      assert.equal(wordsOf(heading()).includes("1"), true, "with the count of the rows they draw")
      await click(mainRow())
      await until(async () => path() === `/c/${MAIN}`, "the chat the row opens")
    })
  }),
)

test(
  "Main's row is the list's own row: its dot, and a press that takes the pane's place",
  laptop(async () => {
    // Main above the rows is a row of this list like the ones under it, so it wears the dot an unread
    // chat earns and a press beside the list takes the place of the chat it opened — a row built by
    // hand here lost both, and read its title where the app draws its own word over the host's.
    const at = Date.now() - 60_000
    await seed([
      { id: MAIN, title: "Bot Chat", main: true, at, said: [{ content: "Morning", at }] },
      {
        id: "trip",
        title: "Trip to Lisbon",
        at: at - 1_000,
        said: [{ content: "Booked", at: at - 1_000 }],
      },
    ])
    // This device read Main before that word arrived, and has read the side chat since: one dot, on
    // Main's row alone.
    markRead(MAIN, at - 1)
    markRead("trip", at)
    await mount(
      <MemoryRouter initialEntries={["/c/trip"]}>
        <Path />
        <Nav />
        <Routes>
          <Route element={<AppShell />}>
            <Route path="b/:profileId/sidechats" element={<SideChatsPage />} />
            <Route path="c/:id" element={<p data-chat />} />
          </Route>
        </Routes>
      </MemoryRouter>,
      async () => {
        await until(async () => Boolean(mainRow()), "Main's row beside the list")
        assert.ok(
          mainRow()?.querySelector("[data-unread]"),
          "the dot the arrival in it earns, as every row of this list wears one",
        )
        assert.equal(
          wordsOf(mainRow()).includes("Main"),
          true,
          "at the app's word, never the host's",
        )
        assert.ok(
          missing(`[data-unread] a[href="/c/trip"], a[href="/c/trip"] [data-unread]`),
          "and the chat this device has read wears none",
        )
        await click(mainRow())
        await until(async () => path() === `/c/${MAIN}`, "the chat the row opens")
        assert.equal(
          nav(),
          `REPLACE:/c/${MAIN}`,
          "and it takes the place of the chat beside the list, as its neighbours' presses do",
        )
      },
    )
  }),
)

test("the rows run pinned first and the rest by the latest word", async () => {
  const at = Date.now() - 120_000
  await seed([
    { id: "old", title: "An old chat", at, said: [{ content: "The first word", at }] },
    {
      id: "new",
      title: "The newest chat",
      at: at + 60_000,
      said: [{ content: "Last", at: at + 60_000 }],
    },
    {
      id: "held",
      title: "Held on top",
      at: at - 60_000,
      pinned: true,
      said: [{ content: "Held here", at: at - 60_000 }],
    },
    {
      id: "middle",
      title: "In between",
      at: at + 30_000,
      said: [{ content: "Middle", at: at + 30_000 }],
    },
  ])
  await mount(screen(), async () => {
    await until(async () => rowIds().length === 4, "the bot's side chats")
    assert.deepEqual(rowIds(), ["held", "new", "middle", "old"], "the pin first, then the newest")
    assert.ok(
      find(`a[href="/c/held"] svg.lucide-pin`),
      "a pinned row wears the pin that tells it apart",
    )
    assert.ok(missing(`a[href="/c/new"] svg.lucide-pin`), "and one that is not pinned wears none")
  })
})

test("a run is no side chat, and a room is one", async () => {
  const at = Date.now() - 60_000
  await seed([
    { id: "job", title: "Morning watch", at, routine: "The tide turns at 06:40." },
    { id: "planning", title: "Planning", at: at - 1_000, room: true },
    {
      id: "trip",
      title: "Trip to Lisbon",
      at: at - 2_000,
      said: [{ content: "Booked", at: at - 2_000 }],
    },
  ])
  await mount(screen(), async () => {
    await until(async () => rowIds().length === 2, "the bot's side chats")
    assert.ok(!rowIds().includes("job"), "a routine's run is the routines page's row")
    assert.ok(rowIds().includes("planning"), "and a room is a side chat like any other")
    assert.equal(
      wordsOf(bar("header-line")),
      `${LABEL} · 2 side chats`,
      "neither of which the run is counted in",
    )
  })
})

test("a chat the reader wrote in last stands above one the bot answered earlier", async () => {
  const at = Date.now() - 60_000
  await seed([
    {
      id: "written",
      title: "Just written in",
      at,
      said: [
        { content: "An earlier answer", at: at - 120_000 },
        { content: "and the hotel?", at, role: "user" },
      ],
    },
    {
      id: "answered",
      title: "Just answered",
      at: at - 5_000,
      said: [{ content: "Booked", at: at - 5_000 }],
    },
  ])
  await mount(screen(), async () => {
    await until(async () => rowIds().length === 2, "the bot's side chats")
    assert.deepEqual(
      rowIds(),
      ["written", "answered"],
      "the list is ordered by when a chat last moved, so the one the reader is in is on top",
    )
    // The row still says what the bot last said: the clock is not the line.
    assert.ok(
      wordsOf(find(`a[href="/c/written"]`)).includes("An earlier answer"),
      "while its line stays the last thing the bot said",
    )
  })
})

test("an archived side chat leaves the rows and the count, and stands under Archived", async () => {
  const at = Date.now() - 90_000
  await seed([
    { id: "live", title: "Trip to Lisbon", at, said: [{ content: "Booked", at }] },
    {
      id: "packed",
      title: "Packing list",
      at: at - 60_000,
      archived: true,
      said: [{ content: "Two pairs of shoes", at: at - 60_000 }],
    },
  ])
  await mount(screen(), async () => {
    await until(async () => rowIds().length === 1, "the list, less what the reader set aside")
    assert.deepEqual(rowIds(), ["live"], "an archived chat is no row of All")
    assert.equal(
      wordsOf(bar("header-line")),
      `${LABEL} · 1 side chat`,
      "and the count reads the same rule the rows do",
    )
    await click(filterPill("Archived"))
    await until(async () => rowIds().length === 1, "the row the pill keeps")
    assert.deepEqual(rowIds(), ["packed"], "Archived is the one pill that draws it")
    assert.ok(
      wordsOf(find(`a[href="/c/packed"]`)).includes("Two pairs of shoes"),
      "with the line its tail gives it",
    )
    assert.equal(
      wordsOf(bar("header-line")),
      `${LABEL} · 1 side chat`,
      "while the count speaks for the bot's side chats, not for the pill on screen",
    )
  })
})
