/**
 * The share sheet's rows: the chats, code sessions and rooms of the picked bot that were touched this
 * week, each in the mark of what it is, ten of them and Show more for the rest of the window — the
 * search at the foot, which draws every match a query names, the week's window or not — and a tap on a
 * room, which sends the share the way the room's own composer does. The list is this device's own
 * (Dexie); a room's tap is the only host a case here asks.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { act } from "react"
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
  settle,
  shutSheet,
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
  [...document.querySelectorAll(`${LIST} button`)].filter((one) => {
    const words = wordsOf(one)
    return words !== "New chat" && !words.startsWith("Show more")
  })

const row = (title: string) => rows().find((one) => wordsOf(one).includes(title)) ?? null

/**
 * The list the sheet's rows are in. It is the week's while no query is up and a match list while one
 * is, and it says which in its own name, so a test follows it by either.
 */
const LIST = ':is([aria-label="Recent"], [aria-label="Search Results"])'

/** The heading over that list: what the sheet calls the rows under it. */
const heading = () => wordsOf(find(LIST)?.parentElement?.querySelector("h2") ?? null)

const shares = () => receiveShare(toShare({ text: "Read this later" }))

const foot = () => document.querySelector('[data-slot="share-search"]')
// The field's own name is the sheet's to choose, so a case reaches it by the start of that name and
// the search test says what the name must be.
const searchField = () =>
  document.querySelector('input[aria-label^="Search chats"]') as HTMLInputElement | null

/**
 * Two bots of one Host, so a room's roster resolves to faces and to a seat: a profile name is unique
 * on its Host rather than across a device's bots, so two links of one gateway find each other
 * (ADR 0115).
 */
const roomBots = (name: string) => [
  botProfile(name, { id: "bot-1", name: "Cubby", hermesProfile: "default", botId: "cubby" }),
  botProfile(name, { id: "bot-2", name: "Hex", hermesProfile: "coder", botId: "hex" }),
]

const roomRecord = (id: string, profiles: string[]) => ({
  id,
  members: profiles.map((profile, at) => ({
    memberId: `${id}-m${at}`,
    profile,
    handle: profile,
    displayName: profile,
  })),
})

/**
 * Picks a bot in the sheet's picker, which is the app's own: a pill that names the bot it is on, and
 * a menu of the others under it. The pill is what a tap opens; the menu's item is the pick.
 */
async function pickBot(name: string) {
  const pill = document.querySelector('button[aria-label^="Bot: "]')
  assert.ok(pill, "the sheet's bot picker")
  await click(pill)
  const items = '[role="menuitemradio"], [role="menuitem"]'
  await until(async () => Boolean(findText(items, name)), `the picker's row for ${name}`)
  await click(findText(items, name))
}

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

const notes = (count: number) =>
  Array.from(
    { length: count },
    (_, index) => new File(["bytes"], `note-${index}.txt`, { type: "text/plain", lastModified: 5 }),
  )

/**
 * A latch over one read: `shut()` makes the next read through it wait, `open()` lets every waiting
 * read land, and `wait()` is asked at call time, so a read issued after the latch shut waits too.
 */
function latch() {
  let release: () => void = () => {}
  // Open until a case shuts it: a latch that started shut would hold the reads a case needs to begin.
  let held: Promise<void> | undefined
  return {
    wait: () => held ?? Promise.resolve(),
    open: () => {
      release()
      held = undefined
    },
    shut: () => {
      held = new Promise<void>((resolve) => {
        release = resolve
      })
    },
  }
}

/**
 * Holds the sheet's two live reads apart, so a case can stand in the beat between a pick and the rows
 * that belong to it: the bot's chats (which `conversationsOf` reads through
 * `where("[profileId+updatedAt]").between(...)`) and the device's room list (`useRoomNeeds` filters
 * every conversation it holds). The app's own code runs either way; only when each read is answered
 * is the test's.
 */
