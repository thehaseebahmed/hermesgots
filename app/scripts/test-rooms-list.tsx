/**
 * A room on a device that has never opened it: the plugin's chat list carries the room's record, the
 * merge writes one `Conversation` for it, and every bot whose roster seats it draws that row once —
 * its name, its members and its last activity — while no bot's Main lists it as a thread. A second
 * merge of the same record writes nothing (ADR 0116).
 *
 * A room's row is the chat list's own: it stands among a bot's chats by its last activity, its pin
 * lifts it above a newer chat, and it says the room needs the user — naming the member who asked —
 * until the device has drawn what asks, which is the room's own screen opening. The legacy layout,
 * whose Recents is the only list it has, keeps a Rooms section of its own for the same rows.
 *
 * The record is the plugin's answer, not a document: the fake below answers `GET`/`POST /chats` the
 * way the plugin does, projecting the room beside whatever the device sent, and one read of the
 * room's log the way the plugin pages it.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { act } from "react"
import { MemoryRouter, Route, Routes } from "react-router"

import { ConversationList } from "@/components/conversation-list"
import { RoomChat } from "@/components/room/room-chat"
import { BotChatsPage } from "@/routes/bot-chats"
import { chatOwner } from "@/lib/chat-owner"
import { db, chatTombstones, type Profile } from "@/lib/db"
import { formatRelative } from "@/lib/format"
import { connectionKey, noteChange } from "@/lib/live"
import { syncNow } from "@/lib/sync"
import { useLegacyChat } from "@/lib/legacy-chat"
import { pressBack } from "@/lib/native"
import { useBotChatsPane } from "@/lib/pane"

import {
  Path,
  absent,
  atWidth,
  botProfile,
  click,
  find,
  findAll,
  findText,
  json,
  missing,
  mount,
  path,
  seedSettings,
  settle,
  until,
  wordsOf,
} from "./component-kit.tsx"

const HOST = "http://rooms.test/v1"
const CARRIER = "bot-carrier"
const CODER = "bot-coder"
const WRITER = "bot-writer"

const ROOM = "room-1"
const LAST_AT = Date.now() - 5 * 60_000

/**
 * How long a mark is given to leave a row after the device that opened the room has written it:
 * the list redraws in one commit, so the bound is what keeps this a check on the row rather than a
 * twelve-second wait a stale mark would pass.
 */
const CLEARS_MS = 1_000

const bots: Profile[] = [
  // The bot that carries the room's record onto this device. It is not one of the room's members.
  botProfile("rooms", {
    id: CARRIER,
    name: "Carrier",
    baseUrl: HOST,
    apiKey: "rooms-key",
    hermesProfile: "default",
  }),
  // A member: the profile the room seats, so the bot that answers for it.
  botProfile("rooms", {
    id: CODER,
    name: "Coder",
    baseUrl: HOST,
    apiKey: "rooms-key",
    hermesProfile: "coder",
  }),
  // The room's second member: it lists in this bot's list as well, and answers second.
  botProfile("rooms", {
    id: WRITER,
    name: "Writer",
    baseUrl: HOST,
    apiKey: "rooms-key",
    hermesProfile: "writer",
    botId: "hex",
  }),
]

const moved = { at: LAST_AT, title: "Planning" }
/** Whether the Host has disbanded the room: its record is then the row's deletion. */
let retired = false
/** Whether the Host answers the room's page in two, its first ending before the newest reply. */
let split = false
/**
 * The room's log as the Host pages it to this device: a round that settled addressed to `@user`,
 * which is the room's needs-you mark (the plan's F4).
 */
let log: {
  seq: number
  eventId: string
  kind: string
  text?: string
  memberId?: string
  name?: string
}[] = []

const asks = () => [
  { seq: 1, eventId: "e1", kind: "message.user", text: "Who takes the release?" },
  {
    seq: 2,
    eventId: "e2",
    kind: "message.member",
    text: "I can, but @user has to pick.",
    memberId: "m1",
    name: "Coder",
  },
]

