/**
 * A room's own menu: Rename and Disband in the room's header, and nothing of a chat's (ADR 0122).
 *
 * Both writes go to the Host and come back as the room's record, so the header and the sidebar row take
 * the Host's own name and the row leaves this device as the Host's deletion (ADR 0123). A refusal keeps
 * the room as it was, in the Host's words; a Host that cannot write draws no menu at all; a room whose
 * row goes while it is open leaves to the list rather than falling to a chat's "gone" screen.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { MemoryRouter, Route, Routes } from "react-router"

import { RoomChat } from "@/components/room/room-chat"
import { ChatPage } from "@/routes/chat"
import { db, type Profile } from "@/lib/db"
import {
  botProfile,
  click,
  find,
  findAll,
  json,
  mount,
  Path,
  seedSettings,
  settle,
  text,
  type,
  until,
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
  await seedSettings({ onboarded: true, legacyChat: true })
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

async function openMenu() {
  await until(async () => Boolean(find('[aria-label="Room options"]')), "the room's options")
  await click(find('[aria-label="Room options"]'))
  await until(async () => (document.body.textContent ?? "").includes("Rename"), "the menu's items")
}

test("a rename is one event under the id the app minted, and the header takes the Host's name", async () => {
  await fresh(OPEN)
  await mount(screen(), async () => {
    await openMenu()
    await click(findAll('[role="menuitem"]').find((one) => one.textContent?.includes("Rename")) ?? null)
    await until(async () => Boolean(find('input[aria-label="Room name"]')), "the rename dialog")
    await type(find('input[aria-label="Room name"]'), "Planning 2")
    await click(findAll("button").find((one) => one.textContent?.trim() === "Save") ?? null)

    await until(async () => posted.length > 0, "the rename to be posted")
    const [{ path, body }] = posted
    assert.ok(path.endsWith(`/rooms/${ROOM}`), "the room's own address")
    assert.equal(body.name, "Planning 2")
    assert.equal(typeof body.event_id, "string", "one event under an id the app minted")

    await until(async () => text().includes("Planning 2"), "the new name on the screen")
    assert.equal((await db.conversations.get(ROOM))?.title, "Planning 2", "and on the row")
  })
})

test("a refusal keeps the room as it was, in the Host's words", async () => {
  await fresh(OPEN)
  await mount(screen(), async () => {
    await openMenu()
    await click(findAll('[role="menuitem"]').find((one) => one.textContent?.includes("Rename")) ?? null)
    await until(async () => Boolean(find('input[aria-label="Room name"]')), "the rename dialog")
    await type(find('input[aria-label="Room name"]'), REFUSED_NAME)
    await click(findAll("button").find((one) => one.textContent?.trim() === "Save") ?? null)

    await until(async () => text().includes(REFUSAL), "the Host's refusal")
    assert.equal((await db.conversations.get(ROOM))?.title, "Planning", "the room keeps its name")
    assert.equal(held.name, "Planning")
  })
})

test("a host that cannot write draws no menu", async () => {
  await fresh(CLOSED)
  await mount(screen(), async () => {
    await until(async () => text().includes("Planning"), "the room")
    await settle()
    assert.equal(find('[aria-label="Room options"]'), null, "no menu for a Host that cannot write")
  })
})

test("disband asks first, and the room's row goes as the Host's deletion", async () => {
  await fresh(OPEN)
  await mount(screen(), async () => {
    await openMenu()
    await click(findAll('[role="menuitem"]').find((one) => one.textContent?.includes("Disband")) ?? null)
    await until(async () => text().includes("Disband this room?"), "the question")
    assert.equal(held.gone, false, "nothing happens until it is answered")
    await click(findAll("button").find((one) => one.textContent?.trim() === "Disband") ?? null)

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
    await openMenu()
    await click(findAll('[role="menuitem"]').find((one) => one.textContent?.includes("Disband")) ?? null)
    await until(async () => text().includes("Disband this room?"), "the question")
    await click(findAll("button").find((one) => one.textContent?.trim() === "Disband") ?? null)

    await until(async () => text().includes(NO_DISBAND), "the Host's refusal")
    assert.ok((await db.conversations.get(ROOM))?.room, "the room is still on this device")
    assert.ok(text().includes("Disband this room?"), "and the question is still standing")
  })
})

test("a retried rename is the same event, and a retried disband the same stop", async () => {
  await fresh(OPEN)
  held.refuseRenameOnce = true
  await mount(screen(), async () => {
    await openMenu()
    await click(findAll('[role="menuitem"]').find((one) => one.textContent?.includes("Rename")) ?? null)
    await until(async () => Boolean(find('input[aria-label="Room name"]')), "the rename dialog")
    await type(find('input[aria-label="Room name"]'), "Planning 2")
    const save = () => findAll("button").find((one) => one.textContent?.trim() === "Save") ?? null
    await click(save())
    await until(async () => text().includes("still settling"), "the Host's first refusal")
    await click(save())

    await until(async () => posted.length === 2, "the second attempt")
    assert.equal(
      posted[0].body.event_id,
      posted[1].body.event_id,
      "a retry is the same rename, because the event id is the attempt's",
    )
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