function holdReads() {
  const chats = latch()
  const rooms = latch()
  const table = db.conversations as unknown as Record<string, unknown>
  const own = (key: string) => {
    const saved = table[key]
    const had = Object.prototype.hasOwnProperty.call(table, key)
    return () => (had ? (table[key] = saved) : delete table[key])
  }
  const restoreWhere = own("where")
  const restoreFilter = own("filter")
  const where = (db.conversations.where as (...args: unknown[]) => unknown).bind(db.conversations)
  const filter = (db.conversations.filter as (...args: unknown[]) => unknown).bind(db.conversations)
  table.where = (...args: unknown[]) => {
    const clause = where(...args) as Record<string, unknown>
    const between = (clause.between as (...all: unknown[]) => unknown).bind(clause)
    clause.between = (...bounds: unknown[]) => {
      const collection = between(...bounds) as Record<string, unknown>
      const toArray = (collection.toArray as () => Promise<unknown>).bind(collection)
      collection.toArray = () => chats.wait().then(() => toArray())
      return collection
    }
    return clause
  }
  table.filter = (...args: unknown[]) => {
    const collection = filter(...args) as Record<string, unknown>
    const toArray = (collection.toArray as () => Promise<unknown>).bind(collection)
    collection.toArray = () => rooms.wait().then(() => toArray())
    return collection
  }
  return {
    chats,
    rooms,
    restore() {
      restoreWhere()
      restoreFilter()
    },
  }
}

test("the bot picker lists the bots by name and starts on the first, whatever was active", async () => {
  const now = Date.now()
  const zeta = botProfile("share-picker", {
    id: "bot-z",
    name: "Zeta",
    hermesProfile: "zeta",
    botId: "zeta",
  })
  const alpha = botProfile("share-picker", {
    id: "bot-a",
    name: "Alpha",
    hermesProfile: "alpha",
    botId: "alpha",
  })
  const mango = botProfile("share-picker", {
    id: "bot-m",
    name: "Mango",
    hermesProfile: "mango",
    botId: "mango",
  })
  await seedChats(
    [
      { id: "c-alpha", title: "Alpha's own chat", at: now - HOUR, profileId: "bot-a" },
      { id: "c-zeta", title: "Zeta's own chat", at: now - 2 * HOUR, profileId: "bot-z" },
    ],
    { bots: [zeta, alpha, mango], active: "bot-z" },
  )
  try {
    shares()
    await mount(screen(), async () => {
      const pill = () => find('button[aria-label^="Bot: "]')
      await until(async () => Boolean(pill()), "the sheet's bot picker")
      assert.equal(
        pill()!.getAttribute("aria-label"),
        "Bot: Alpha",
        "the first bot by name, not the account's active one",
      )
      await until(async () => row("Alpha's own chat") !== null, "the first bot's rows")
      assert.equal(row("Zeta's own chat"), null, "and no row of the bot that was active")

      await click(pill())
      await until(
        async () => findAll('[role="menuitemradio"]').length === 3,
        "the picker's three bots",
      )
      assert.deepEqual(
        findAll('[role="menuitemradio"]').map((one) => wordsOf(one)),
        ["Alpha", "Mango", "Zeta"],
        "listed by name",
      )
      assert.equal(
        findAll('[role="menuitem"]').filter((one) => wordsOf(one).includes("Link a bot")).length,
        0,
        "the menu is the bots and nothing else: linking one is Settings' own row",
      )
      await click(findText('[role="menuitemradio"], [role="menuitem"]', "Zeta"))
      await until(async () => row("Zeta's own chat") !== null, "the picked bot's rows")
      assert.equal(row("Alpha's own chat"), null, "the list follows the bot picked")
      assert.equal(pill()!.getAttribute("aria-label"), "Bot: Zeta", "and the pill says so")
    })
  } finally {
    clearShare()
  }
})

test("a room the picked bot's roster seats is a row among the chats, and switching bots changes them", async () => {
  const now = Date.now()
  await seedChats(
    [
      { id: "c-chat", title: "Trip to Lisbon", at: now - HOUR, profileId: "bot-1" },
      { id: "c-hex", title: "Hex's own log", at: now - 90 * 60_000, profileId: "bot-2" },
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

      await pickBot("Hex")
      await until(async () => row("Coder standup") !== null, "the second bot's rooms")
      assert.ok(row("Weekly sync"), "the room both rosters seat is a row of each bot's sheet")
      assert.equal(row("Orphan room"), null, "and the room no bot answers for is still nobody's")
      assert.equal(
        row("Trip to Lisbon"),
        null,
        "the bot switched away from keeps no row on the sheet that is drawn now",
      )
      assert.ok(row("Hex's own log"), "while the bot picked draws its own chat")
    })
  } finally {
    clearShare()
  }
})