/** Two chats of the carrier's, one either side of the room's own last activity. */
const CHAT_NEWER = "chat-newer"
const CHAT_OLDER = "chat-older"

const record = () => ({
  at: moved.at,
  value: {
    title: moved.title,
    createdAt: LAST_AT - 60_000,
    updatedAt: moved.at,
    room: {
      id: ROOM,
      members: [
        { memberId: "m1", profile: "coder", handle: "coder", displayName: "Coder" },
        { memberId: "m2", profile: "writer", handle: "writer", displayName: "Writer" },
      ],
    },
  },
})

/**
 * One room, read the way the plugin answers it: the log since the device's mark, and its state. A
 * `split` room stops its first page early and says there is more, which the reader must follow.
 */
const roomRead = (since?: number) => {
  const first = split && since === undefined
  return {
    object: "gots.room",
    room: { id: ROOM, name: moved.title, members: record().value.room.members },
    events: first ? [] : log,
    cursor: first ? 0 : (log.at(-1)?.seq ?? 0),
    latestSeq: log.at(-1)?.seq ?? 0,
    hasMore: first,
    working: false,
    activity: [],
    waiting: [],
    canStop: false,
    canSend: true,
  }
}

let merges = 0

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input))
  const body = init?.body ? JSON.parse(String(init.body)) : undefined
  if (url.pathname.endsWith("/capabilities")) return json({ features: {} })
  if (url.pathname.endsWith("/plugins/gots/info")) return json({ features: ["draft_text"] })
  if (url.pathname.endsWith(`/plugins/gots/rooms/${ROOM}`))
    return json(roomRead(url.searchParams.has("since") ? Number(url.searchParams.get("since")) : undefined))
  if (url.pathname.endsWith("/plugins/gots/chats")) {
    merges += 1
    // The plugin's own answer: what the device sent, and the Host's rooms built fresh on every read.
    return json({
      object: "gots.chats",
      chats: {
        ...(body?.chats ?? {}),
        [ROOM]: retired ? { at: moved.at + 60_000, deleted: true } : record(),
      },
    })
  }
  return json({}, 404)
}) as typeof fetch


/** Every write to the device's chat rows, so "an unchanged record writes nothing" can be measured. */
const writes = { rows: 0 }
db.conversations.hook("creating", () => void writes.rows++)
db.conversations.hook("updating", () => void writes.rows++)
db.conversations.hook("deleting", () => void writes.rows++)

async function fresh(
  {
    chats = false,
    ask = false,
    layout = "legacy",
  }: { chats?: boolean; ask?: boolean; layout?: "legacy" | "bots" } = {},
) {
  moved.at = LAST_AT
  moved.title = "Planning"
  retired = false
  split = false
  log = ask ? asks() : []
  await seedSettings({
    onboarded: true,
    legacyChat: layout === "legacy",
    movedChats: bots.map((bot) => bot.id),
  })
  await db.profiles.clear()
  await db.profiles.bulkPut(bots)
  await db.conversations.clear()
  await db.messages.clear()
  await db.roomLog.clear()
  if (chats)
    await db.conversations.bulkPut(
      [
        { id: CHAT_NEWER, at: LAST_AT + 120_000, title: "Newer" },
        { id: CHAT_OLDER, at: LAST_AT - 120_000, title: "Older" },
      ].map(({ id, at, title }) => ({
        id,
        profileId: CARRIER,
        title,
        hermesSessionId: `gots-${id}`,
        createdAt: at - 1_000,
        updatedAt: at,
        changedAt: at,
      })),
    )
  await settle()
}

/**
 * The room's log held on the device, and the device's mark of what it has drawn: what a room's row
 * reads to say the room needs the user.
 */
const needOf = async () => (await db.conversations.get(ROOM))?.roomNeeds

async function merged() {
  await syncNow()
  await settle()
  await until(async () => Boolean(await db.conversations.get(ROOM)), "the room's row to land")
}

const owner = (row: Parameters<typeof chatOwner>[0]) =>
  chatOwner(
    row,
    new Map(bots.map((bot) => [bot.id, bot])),
  )

