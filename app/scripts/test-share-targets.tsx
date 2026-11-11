/**
 * The share sheet's rows: the chats, code sessions and rooms of the picked bot that were touched this
 * week, each in the mark of what it is, ten of them and Show more for the rest of the window — the
 * search at the foot, which draws every match a query names, the week's window or not — and a tap on a
 * room, which sends the share the way the room's own composer does. The list is this device's own
 * (Dexie); a room's tap is the only host a case here asks.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { MemoryRouter, Route, Routes } from "react-router"

import { db } from "@/lib/db"
import { clearShare, receiveShare, toShare } from "@/lib/share"
import { SharePage } from "@/routes/share"

import {
  absentText,
  botProfile,
  click,
  find,
  findAll,
  findText,
  json,
  mount,
  Path,
  path,
  seedChats,
  text,
  type,
  until,
  withToasts,
  wordsOf,
} from "./component-kit.tsx"

const HOUR = 3_600_000
const DAY = 86_400_000

const screen = () => (
  <MemoryRouter initialEntries={["/share"]}>
    <Path />
    <Routes>
      <Route path="/share" element={<SharePage />} />
      <Route path="/c/:id" element={<p>the chat</p>} />
    </Routes>
  </MemoryRouter>
)

/**
 * The sheet's rows: every option of the chat list but New chat, which starts one, and Show more,
 * which is a control rather than a place to send.
 */
const rows = () =>
  [...document.querySelectorAll('[aria-label="Recent"] button')].filter((one) => {
    const words = wordsOf(one)
    return words !== "New chat" && !words.startsWith("Show more")
  })

/** The one row a title is drawn on, or none. */
const row = (title: string) => rows().find((one) => wordsOf(one).includes(title)) ?? null

/** A share of a link, which is what a reader sends into a row. */
const shares = () => receiveShare(toShare({ text: "Read this later" }))

/** The box the sheet pins to its foot, and the field inside it. */
const foot = () => document.querySelector('[data-slot="share-search"]')
const searchField = () =>
  document.querySelector('input[aria-label="Search chats and sessions"]') as HTMLInputElement | null

/**
 * Two bots of one Host, so a room's roster resolves to faces and to a seat: a profile name is unique
 * on its Host rather than across a device's bots, so two links of one gateway find each other
 * (ADR 0115).
 */
const roomBots = (name: string) => [
  botProfile(name, { id: "bot-1", name: "Cubby", hermesProfile: "default", botId: "cubby" }),
  botProfile(name, { id: "bot-2", name: "Hex", hermesProfile: "coder", botId: "hex" }),
]

/** A room's record as the read carries it: its roster, one member per profile it seats. */
const roomRecord = (id: string, profiles: string[]) => ({
  id,
  members: profiles.map((profile, at) => ({
    memberId: `${id}-m${at}`,
    profile,
    handle: profile,
    displayName: profile,
  })),
})

/** The strip of bots the sheet sends through, and the card that picks one by name. */
const botCard = (name: string) =>
  findAll('[aria-label="Bot"] button').find((one) => wordsOf(one) === name) ?? null

/** One request a room's Host was sent, as the sheet made it. */
interface RoomAsk {
  method: string
  path: string
  search: string
  body?: string
}

/**
 * A Host that holds a room, as the sheet calls it: `info` advertising the room's routes, the room's
 * page, its attachment store and its send. Every request is kept, so a test can say which route a tap
 * reached and which it left alone.
 */
function roomHost(name: string, roomId: string, { refuse }: { refuse?: string } = {}) {
  const asked: RoomAsk[] = []
  let stored = 0
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = (init?.method ?? "GET").toUpperCase()
    asked.push({
      method,
      path: url.pathname,
      search: url.search,
      body: typeof init?.body === "string" ? init.body : undefined,
    })
    if (url.pathname.endsWith("/plugins/gots/info"))
      return json({ name: "gots", features: ["rooms", "room_media"] })
    if (url.pathname.endsWith(`/plugins/gots/rooms/${roomId}`) && method === "GET")
      return json({
        object: "gots.room",
        room: { id: roomId, name: "Weekly sync", members: [] },
        events: [],
        latestSeq: 0,
        hasMore: false,
        working: false,
        activity: [],
        waiting: [],
        canStop: true,
        canSend: true,
      })
    if (url.pathname.endsWith(`/plugins/gots/rooms/${roomId}/attachment`) && method === "POST") {
      stored += 1
      const file = new URLSearchParams(url.search).get("name") ?? ""
      return json({
        object: "gots.room.attachment",
        attachment: {
          attachmentId: `up${stored}`,
          kind: "file",
          name: file,
          size: 5,
          mime: "text/plain",
        },
      })
    }
    if (url.pathname.endsWith(`/plugins/gots/rooms/${roomId}/send`))
      return refuse
        ? json({ error: { message: refuse } }, 400)
        : json({
            object: "gots.room.sent",
            event: { seq: stored + 1, eventId: "e1", kind: "message.user", text: "" },
          })
    return json({}, 404)
  }) as typeof fetch
  return asked
}