test("a pick draws nothing of the bot it left, even before the next bot's chats are read", async () => {
  const now = Date.now()
  await seedChats(
    [
      { id: "c-cubby", title: "Cubby's chat", at: now - HOUR, profileId: "bot-1" },
      { id: "c-hex", title: "Hex's chat", at: now - 2 * HOUR, profileId: "bot-2" },
      { id: "room-hex", title: "Hex's room", at: now - 3 * HOUR, profileId: "bot-2" },
    ],
    { bots: roomBots("share-switch"), active: "bot-1" },
  )
  await db.conversations.update("room-hex", { room: roomRecord("room-hex", ["coder"]) })
  const held = holdReads()
  try {
    shares()
    await mount(screen(), async () => {
      await until(async () => row("Cubby's chat") !== null, "the first bot's chat")

      // The pick lands, and the second bot's chats are still being read: the sheet must not answer
      // with the first bot's rows beside the second bot's rooms, where a tap would send into one bot's
      // chat under the other bot's name.
      held.chats.shut()
      await pickBot("Hex")
      await settle()
      assert.equal(row("Cubby's chat"), null, "the first bot's chat is gone the moment it is left")
      assert.equal(row("Hex's chat"), null, "and the second's is not drawn before it is read")
      assert.equal(row("Hex's room"), null, "no row at all, its own rooms included")

      held.chats.open()
      await until(async () => row("Hex's chat") !== null, "the second bot's chat")
      assert.ok(row("Hex's room"), "the second bot's rows arrive together")
      assert.equal(row("Cubby's chat"), null, "and the first bot's stay behind")
    })
  } finally {
    held.restore()
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
      const note = find('textarea[aria-label="Note"]') as HTMLTextAreaElement | null
      assert.equal(note?.value, "Read this later", "the sender's text opens the note")
      // What the reader writes joins it: the field is the message's only account of the words.
      await type(find('textarea[aria-label="Note"]'), "Read this later\n\nHave a look")
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

      const sends = asked.filter((one) => one.path.endsWith(`/rooms/${room}/send`))
      assert.equal(sends.length, 1, "one tap makes one send, and never a second")
      const sent = JSON.parse(sends[0].body ?? "{}") as Record<string, unknown>
      assert.ok(sent.event_id, "one event id, minted here")
      assert.equal(
        sent.text,
        "Read this later\n\nHave a look",
        "the field's words as one message, the sender's text in them once",
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
      const again = row("Weekly sync") as HTMLButtonElement | null
      assert.ok(again, "with the room still on it")
      assert.equal(again.disabled, false, "and its row offered again, ready for another tap")
      assert.equal(path(), "/share", "on its own address")
    })
  })
})