const screen = (entry: string) => (
  <MemoryRouter initialEntries={[entry]}>
    <Path />
    <ConversationList />
  </MemoryRouter>
)

/** The room's own screen, at the address its row chooses. */
const roomScreen = () => (
  <MemoryRouter initialEntries={[`/c/${ROOM}`]}>
    <Routes>
      <Route path="/c/:id" element={<RoomChat id={ROOM} slot="route" />} />
    </Routes>
  </MemoryRouter>
)

/** The chat rows one band of the sidebar drew, in the order it drew them. */
const band = (name: string) =>
  findAll(`[data-band="${name}"] a[href^="/c/"]`).map((row) => row.getAttribute("href"))

/** A bot's list, at the address the sidebar's row for that bot takes. */
const listScreen = (profileId: string) => (
  <MemoryRouter initialEntries={[`/b/${profileId}`]}>
    <Path />
    <Routes>
      <Route path="b/:profileId" element={<BotChatsPage />} />
      <Route path="c/:id" element={<p data-chat />} />
    </Routes>
  </MemoryRouter>
)

/** The rows one bot's list drew, by the chat each leads to, in the order it drew them. */
const listRows = () =>
  findAll('ul a[href^="/c/"]').map((row) => (row.getAttribute("href") ?? "").slice(3))

test("a room's record merged onto a fresh device is one row, carried by one bot", async () => {
  await fresh()
  await merged()
  const rows = await db.conversations.where("id").equals(ROOM).toArray()
  assert.equal(rows.length, 1, "the room is one row, however many of the Host's bots carried it")
  const [row] = rows
  assert.equal(row.profileId, CARRIER, "profileId says where the record was carried, and nothing more")
  assert.equal(row.title, "Planning", "its name")
  assert.equal(row.updatedAt, LAST_AT, "its last activity, on the Host's own clock")
  assert.deepEqual(
    row.room?.members.map((member) => member.profile),
    ["coder", "writer"],
    "its members, as the Host seats them",
  )
  assert.equal(owner(row).listed, true, "a room lists wherever a chat does")
  assert.equal(
    owner(row).answerer,
    CODER,
    "the bot that answers is one of its members, not the bot that carried the record",
  )
})

test("Recents draws the room once, with its name, its members and its last activity", async () => {
  await fresh()
  await merged()
  await mount(screen("/"), async () => {
    await until(async () => Boolean(find(`a[href="/c/${ROOM}"]`)), "the room's row")
    const rows = findAll(`a[href="/c/${ROOM}"]`)
    assert.equal(rows.length, 1, "one row for the room")
    const text = rows[0].textContent ?? ""
    assert.ok(text.includes("Planning"), `the room's name, in "${text}"`)
    assert.ok(text.includes("Coder"), `its members, in "${text}"`)
    assert.ok(
      text.includes(formatRelative(LAST_AT, Date.now())),
      `its last activity, in "${text}"`,
    )
  })
})

test("a second merge of an unchanged record writes nothing", async () => {
  await fresh()
  await merged()
  const before = { merges, rows: writes.rows }
  await syncNow()
  await settle()
  assert.ok(merges > before.merges, "the list was read again")
  assert.equal(writes.rows, before.rows, "an unchanged record is not written again")
  const row = await db.conversations.get(ROOM)
  assert.equal(row?.profileId, CARRIER, "the row it kept is the one it had")
})

test("a record that moved is written, and the row takes the Host's newer words", async () => {
  await fresh()
  await merged()
  const before = writes.rows
  moved.at = LAST_AT + 60_000
  moved.title = "Planning 2"
  await syncNow()
  await settle()
  await until(
    async () => (await db.conversations.get(ROOM))?.title === "Planning 2",
    "the room's new name",
  )
  assert.equal(writes.rows - before, 1, "the merge the record's own clock moved in wrote it")
  const row = await db.conversations.get(ROOM)
  assert.equal(row?.changedAt, moved.at, "on the Host's clock")
})

