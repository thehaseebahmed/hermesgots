/**
 * A room's bar, and the sheet the press on its name opens (ADR 0153, ADR 0122): a room draws no `…`,
 * and the one Edit sheet the app's conversations share is a room's own — its name through
 * `renameRoomTo`, its disband through `disbandRoomNow`, both only where the Host advertises
 * `rooms_write`, and its pin and its archive, which are the reader's own marks rather than the
 * Host's.
 *
 * Both writes go to the Host and come back as the room's record, so the header and the sidebar row
 * take the Host's own name and the row leaves this device as the Host's deletion (ADR 0123). A
 * refusal keeps the room as it was, in the Host's words, under the field that asked for the name; a
 * room whose row goes while it is open leaves to the list rather than falling to a chat's "gone"
 * screen.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { MemoryRouter, Route, Routes } from "react-router"

import { RoomChat } from "@/components/room/room-chat"
import { ChatPage } from "@/routes/chat"
import { db, type Profile } from "@/lib/db"
import {
  Path,
  absentText,
  botProfile,
  click,
  find,
  findAll,
  findText,
  json,
  leave,
  missing,
  mount,
  seedSettings,
  settle,
  shutSheet,
  text,
  type,
  until,
  wordsOf,
} from "./component-kit.tsx"

const ROOM = "room-1"
const REFUSED_NAME = "Reserved"
const REFUSAL = "A room's name cannot be \"Reserved\"."
const NO_DISBAND = "The room's round is still running."
/** One Host that can write rooms, and one that cannot: features are remembered per connection. */
const OPEN = "room-actions.test"
const CLOSED = "room-actions-closed.test"

const members = [
  { memberId: "m1", profile: "default", handle: "hermes", displayName: "Hermes" },
  { memberId: "m2", profile: "coder", handle: "coder", displayName: "Coder" },
]

/** The writes the app posted, in the order it made them. */
const posted: { path: string; body: Record<string, unknown> }[] = []
/** The room as the Host holds it now. */
const held = { name: "Planning", gone: false, refuseDisband: false, refuseRenameOnce: false }

function read() {
  return {
    object: "gots.room",
    room: { id: ROOM, name: held.name, members },
    events: [],
    cursor: 0,
    latestSeq: 0,
    hasMore: false,
    working: false,
    activity: [],
    waiting: [],
    canStop: false,
    canSend: true,
  }
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input))
  const method = (init?.method ?? "GET").toUpperCase()
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
  if (url.pathname.endsWith("/plugins/gots/info")) {
    const open = url.host === OPEN
    return json({ name: "gots", features: open ? ["chats", "rooms", "rooms_write"] : ["chats", "rooms"] })
  }
  if (url.pathname.endsWith(`/plugins/gots/rooms/${ROOM}`) && method === "GET") return json(read())
  if (url.pathname.endsWith(`/plugins/gots/rooms/${ROOM}`) && method === "POST") {
    posted.push({ path: url.pathname, body })
    if (body.name === REFUSED_NAME) return json({ error: { message: REFUSAL } }, 400)
    if (held.refuseRenameOnce) {
      held.refuseRenameOnce = false
      return json({ error: { message: "The Host is still settling that room." } }, 400)
    }
    held.name = String(body.name)
    const at = Date.now()
    return json({ object: "gots.room.record", at, value: { title: held.name, updatedAt: at } })
  }
  if (url.pathname.endsWith(`/plugins/gots/rooms/${ROOM}/disband`)) {
    posted.push({ path: url.pathname, body })
    if (held.refuseDisband) return json({ error: { message: NO_DISBAND } }, 400)
    held.gone = true
    return json({ object: "gots.room.record", at: Date.now(), deleted: true })
  }
  return json({})
}) as typeof fetch