test("a room send tapped again after a refusal is the one message, and a changed note is another", async () => {
  const now = Date.now()
  const room = "room-weekly"
  const REFUSED = "That room takes no more messages until its round ends."
  await seedChats(
    [
      { id: "c-chat", title: "Trip to Lisbon", at: now - HOUR },
      { id: room, title: "Weekly sync", at: now - 2 * HOUR },
    ],
    { bots: roomBots("share-room-retry") },
  )
  await db.conversations.update(room, { room: roomRecord(room, ["default"]) })
  const asked = roomHost("share-room-retry", room, { refuse: REFUSED })
  const sends = () =>
    asked
      .filter((one) => one.path.endsWith(`/rooms/${room}/send`))
      .map((one) => JSON.parse(one.body ?? "{}") as { event_id?: string; attachments?: unknown[] })
  const uploads = () => asked.filter((one) => one.path.endsWith(`/rooms/${room}/attachment`))

  await withToasts(async (said) => {
    receiveShare(toShare({ text: "Read this later", files: notes(2) }))
    await mount(screen(), async () => {
      await until(async () => row("Weekly sync") !== null, "the room's row")
      const note = find('textarea[aria-label="Note"]') as HTMLTextAreaElement | null
      assert.equal(note?.value, "Read this later", "the sender's text opens the note")
      // What the reader writes joins it: the field is the message's only account of the words.
      await type(find('textarea[aria-label="Note"]'), "Read this later\n\nHave a look")
      await click(row("Weekly sync"))
      await until(async () => said.length === 1, "the Host's refusal")
      const first = sends()[0]

      // Nothing of that message is in the room — the Host refused it — so a tap again sends the same
      // one: the answer to the first tap may only have been lost, and the room's own composer would
      // post it under the id it minted, naming the files it already stored.
      await click(row("Weekly sync"))
      await until(async () => said.length === 2, "the second refusal")

      assert.deepEqual(
        sends().map((one) => one.event_id),
        [first.event_id, first.event_id],
        "both taps post the one event the first minted",
      )
      assert.equal(
        uploads().length,
        2,
        "each of the share's files went to the store once, the second tap sending no bytes again",
      )

      // A note the reader changed is a different message, and mints its own ids: the Host binds an id
      // to its content, so the id the first tap minted would be refused for these words.
      await type(find('textarea[aria-label="Note"]'), "Have another look")
      await click(row("Weekly sync"))
      await until(async () => said.length === 3, "the third refusal")
      assert.notEqual(sends()[2].event_id, first.event_id, "a changed note is a new message")
      assert.equal(
        uploads().length,
        4,
        "and sends every file again, as a message no store has yet must",
      )
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

test('a query naming a room is not answered "nothing matches" before the room list is read', async () => {
  const now = Date.now()
  await seedChats(
    [
      { id: "c-chat", title: "Trip to Lisbon", at: now - HOUR },
      { id: "room-weekly", title: "Weekly sync", at: now - 2 * HOUR },
    ],
    { bots: roomBots("share-rooms-out") },
  )
  await db.conversations.update("room-weekly", { room: roomRecord("room-weekly", ["default"]) })
  const held = holdReads()
  held.rooms.shut()
  try {
    shares()
    await mount(screen(), async () => {
      await until(async () => rows().length === 1, "the chat the sheet has read")
      await type(searchField(), "Week")
      assert.equal(rows().length, 0, "the room the query names is not drawn while its read is out")
      assert.doesNotMatch(
        text(),
        /Nothing matches\./,
        "and the sheet does not answer with nothing matches a row it has not read yet",
      )

      held.rooms.open()
      await until(async () => row("Weekly sync") !== null, "the room the query names")
      assert.doesNotMatch(
        text(),
        /Nothing matches\./,
        "nor once the room has answered and is drawn",
      )
    })
  } finally {
    held.restore()
    clearShare()
  }
})

test("a tap on a room the sheet no longer offers says so, and posts nothing", async () => {
  const now = Date.now()
  const room = "room-weekly"
  await seedChats(
    [
      { id: "c-chat", title: "Trip to Lisbon", at: now - HOUR },
      { id: room, title: "Weekly sync", at: now - 2 * HOUR },
    ],
    { bots: roomBots("share-room-gone") },
  )
  await db.conversations.update(room, { room: roomRecord(room, ["default"]) })
  const asked = roomHost("share-room-gone", room)
  await withToasts(async (said) => {
    receiveShare(toShare({ text: "Read this later" }))
    await mount(screen(), async () => {
      await until(async () => row("Weekly sync") !== null, "the room's row")
      const stale = row("Weekly sync")
      assert.ok(stale, "the room's row is on screen")

      // The record goes while the reader's finger is already on the row: the tap lands before the list
      // is redrawn without it, and the sheet must not send the note into a room it no longer offers.
      await act(async () => {
        await db.conversations.delete(room)
        stale.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
      })
      await until(async () => said.length > 0, "the sheet's word about the room")
      assert.deepEqual(said, ["That room isn't on the sheet any more."], "it says the room is gone")
      assert.equal(
        asked.filter((one) => one.method === "POST").length,
        0,
        "and posts nothing there, neither the files nor the note",
      )
      assert.equal(path(), "/share", "leaving the reader where they are")
    })
  })
})

test("a sheet the reader shuts mid-send sends nothing on, and says nothing to nobody", async () => {
  const now = Date.now()
  const room = "room-weekly"
  await seedChats(
    [
      { id: "c-chat", title: "Trip to Lisbon", at: now - HOUR },
      { id: room, title: "Weekly sync", at: now - 2 * HOUR },
    ],
    { bots: roomBots("share-room-away") },
  )
  await db.conversations.update(room, { room: roomRecord(room, ["default"]) })
  // A Host whose send is still out when the reader shuts the sheet, and answers after they have gone:
  // `answer(true)` lands the note, `answer(false)` refuses it.
  let answer: (lands: boolean) => void = () => {}
  const asked: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    asked.push(url.pathname)
    if (url.pathname.endsWith("/plugins/gots/info"))
      return json({ name: "gots", features: ["rooms", "room_media"] })
    if (url.pathname.endsWith(`/rooms/${room}/send`))
      return new Promise<Response>((resolve, reject) => {
        answer = (lands) =>
          lands
            ? resolve(
                json({
                  object: "gots.room.sent",
                  event: { seq: 1, eventId: "e1", kind: "message.user", text: "" },
                }),
              )
            : reject(new Error("The room's Host didn't answer."))
      })
    return json({}, 404)
  }) as typeof fetch

  /**
   * A reader who opens the sheet, taps the room, and shuts the sheet while the note is still out —
   * then the Host's answer, which lands (`lands`) or is a refusal, to a screen that has gone.
   */
  const tapAndLeave = async (lands: boolean, said: string[]) => {
    receiveShare(toShare({ text: "Read this later" }))
    await mount(screen(), async () => {
      await until(async () => row("Weekly sync") !== null, "the room's row")
      await click(row("Weekly sync"))
      await until(async () => asked.some((one) => one.endsWith("/send")), "the note on its way")
      await shutSheet(() => find('[role="dialog"]'))
      assert.equal(path(), "/", "the sheet's close leaves the reader on the home screen")

      await act(async () => answer(lands))
      await settle()
      assert.equal(path(), "/", "and an answer that lands later does not take them into the room")
      assert.deepEqual(said, [], "nor does a word about it land on the home screen")
    })
  }

  await withToasts(async (said) => tapAndLeave(true, said))
  await withToasts(async (said) => tapAndLeave(false, said))
})

test("a chat send the Host never answers, shut mid-send, leaves the reader on the home screen", async () => {
  const now = Date.now()
  await seedChats([{ id: "c-chat", title: "Trip to Lisbon", at: now - HOUR }], {
    bots: [botProfile("share-chat-away")],
  })
  // A Host that answers nothing at all: the chat's catch-up read is still out when the reader shuts
  // the sheet, and the note it was sent for has not been posted.
  const asked: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    asked.push(new URL(String(input)).pathname)
    return new Promise<Response>(() => {})
  }) as typeof fetch

  await withToasts(async (said) => {
    shares()
    await mount(screen(), async () => {
      await until(async () => row("Trip to Lisbon") !== null, "the chat's row")
      await click(row("Trip to Lisbon"))
      await until(async () => asked.length > 0, "the chat's catch-up read")
      await shutSheet(() => find('[role="dialog"]'))
      assert.equal(path(), "/", "the sheet's close leaves the reader on the home screen")

      // The catch-up read is raced out after a beat, and the tap would then land on the chat it was
      // aimed at: a screen the reader has left neither takes them there nor says a word to nobody.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1_600))
      })
      await settle()
      assert.equal(path(), "/", "and a send left out does not take them into the chat")
      assert.deepEqual(said, [], "nor does a word about it land on the home screen")
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
      const more = findText(`${LIST} button`, "Show more")
      assert.ok(more, "Show more is offered while the week holds more than ten")
      await click(more)
      await until(async () => rows().length > 10, "the rest of the week")
      assert.equal(rows().length, 25, "the rest of the window, and never past its twenty-five")
      absentText(`${LIST} button`, "Show more")
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
      absentText(`${LIST} button`, "Show more")
    })
  } finally {
    clearShare()
  }
})

test("a search at the foot finds the chat the week left out, and clearing it puts the week back", async () => {
  const now = Date.now()
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
      assert.equal(
        field.getAttribute("aria-label"),
        "Search chats, sessions and rooms",
        "and its name is everything it searches, rooms included",
      )
      assert.ok(foot()?.contains(field), "in the box the sheet pins to its foot")
      assert.equal(heading(), "Recent", "the list is the week's while no query is up")
      const list = find(LIST)
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
      assert.equal(heading(), "Search Results", "the heading says the list is a search's, not the week")
      absentText(`${LIST} button`, "Show more")

      // Every match, not the ten a window draws first: the week's twelve all say Row.
      await type(searchField(), "row")
      await until(async () => rows().length === 12, "every match")
      absentText(`${LIST} button`, "Show more")

      await type(searchField(), "qqqzzz")
      await until(async () => rows().length === 0, "no rows at all")
      assert.match(text(), /Nothing matches\./, "the sheet says so, in the line the lists use")

      await type(searchField(), "")
      await until(async () => rows().length === 10, "the week back")
      assert.equal(heading(), "Recent", "and the heading is the week's again")
      assert.ok(
        findText(`${LIST} button`, "Show more"),
        "with the window's ten rows and Show more behind them",
      )
    })
  } finally {
    clearShare()
  }
})