test(
  "a room's address opens no bot's pane: it is its own screen's",
  atWidth(1400, async () => {
    await fresh()
    await merged()
    await mount(
      <MemoryRouter initialEntries={[`/c/${ROOM}`]}>
        <Path />
        <Pane />
      </MemoryRouter>,
      async () => {
        await until(async () => find("[data-pane]") !== null, "the pane's answer")
        await settle()
        assert.equal(
          find("[data-pane]")?.textContent,
          "null",
          "a room is its own screen, so no bot's list stands beside it",
        )
      },
    )
  }),
)

function Pane() {
  const pane = useBotChatsPane(useLegacyChat() === false)
  return <span data-pane>{JSON.stringify(pane ? { bot: pane.profileId } : null)}</span>
}

test("a room the Host disbands leaves the device that merged it", async () => {
  await fresh()
  await merged()
  retired = true
  await syncNow()
  await settle()
  await until(async () => !(await db.conversations.get(ROOM)), "the row to go")
  assert.deepEqual(
    await chatTombstones(),
    [],
    "the Host said so, so this device has nothing to push back",
  )
})

test("a room follows the Host though the bot that first carried it is turned off", async () => {
  await fresh()
  await merged()
  // The carrier is not a member and is no longer synced: the room's own Host still has another bot.
  await db.profiles.update(CARRIER, { disabled: true })
  moved.at = LAST_AT + 60_000
  moved.title = "Planning 2"
  await syncNow()
  await settle()
  await until(
    async () => (await db.conversations.get(ROOM))?.title === "Planning 2",
    "the Host's newer words to land through another bot",
  )
  retired = true
  await syncNow()
  await settle()
  await until(
    async () => !(await db.conversations.get(ROOM)),
    "a disbanded room to leave though its carrier is off",
  )
})

test("the bot layout's sidebar draws no room: a room is a row of the bots' lists", async () => {
  await fresh({ layout: "bots" })
  await merged()
  await mount(screen("/"), async () => {
    await until(async () => Boolean(find("#bots-heading")), "the bots")
    absent('[data-band="rooms"]', "the sidebar has no Rooms section")
    absent(`a[href="/c/${ROOM}"]`, "and draws no room of its own")
    absent('a[href="/new-room"]', "and offers New room nowhere in the drawer")
  })
})

test("a room draws in the list of every bot it seats, and in no other bot's", async () => {
  await fresh({ layout: "bots" })
  await merged()
  // The roster seats coder and writer; the bot that carried the record is neither of them.
  for (const [bot, seats] of [
    [CODER, true],
    [WRITER, true],
    [CARRIER, false],
  ] as const) {
    await mount(listScreen(bot), async () => {
      if (seats) {
        await until(async () => Boolean(find(`a[href="/c/${ROOM}"]`)), "the room's row")
        const row = find(`a[href="/c/${ROOM}"]`)
        assert.ok(row?.querySelector("[data-room-faces]"), "the row wears its members' pictures")
        assert.ok(
          wordsOf(row).includes("Coder, Writer"),
          "and names them in the line a chat gives its last words",
        )
        return
      }
      // The carrier's list settles on its own empty answer, so nothing is the list's own word.
      await until(
        async () => Boolean(findText("p", "No chats yet.")),
        "a list with nothing in it",
      )
      assert.ok(
        missing(`a[href="/c/${ROOM}"]`),
        "a bot the room does not seat never draws it",
      )
    })
  }
})

test("a room's pin lifts it above a newer chat in a bot's list", async () => {
  await fresh({ layout: "bots" })
  await merged()
  // A chat of the writer's, newer than the room's own last activity.
  await db.conversations.put({
    id: "chat-writer",
    profileId: WRITER,
    title: "Newer",
    hermesSessionId: "gots-chat-writer",
    createdAt: LAST_AT + 119_000,
    updatedAt: LAST_AT + 120_000,
    changedAt: LAST_AT + 120_000,
  })
  // A room's record carries no pin, so this one is the device's own (ADR 0121).
  await db.conversations.update(ROOM, { pinned: true })
  await syncNow()
  await settle()
  await mount(listScreen(WRITER), async () => {
    await until(async () => listRows().length === 2, "the chat and the room")
    assert.deepEqual(listRows(), [ROOM, "chat-writer"], "the pin lifts the room above a newer chat")
  })
  await db.conversations.update(ROOM, { pinned: false })
  await mount(listScreen(WRITER), async () => {
    await until(async () => listRows().length === 2, "the chat and the room")
    assert.deepEqual(
      listRows(),
      ["chat-writer", ROOM],
      "and unpinned, it stands by its own last activity",
    )
  })
})