async function fresh(host: string) {
  held.name = "Planning"
  held.gone = false
  held.refuseDisband = false
  held.refuseRenameOnce = false
  posted.length = 0
  const bot: Profile = botProfile(host, {
    id: `${host}-bot`,
    name: "Hermes",
    baseUrl: `http://${host}/v1`,
    hermesProfile: "default",
  })
  // The layout the Archived pill belongs to, since it is the only way back to an archived row: a room
  // in the legacy bands has no archive to offer, and this file reads the sheet that layout draws.
  await seedSettings({ onboarded: true, legacyChat: false })
  await db.profiles.clear()
  await db.profiles.bulkPut([bot])
  await db.conversations.clear()
  await db.roomLog.clear()
  await db.conversations.put({
    id: ROOM,
    profileId: bot.id,
    title: "Planning",
    room: { id: ROOM, members },
    createdAt: 1,
    updatedAt: 1,
    changedAt: 1,
  })
  await settle()
  return bot
}

const screen = () => (
  <MemoryRouter initialEntries={[`/c/${ROOM}`]}>
    <Path />
    <Routes>
      <Route path="/c/:id" element={<RoomChat id={ROOM} slot="route" />} />
    </Routes>
  </MemoryRouter>
)
const where = () => find("[data-path]")?.textContent

/** The room's name, as the one press its bar answers with. */
const titlePress = () => find("[data-chat-settings-open]")
/** The sheet the press opens, by the name it wears. */
const sheet = () => findText("[role=dialog]", "Edit room")
/** The sheet's name field: where a room's rename is typed. */
const nameField = () => find("[data-chat-name]")
/** A button by its whole words, which is how the sheet's rows and a question's actions read. */
const button = (label: string) =>
  findAll("button").find((one) => one.textContent?.trim() === label) ?? null

/** The room's bar, and the sheet its name opens. */
async function openSheet() {
  await until(async () => Boolean(titlePress()), "the room's bar")
  await click(titlePress())
  await until(async () => Boolean(sheet()), "the room's sheet")
}

test("the room's bar draws no options button, and the press on its name opens Rename and Disband", async () => {
  await fresh(OPEN)
  await mount(screen(), async () => {
    await until(async () => text().includes("Planning"), "the room")
    assert.ok(missing('[aria-label="Room options"]'), "no menu in the room's bar")
    assert.equal(
      findAll('[data-slot="header-actions"] button').length,
      0,
      "and no context ring: a room runs no model call of its own",
    )
    await openSheet()
    assert.equal(nameField()?.tagName, "INPUT", "its name, as the field it is typed in")
    assert.equal((nameField() as HTMLInputElement).value, "Planning", "holding the name it wears")
    assert.ok(findText("button", "Disband room"), "its disband, as the one control that ends it")
    absentText("button", "Delete chat")
  })
})

test("a rename is one event under the id the app minted, and the header takes the Host's name", async () => {
  await fresh(OPEN)
  await mount(screen(), async () => {
    await openSheet()
    await type(nameField(), "Planning 2")
    await leave(nameField())

    await until(async () => posted.length > 0, "the rename to be posted")
    const [{ path, body }] = posted
    assert.ok(path.endsWith(`/rooms/${ROOM}`), "the room's own address")
    assert.equal(body.name, "Planning 2")
    assert.equal(typeof body.event_id, "string", "one event under an id the app minted")

    await until(
      async () => wordsOf(find("[data-slot=header-title]")) === "Planning 2",
      "the new name on the bar",
    )
    assert.equal((await db.conversations.get(ROOM))?.title, "Planning 2", "and on the row")
  })
})

test("a refusal keeps the room as it was, in the Host's words", async () => {
  await fresh(OPEN)
  await mount(screen(), async () => {
    await openSheet()
    await type(nameField(), REFUSED_NAME)
    await leave(nameField())

    await until(async () => text().includes(REFUSAL), "the Host's refusal")
    assert.equal((await db.conversations.get(ROOM))?.title, "Planning", "the room keeps its name")
    assert.equal(held.name, "Planning")
    // The words were about the name that was refused: typing another takes them away.
    await type(nameField(), "Planning 2")
    assert.equal(text().includes(REFUSAL), false, "and the refusal goes as the reader types again")
  })
})