/** The files a share brought, as the sender hands them over. */
const notes = (count: number) =>
  Array.from(
    { length: count },
    (_, index) => new File(["bytes"], `note-${index}.txt`, { type: "text/plain", lastModified: 5 }),
  )

test("a room the picked bot's roster seats is a row among the chats, and switching bots changes them", async () => {
  const now = Date.now()
  await seedChats(
    [
      { id: "c-chat", title: "Trip to Lisbon", at: now - HOUR },
      { id: "room-both", title: "Weekly sync", at: now - 2 * HOUR },
      { id: "room-coder", title: "Coder standup", at: now - 3 * HOUR },
      { id: "room-orphan", title: "Orphan room", at: now - 4 * HOUR },
    ],
    { bots: roomBots("share-rooms") },
  )
  await db.conversations.update("room-both", {
    room: roomRecord("room-both", ["default", "coder"]),
  })
  await db.conversations.update("room-coder", { room: roomRecord("room-coder", ["coder"]) })
  // A member this device holds no bot for: no bot may speak for the room, so no list draws it.
  await db.conversations.update("room-orphan", { room: roomRecord("room-orphan", ["ghost"]) })
  try {
    shares()
    await mount(screen(), async () => {
      await until(async () => rows().length > 0, "the sheet's rows")
      const weekly = row("Weekly sync")
      assert.ok(weekly, "a room the picked bot's roster seats is a row of the sheet")
      assert.ok(
        weekly.querySelector("[data-room-faces]"),
        "wearing its members' faces where a chat wears an icon",
      )
      assert.equal(
        weekly.querySelectorAll("[data-room-faces] img").length,
        2,
        "one face per member this device holds a bot for",
      )
      assert.equal(
        weekly.querySelector("svg.lucide-message-circle"),
        null,
        "and no chat's bubble beside them",
      )
      assert.match(wordsOf(weekly), /2 hr\. ago/, "aged as a chat's row is")
      assert.equal(row("Coder standup"), null, "a room seated by another bot only is not a row")
      assert.equal(row("Orphan room"), null, "and a room no roster here answers for is nobody's")

      await click(botCard("Hex"))
      await until(async () => row("Coder standup") !== null, "the second bot's rooms")
      assert.ok(row("Weekly sync"), "the room both rosters seat is a row of each bot's sheet")
      assert.equal(row("Orphan room"), null, "and the room no bot answers for is still nobody's")
    })
  } finally {
    clearShare()
  }
})

test("tapping a room uploads each file to its store and sends the note as one message", async () => {
  const now = Date.now()
  const room = "room-weekly"
  await seedChats(
    [
      { id: "c-chat", title: "Trip to Lisbon", at: now - HOUR },
      { id: room, title: "Weekly sync", at: now - 2 * HOUR },
    ],
    { bots: roomBots("share-room-send") },
  )
  await db.conversations.update(room, { room: roomRecord(room, ["default"]) })
  const asked = roomHost("share-room-send", room)
  try {
    receiveShare(toShare({ text: "Read this later", files: notes(1) }))
    await mount(screen(), async () => {
      await until(async () => row("Weekly sync") !== null, "the room's row")
      await type(find('textarea[aria-label="Note"]'), "Have a look")
      await click(row("Weekly sync"))
      await until(
        () => Promise.resolve(asked.some((one) => one.path.endsWith(`/rooms/${room}/send`))),
        "the room's message",
      )

      const uploads = asked.filter((one) => one.path.endsWith(`/rooms/${room}/attachment`))
      assert.equal(uploads.length, 1, "each of the share's files goes up to the room's store")
      const minted = new URLSearchParams(uploads[0].search)
      assert.equal(minted.get("name"), "note-0.txt", "under its own name")
      assert.ok(minted.get("upload_id"), "and an upload id the sheet minted")

      const sent = JSON.parse(
        asked.find((one) => one.path.endsWith(`/rooms/${room}/send`))!.body ?? "{}",
      ) as Record<string, unknown>
      assert.ok(sent.event_id, "one event id, minted here")
      assert.equal(
        sent.text,
        "Have a look\n\nRead this later",
        "the note, then what was shared, as one message",
      )
      assert.deepEqual(
        sent.attachments,
        [{ attachmentId: "up1", kind: "file", name: "note-0.txt", size: 5, mime: "text/plain" }],
        "carrying the manifests the Host answered with",
      )
      assert.equal(
        asked.filter((one) => one.path.includes("/messages")).length,
        0,
        "and nothing to a chat's routes",
      )
      assert.equal(
        asked.filter((one) => one.path.includes("/api/sessions")).length,
        0,
        "no chat was created",
      )
      await until(async () => path() === `/c/${room}`, "the room, opened at its own address")
    })
  } finally {
    clearShare()
  }
})