test("a room that needs the reader says so on its row in a bot's list", async () => {
  await fresh({ ask: true, layout: "bots" })
  await merged()
  await mount(listScreen(CODER), async () => {
    await until(async () => Boolean(find(`a[href="/c/${ROOM}"]`)), "the room's row")
    const row = () => wordsOf(find(`a[href="/c/${ROOM}"]`))
    await until(async () => row().includes("needs you"), "the room's needs-you line")
    assert.match(row(), /Coder needs you — reply in the room\./, "naming the member who asked")
    assert.ok(row().includes("Planning"), "beside the room's own name")
  })
})

test("Rooms lists the rooms by their last activity, and Recents holds none of them", async () => {
  await fresh({ chats: true })
  // A second room, older than the first, written straight to the device: the section orders rooms by
  // their own clocks, whatever the Host's record says (ADR 0127).
  await db.conversations.put({
    id: "room-older",
    profileId: CARRIER,
    title: "Standup",
    room: { id: "room-older", members: [] },
    createdAt: LAST_AT - 600_000,
    updatedAt: LAST_AT - 600_000,
    changedAt: LAST_AT - 600_000,
  })
  await merged()
  await mount(screen("/"), async () => {
    // Both bands are waited for whole: the two lists settle on their own, and a runner that is slower
    // than this one would otherwise read an empty band as the answer (ADR 0127).
    await until(async () => band("rooms").length === 2, "both rooms")
    await until(async () => band("recents").length === 2, "both chats")
    assert.deepEqual(
      band("rooms"),
      [`/c/${ROOM}`, "/c/room-older"],
      "the newest room first, and the older one under it",
    )
    assert.deepEqual(
      band("recents"),
      [`/c/${CHAT_NEWER}`, `/c/${CHAT_OLDER}`],
      "and the chat list holds chats alone",
    )
  })
})

test("a pinned room stands at the top of Rooms, whatever its age", async () => {
  await fresh({ chats: true })
  await merged()
  // A room newer than the pinned one, so the pin is the only thing that can put the older one first.
  await db.conversations.put({
    id: "room-newer",
    profileId: CARRIER,
    title: "Standup",
    room: { id: "room-newer", members: [] },
    createdAt: LAST_AT + 600_000,
    updatedAt: LAST_AT + 600_000,
    changedAt: LAST_AT + 600_000,
  })
  // A room's record carries no pin — the Host's room has none (ADR 0116) — so the pin is this
  // device's own, and the merge that follows must not take it away.
  await db.conversations.update(ROOM, { pinned: true })
  await syncNow()
  await settle()
  assert.equal((await db.conversations.get(ROOM))?.pinned, true, "the room's own pin stands")
  await mount(screen("/"), async () => {
    await until(async () => band("rooms").length === 2, "both rooms")
    assert.equal(band("rooms")[0], `/c/${ROOM}`, "the pin lifts the room above a newer one")
    assert.ok(
      !band("recents").includes(`/c/${ROOM}`),
      "and a room is never drawn twice, in two lists",
    )
  })
})

test("a pinned chat is lifted into the pinned band, and a room stays in Rooms", async () => {
  await fresh({ chats: true })
  await db.conversations.update(CHAT_OLDER, { pinned: true })
  await merged()
  await mount(screen("/"), async () => {
    await until(async () => band("pinned").includes(`/c/${CHAT_OLDER}`), "the pinned chat")
    assert.deepEqual(band("pinned"), [`/c/${CHAT_OLDER}`], "the pin lifts the chat alone")
    assert.deepEqual(band("recents"), [`/c/${CHAT_NEWER}`], "Recents holds what is left of the chats")
    assert.deepEqual(band("rooms"), [`/c/${ROOM}`], "and the room is its own section's row")
  })
})