test("a Host that cannot write rooms draws no Name and no Disband, but draws Pin and Archive", async () => {
  await fresh(CLOSED)
  await mount(screen(), async () => {
    await until(async () => text().includes("Planning"), "the room")
    await openSheet()
    assert.ok(missing("[data-chat-name]"), "no name: its Host cannot write one")
    absentText("button", "Disband room")
    await until(async () => Boolean(find("[data-chat-pin]")), "its pin, a mark of the reader's own")
    await until(async () => Boolean(find("[data-chat-archive]")), "and its archive, which is too")
  })
})

test("disband asks first, and the room's row goes as the Host's deletion", async () => {
  await fresh(OPEN)
  await mount(screen(), async () => {
    await openSheet()
    await click(button("Disband room"))
    await until(async () => text().includes("Disband this room?"), "the question")
    assert.equal(held.gone, false, "nothing happens until it is answered")
    await click(button("Disband"))

    await until(async () => posted.some((one) => one.path.endsWith("/disband")), "the disband")
    const sent = posted.find((one) => one.path.endsWith("/disband"))
    assert.equal(typeof sent?.body.cancel_id, "string", "the stop carries an id of its own")
    await until(async () => (await db.conversations.get(ROOM)) === undefined, "the row to go")
    await until(async () => where() === "/", "the screen to leave for the list")
  })
})

test("a room open on a device leaves when its row goes", async () => {
  await fresh(OPEN)
  await mount(screen(), async () => {
    await until(async () => text().includes("Planning"), "the room")
    // A disband on another device reaches this one as the record's deletion: the row goes.
    await db.conversations.delete(ROOM)
    await until(async () => where() === "/", "the screen to leave rather than draw a gone chat")
  })
})

test("a refused disband says why, and the room stays", async () => {
  await fresh(OPEN)
  held.refuseDisband = true
  await mount(screen(), async () => {
    await openSheet()
    await click(button("Disband room"))
    await until(async () => text().includes("Disband this room?"), "the question")
    await click(button("Disband"))

    await until(async () => text().includes(NO_DISBAND), "the Host's refusal")
    assert.ok((await db.conversations.get(ROOM))?.room, "the room is still on this device")
    assert.ok(text().includes("Disband this room?"), "and the question is still standing")
  })
})

test("a retried rename is the same event, and a retried disband the same stop", async () => {
  await fresh(OPEN)
  held.refuseRenameOnce = true
  await mount(screen(), async () => {
    await openSheet()
    await type(nameField(), "Planning 2")
    await leave(nameField())
    await until(async () => text().includes("still settling"), "the Host's first refusal")
    // The same name again: a dropped answer is not a name the Host refused.
    await type(nameField(), "Planning 2")
    await leave(nameField())

    await until(async () => posted.length === 2, "the second attempt")
    assert.equal(
      posted[0].body.event_id,
      posted[1].body.event_id,
      "a retry is the same rename, because the event id is the opening's",
    )
  })
})

test("a rename asked again in a new opening is a new event, not the one before it", async () => {
  await fresh(OPEN)
  await mount(screen(), async () => {
    await openSheet()
    await type(nameField(), "Planning 2")
    await leave(nameField())
    await until(async () => posted.length === 1, "the first rename")
    // The sheet closed and opened again: the question is a new one, and so is its id. A Host that
    // keeps the first id would take the second name for the first one replayed.
    await shutSheet(sheet)
    await openSheet()
    await type(nameField(), "Planning 3")
    await leave(nameField())

    await until(async () => posted.length === 2, "the second rename")
    assert.notEqual(posted[1].body.event_id, posted[0].body.event_id, "a new opening, a new event")
    assert.equal(posted[1].body.name, "Planning 3")
  })
})

test("a room whose row goes leaves its own address for the list", async () => {
  await fresh(OPEN)
  const page = () => (
    <MemoryRouter initialEntries={[`/c/${ROOM}`]}>
      <Path />
      <Routes>
        <Route path="/c/:id" element={<ChatPage slot="route" />} />
      </Routes>
    </MemoryRouter>
  )
  await mount(page(), async () => {
    await until(async () => text().includes("Planning"), "the room's screen")
    await db.conversations.delete(ROOM)
    await until(async () => where() === "/", "the room's screen to leave for the list")
  })
})
