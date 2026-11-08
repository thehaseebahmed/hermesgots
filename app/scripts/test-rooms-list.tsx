/**
 * A room on a device that has never opened it: the plugin's chat list carries the room's record, the
 * merge writes one `Conversation` for it, and Recents draws that row once — its name, its members and
 * its last activity — while no bot's Main lists it as a thread. A second merge of the same record
 * writes nothing (ADR 0116).
 *
 * A room then takes part in the room it joined: it is ordered among Recents by its last activity, a
 * pinned room stands in the pinned band rather than a section of its own, and the row says the room
 * needs the user until the device has drawn what asks — which is the room's own screen opening.
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
import { chatOwner } from "@/lib/chat-owner"
import { db, chatTombstones, type Profile } from "@/lib/db"
import { formatRelative } from "@/lib/format"
import { connectionKey, noteChange } from "@/lib/live"
import { syncNow } from "@/lib/sync"
import { useBotPane, useThreads } from "@/lib/threads"
import {
  atWidth,
  botProfile,
  find,
  findAll,
  json,
  mount,
  Path,
  seedSettings,
  settle,
  until,
} from "./component-kit.tsx"

const HOST = "http://rooms.test/v1"
const CARRIER = "bot-carrier"
const CODER = "bot-coder"

const ROOM = "room-1"
const LAST_AT = Date.now() - 5 * 60_000

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
        { memberId: "m2", profile: "writer", handle: "writer" },
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
  { chats = false, ask = false }: { chats?: boolean; ask?: boolean } = {},
) {
  moved.at = LAST_AT
  moved.title = "Planning"
  retired = false
  split = false
  log = ask ? asks() : []
  await seedSettings({ onboarded: true, legacyChat: true, movedChats: bots.map((bot) => bot.id) })
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

function Threads({ profileId }: { profileId: string }) {
  const threads = useThreads(profileId) ?? []
  return <span data-threads={profileId}>{threads.map((thread) => thread.chat.id).join(",")}</span>
}

test("no bot's Main lists the room as one of its threads", async () => {
  await fresh()
  await merged()
  await mount(
    <>
      <Threads profileId={CARRIER} />
      <Threads profileId={CODER} />
    </>,
    async () => {
      await settle()
      for (const held of findAll("[data-threads]")) {
        const ids = (held.textContent ?? "").split(",").filter(Boolean)
        assert.ok(
          !ids.includes(ROOM),
          `${held.getAttribute("data-threads")}'s Main must not list a room among its threads`,
        )
      }
    },
  )
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
  "a room's address opens no bot's pane: it is not one of a bot's threads",
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
          "a room is its own screen, so nothing stands beside it as a thread",
        )
      },
    )
  }),
)

function Pane() {
  const pane = useBotPane(true)
  return <span data-pane>{JSON.stringify(pane ? { bot: pane.profileId, lane: pane.lane } : null)}</span>
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

test("the sidebar every device gets draws the room's row", async () => {
  await fresh()
  // The default layout: bots, not Recents.
  await seedSettings({ onboarded: true, legacyChat: false, movedChats: bots.map((bot) => bot.id) })
  await merged()
  await mount(screen("/"), async () => {
    await until(async () => Boolean(find(`a[href="/c/${ROOM}"]`)), "the room's row")
    assert.equal(findAll(`a[href="/c/${ROOM}"]`).length, 1, "one row for the room")
  })
})

test("a room takes its place among Recents by its last activity", async () => {
  await fresh({ chats: true })
  await merged()
  await mount(screen("/"), async () => {
    await until(async () => band("recents").includes(`/c/${ROOM}`), "the room's row among Recents")
    assert.deepEqual(
      band("recents"),
      [`/c/${CHAT_NEWER}`, `/c/${ROOM}`, `/c/${CHAT_OLDER}`],
      "the room is sorted with the chats, by its own last activity",
    )
  })
})

test("a pinned room stands in the pinned band, not in Recents", async () => {
  await fresh({ chats: true })
  await merged()
  // A room's record carries no pin — the Host's room has none (ADR 0116) — so the pin is this
  // device's own, and the merge that follows must not take it away.
  await db.conversations.update(ROOM, { pinned: true })
  await syncNow()
  await settle()
  assert.equal((await db.conversations.get(ROOM))?.pinned, true, "the room's own pin stands")
  await mount(screen("/"), async () => {
    await until(async () => band("pinned").includes(`/c/${ROOM}`), "the pinned band's room")
    assert.deepEqual(band("pinned"), [`/c/${ROOM}`], "the pin lifts the room, as it lifts a chat")
    assert.ok(
      !band("recents").includes(`/c/${ROOM}`),
      "a pinned room is lifted out of Recents rather than drawn twice",
    )
  })
})

test("a pinned chat is lifted into the same band, so the room joins one rule", async () => {
  await fresh({ chats: true })
  await db.conversations.update(CHAT_OLDER, { pinned: true })
  await merged()
  await mount(screen("/"), async () => {
    await until(async () => band("pinned").includes(`/c/${CHAT_OLDER}`), "the pinned chat")
    assert.deepEqual(
      band("pinned"),
      [`/c/${CHAT_OLDER}`],
      "a chat and a room are drawn by the same band",
    )
    assert.deepEqual(band("recents"), [`/c/${CHAT_NEWER}`, `/c/${ROOM}`], "and leave Recents")
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
    await until(async () => band("recents").includes(`/c/${ROOM}`), "the room's row")
    await settle()
    assert.equal(
      find(`a[href="/c/${ROOM}"] [data-needs-you]`),
      null,
      "a room open on this device no longer needs the user",
    )
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
      async () => (await needOf())?.seq === undefined,
      "the device's reading of a room that no longer asks",
    )
    assert.equal(
      find(`a[href="/c/${ROOM}"] [data-needs-you]`),
      null,
      "an answered room's row says nothing",
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
    await until(async () => band("recents").includes(`/c/${ROOM}`), "the room's row")
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