test("the room's needs-you mark stands on its row, and clears when the room is opened", async () => {
  await fresh({ ask: true })
  await merged()
  await mount(screen("/"), async () => {
    await until(
      async () => find(`a[href="/c/${ROOM}"] [data-needs-you]`) !== null,
      "the room's needs-you mark",
    )
    const mark = find(`a[href="/c/${ROOM}"] [data-needs-you]`)
    assert.match(
      mark?.closest("a")?.textContent ?? "",
      /Coder needs you/,
      "the mark names the member who asked",
    )
    assert.equal((await needOf())?.seq, 2, "the device holds the reply that asks")
  })
  // Opening the room is drawing it: the screen reads the Host's page and marks what it has drawn.
  await mount(roomScreen(), async () => {
    await until(
      async () => (await db.conversations.get(ROOM))?.roomSeenSeq === 2,
      "the device's mark of what it drew",
    )
  })
  await mount(screen("/"), async () => {
    await until(async () => band("rooms").includes(`/c/${ROOM}`), "the room's row")
    await until(
      async () => missing(`a[href="/c/${ROOM}"] [data-needs-you]`),
      "a room open on this device no longer needs the user",
      CLEARS_MS,
    )
  })
})

test("a room opened from a bot's list leads back to that list, by its control and by back", async () => {
  // A room is a row of every bot's list it seats, and the shell lays no bot list beside a room — it
  // is no bot's chat (`listsAsChat`), so `useBotChatsPane` answers nothing for it at any width. The
  // room's screen is therefore a screen the list pushed wherever it is opened from, and without a
  // control of its own the only way out would be Android's hardware back.
  await fresh({ chats: true, layout: "bots" })
  await merged()
  const roomFromList = () => (
    <MemoryRouter initialEntries={[{ pathname: `/c/${ROOM}`, state: { bot: CODER } }]}>
      <Path />
      <Routes>
        <Route path="/c/:id" element={<RoomChat id={ROOM} slot="route" />} />
        <Route path="/b/:profileId" element={<p data-list />} />
      </Routes>
    </MemoryRouter>
  )
  await mount(roomFromList(), async () => {
    await until(async () => Boolean(find(`[aria-label="Back to Coder"]`)), "the way back")
    await click(find(`[aria-label="Back to Coder"]`))
    await until(async () => path() === `/b/${CODER}`, "the list the row stands in")
    assert.ok(find("[data-list]"), "and the room's screen is what was left")
  })
  await mount(roomFromList(), async () => {
    await until(async () => Boolean(find(`[aria-label="Back to Coder"]`)), "the screen's own way out")
    assert.equal(pressBack(), "screen", "Android's back is the same answer")
    await until(async () => path() === `/b/${CODER}`, "the list behind it")
  })
})

test("a room whose row moved is read again, and its mark follows the Host", async () => {
  await fresh({ ask: true })
  await merged()
  await mount(screen("/"), async () => {
    await until(
      async () => find(`a[href="/c/${ROOM}"] [data-needs-you]`) !== null,
      "the room's needs-you mark",
    )
    // The user answers in the room on another device: the Host says the room moved, and its log
    // holds the user's words last — which ask for nobody.
    log = [
      ...asks(),
      { seq: 3, eventId: "e3", kind: "message.user", text: "Coder, you take it." },
    ]
    moved.at = LAST_AT + 60_000
    await syncNow()
    await settle()
    await until(
      async () => missing(`a[href="/c/${ROOM}"] [data-needs-you]`),
      "an answered room's row says nothing",
      CLEARS_MS,
    )
    assert.ok(
      (await needOf())?.seq === undefined,
      "the device's reading of a room that no longer asks",
    )
  })
})