test("a room that refuses the send says the Host's words and leaves the sheet open", async () => {
  const now = Date.now()
  const REFUSED = "That room takes no more messages until its round ends."
  await seedChats(
    [
      { id: "c-chat", title: "Trip to Lisbon", at: now - HOUR },
      { id: "room-weekly", title: "Weekly sync", at: now - 2 * HOUR },
    ],
    { bots: roomBots("share-room-refused") },
  )
  await db.conversations.update("room-weekly", {
    room: roomRecord("room-weekly", ["default"]),
  })
  const asked = roomHost("share-room-refused", "room-weekly", { refuse: REFUSED })
  await withToasts(async (said) => {
    shares()
    await mount(screen(), async () => {
      await until(async () => row("Weekly sync") !== null, "the room's row")
      await click(row("Weekly sync"))
      await until(async () => said.length > 0, "the Host's refusal")
      assert.deepEqual(said, [REFUSED], "the Host's own words, not a sentence about the send")
      assert.equal(
        asked.filter((one) => one.path.endsWith("/send")).length,
        1,
        "one send was tried, and its refusal is not retried",
      )
      assert.ok(row("Weekly sync"), "the sheet stays open, as a chat's failed send leaves it")
      assert.equal(path(), "/share", "on its own address")
    })
  })
})

test("a share of nine files refuses the room in words naming eight, and sends nothing", async () => {
  const now = Date.now()
  await seedChats(
    [
      { id: "c-chat", title: "Trip to Lisbon", at: now - HOUR },
      { id: "room-weekly", title: "Weekly sync", at: now - 2 * HOUR },
    ],
    { bots: roomBots("share-room-cap") },
  )
  await db.conversations.update("room-weekly", { room: roomRecord("room-weekly", ["default"]) })
  const asked = roomHost("share-room-cap", "room-weekly")
  await withToasts(async (said) => {
    receiveShare(toShare({ text: "Read this later", files: notes(9) }))
    await mount(screen(), async () => {
      await until(async () => row("Weekly sync") !== null, "the room's row")
      await click(row("Weekly sync"))
      await until(async () => said.length > 0, "the room's refusal")
      assert.deepEqual(
        said,
        ["A room's message can carry 8 attachments, so a share of 9 can't go there."],
        "the refusal names the number a room's message takes",
      )
      assert.equal(
        asked.filter((one) => one.method === "POST").length,
        0,
        "nothing at all is sent, not even the files",
      )
      assert.ok(row("Weekly sync"), "the sheet is left as it was")

      // A chat still takes them: the room's cap is the room's, not the share's.
      await click(row("Trip to Lisbon"))
      await until(async () => path() === "/c/c-chat", "the chat the share went into")
    })
  })
})

test("the sheet offers a chat and a code session of the last week, each in its own mark", async () => {
  const now = Date.now()
  await seedChats(
    [
      { id: "c-chat", title: "Trip to Lisbon", at: now - HOUR },
      { id: "c-session", title: "Fix the flaky test", at: now - 2 * HOUR },
      { id: "c-old", title: "Last month's plans", at: now - 30 * DAY },
    ],
    { bots: [botProfile("share-targets")] },
  )
  // A code session is a chat of a project's: the same record, one field apart (AGENTS.md, Code).
  await db.conversations.update("c-session", { projectId: "project-1" })
  try {
    shares()
    await mount(screen(), async () => {
      await until(async () => rows().length > 0, "the sheet's rows")
      const chat = row("Trip to Lisbon")
      const session = row("Fix the flaky test")
      assert.ok(chat, "a chat of the bot's is a row")
      assert.ok(session, "and so is a code session of it")
      assert.ok(chat.querySelector("svg.lucide-message-circle"), "a chat wears its bubble")
      assert.ok(session.querySelector("svg.lucide-code-xml"), "a session wears Code's mark")
      assert.equal(row("Last month's plans"), null, "a chat from last month is not on the sheet")
    })
  } finally {
    clearShare()
  }
})