test("a room's page is read on to its newest reply, not left at the first page", async () => {
  await fresh({ ask: true })
  split = true
  await merged()
  await mount(screen("/"), async () => {
    await until(
      async () => find(`a[href="/c/${ROOM}"] [data-needs-you]`) !== null,
      "the mark the second page carries",
    )
  })
})

test("the Host saying a room moved marks its row though the record never moved", async () => {
  await fresh()
  await merged()
  await mount(screen("/"), async () => {
    await until(async () => band("rooms").includes(`/c/${ROOM}`), "the room's row")
    // The list has read the room and found nothing; the member's reply lands while the record's own
    // clock stands still, so only the change stream can tell the row.
    const opened = Date.now()
    while (Date.now() - opened < 1_100) await new Promise((done) => setTimeout(done, 50))
    log = asks()
    await act(async () => noteChange(connectionKey(bots[1]), "room"))
    await until(
      async () => find(`a[href="/c/${ROOM}"] [data-needs-you]`) !== null,
      "the mark the change stream carried",
    )
  })
})

test("a room's row draws its members' pictures, four at most, and counts the rest", async () => {
  await fresh()
  // A room of five, each a profile this device holds a bot for: the row shows four and a count.
  // They answer at the room's own Host, as every member of a room does (ADR 0115).
  const seats = ["one", "two", "three", "four", "five"]
  await db.profiles.bulkPut(
    seats.map((profile, at) =>
      botProfile("rooms", {
        id: `bot-${profile}`,
        name: profile,
        baseUrl: HOST,
        hermesProfile: profile,
        botId: ["gem", "hex", "orbi", "penny", "stella"][at],
      }),
    ),
  )
  await db.conversations.put({
    id: "room-five",
    profileId: CARRIER,
    title: "Planning",
    room: {
      id: "room-five",
      members: seats.map((profile, at) => ({ memberId: `m${at}`, profile, handle: profile })),
    },
    createdAt: LAST_AT,
    updatedAt: LAST_AT,
    changedAt: LAST_AT,
  })
  await settle()
  await mount(screen("/"), async () => {
    await until(async () => Boolean(find('[data-room-faces]')), "the room's faces")
    const faces = findAll("[data-room-faces] img")
    assert.equal(faces.length, 4, "four pictures, and no more")
    assert.deepEqual(
      faces.map((one) => one.getAttribute("src")),
      ["/bots/gem.png", "/bots/hex.png", "/bots/orbi.png", "/bots/penny.png"],
      "the seats in the Host's order",
    )
    assert.equal(find("[data-room-faces-more]")?.textContent, "+1", "and the fifth counted")
  })
})

test("Rooms ranks a room by the list's own rule, and offers no order of its own", async () => {
  await fresh()
  const named = [
    { id: "room-zebra", title: "Zebra", at: LAST_AT + 30_000 },
    { id: "room-alpha", title: "Alpha", at: LAST_AT + 10_000 },
    { id: "room-mid", title: "Middle", at: LAST_AT + 20_000 },
  ]
  await db.conversations.bulkPut(
    named.map(({ id, title, at }) => ({
      id,
      profileId: CARRIER,
      title,
      room: { id, members: [] },
      createdAt: at - 1_000,
      updatedAt: at,
      changedAt: at,
    })),
  )
  await settle()
  await mount(screen("/"), async () => {
    await until(async () => band("rooms").length === 3, "all three rooms")
    assert.deepEqual(
      band("rooms"),
      ["/c/room-zebra", "/c/room-mid", "/c/room-alpha"],
      "newest first, as every list here ranks a row — a room has no order of its own to keep",
    )
    absent('[aria-label^="Sort rooms"]', "and no control offers it one")
  })
  // A pin is still lifted above the rest, as a chat's is.
  await db.conversations.update("room-zebra", { pinned: true })
  await settle()
  await mount(screen("/"), async () => {
    await until(async () => band("rooms")[0] === "/c/room-zebra", "the pinned room first")
    assert.equal(band("rooms").length, 3, "with the other two under it")
  })
})