test("the sheet draws ten rows, and Show more reveals the rest of the week", async () => {
  const now = Date.now()
  // Thirty chats touched this week: ten are drawn, and the window's own twenty-five is behind Show
  // more.
  await seedChats(
    Array.from({ length: 30 }, (_, index) => ({
      id: `c-${index}`,
      title: `Row ${index}`,
      at: now - index * 60_000,
    })),
    { bots: [botProfile("share-showmore")] },
  )
  try {
    shares()
    await mount(screen(), async () => {
      await until(async () => rows().length >= 10, "the sheet's ten rows")
      assert.equal(rows().length, 10, "ten rows, no more")
      const more = findText('[aria-label="Recent"] button', "Show more")
      assert.ok(more, "Show more is offered while the week holds more than ten")
      await click(more)
      await until(async () => rows().length > 10, "the rest of the week")
      assert.equal(rows().length, 25, "the rest of the window, and never past its twenty-five")
      absentText('[aria-label="Recent"] button', "Show more")
    })
  } finally {
    clearShare()
  }
})

test("a week of ten rows draws no Show more", async () => {
  const now = Date.now()
  await seedChats(
    Array.from({ length: 10 }, (_, index) => ({
      id: `c-${index}`,
      title: `Row ${index}`,
      at: now - index * 60_000,
    })),
    { bots: [botProfile("share-exactly-ten")] },
  )
  try {
    shares()
    await mount(screen(), async () => {
      await until(async () => rows().length >= 10, "the sheet's ten rows")
      assert.equal(rows().length, 10, "every row of the week is drawn")
      absentText('[aria-label="Recent"] button', "Show more")
    })
  } finally {
    clearShare()
  }
})

test("a search at the foot finds the chat the week left out, and clearing it puts the week back", async () => {
  const now = Date.now()
  // Twelve chats of the week, so Show more is offered over the ten, and one from last month that
  // only the search can reach.
  await seedChats(
    [
      ...Array.from({ length: 12 }, (_, index) => ({
        id: `c-${index}`,
        title: `Row ${index}`,
        at: now - index * 60_000,
      })),
      { id: "c-old", title: "Last month's plans", at: now - 30 * DAY },
    ],
    { bots: [botProfile("share-search")] },
  )
  try {
    shares()
    await mount(screen(), async () => {
      await until(async () => rows().length === 10, "the sheet's ten rows")
      const field = searchField()
      assert.ok(field, "the field is on the sheet")
      assert.ok(foot()?.contains(field), "in the box the sheet pins to its foot")
      const list = find('[aria-label="Recent"]')
      assert.ok(list, "the list it sits below")
      assert.ok(
        list.compareDocumentPosition(foot()!) & Node.DOCUMENT_POSITION_FOLLOWING,
        "and the foot comes after the list, in the sheet's own scroll",
      )

      await type(searchField(), "last month")
      await until(async () => rows().length === 1, "the one row the query names")
      assert.match(
        wordsOf(rows()[0]),
        /Last month's plans/,
        "a chat from last month, which the window leaves out",
      )
      absentText('[aria-label="Recent"] button', "Show more")

      // Every match, not the ten a window draws first: the week's twelve all say Row.
      await type(searchField(), "row")
      await until(async () => rows().length === 12, "every match")
      absentText('[aria-label="Recent"] button', "Show more")

      await type(searchField(), "qqqzzz")
      await until(async () => rows().length === 0, "no rows at all")
      assert.match(text(), /Nothing matches\./, "the sheet says so, in the line the lists use")

      await type(searchField(), "")
      await until(async () => rows().length === 10, "the week back")
      assert.ok(
        findText('[aria-label="Recent"] button', "Show more"),
        "with the window's ten rows and Show more behind them",
      )
    })
  } finally {
    clearShare()
  }
})
