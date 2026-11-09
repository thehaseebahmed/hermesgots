/**
 * Starting a room from the blank screen (ADR 0125): New room opens a room that does not exist yet, the
 * seats are picked above the composer — two at least, six at most, one Host — and the first send is
 * what makes it. Until then the Host is never asked and no row is written; after it, the room exists,
 * opens at its own address on the name its seats give it, and carries the message as its first turn.
 *
 * A Host that cannot make rooms draws no control at all rather than one that can only come back
 * refused.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { MemoryRouter, Route, Routes, useParams } from "react-router"

import { ConversationList } from "@/components/conversation-list"
import { NewRoomScreen } from "@/components/room/new-room-screen"
import { RoomChat } from "@/components/room/room-chat"
import { db, type Profile } from "@/lib/db"
import {
  botProfile,
  click,
  composerField,
  find,
  findAll,
  json,
  mount,
  Path,
  seedSettings,
  settle,
  type,
  until,
} from "./component-kit.tsx"

/** What a Host that can make rooms answered about its plugin: the write row draws New room. */
const WRITABLE = ["chats", "rooms", "rooms_write"]

/** Every call the screen made, so the create and the first send can be read back in order. */
const posted: { path: string; body: Record<string, unknown> }[] = []
/** What each Host's plugin advertises, by the host name a test gave it. */
const offers = new Map<string, string[]>()

const members = [
  { memberId: "m1", profile: "default", handle: "default", displayName: "Test bot" },
  { memberId: "m2", profile: "coder", handle: "coder", displayName: "Coder" },
]

/** The room as the Host holds it, once a create has made one. */
const held: { id?: string; name: string } = { name: "" }

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input))
  const method = (init?.method ?? "GET").toUpperCase()
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
  if (url.pathname.endsWith("/plugins/gots/info"))
    return json({ name: "gots", features: offers.get(url.host) ?? ["chats"] })
  if (url.pathname.endsWith("/plugins/gots/chats")) return json({ object: "gots.chats", chats: {} })
  if (url.pathname.endsWith("/plugins/gots/rooms") && method === "POST") {
    posted.push({ path: url.pathname, body })
    const id = String(body.room_id)
    held.id = id
    held.name = String(body.name)
    const at = Date.now()
    return json({
      object: "gots.room.record",
      at,
      value: {
        title: held.name,
        createdAt: at,
        updatedAt: at,
        room: { id, members: body.members },
      },
    })
  }
  if (url.pathname.endsWith("/send")) {
    posted.push({ path: url.pathname, body })
    return json({
      object: "gots.room.event",
      event: { seq: 1, eventId: "e1", kind: "message.user", text: body.text },
    })
  }
  if (held.id && url.pathname.endsWith(`/plugins/gots/rooms/${held.id}`) && method === "GET")
    return json({
      object: "gots.room",
      room: { id: held.id, name: held.name, members },
      events: [],
      cursor: 0,
      latestSeq: 0,
      hasMore: false,
      working: false,
      activity: [],
      waiting: [],
      canStop: false,
      canSend: true,
    })
  // Everything else the sidebar polls answers empty rather than 404: a failing poll retries.
  return json({})
}) as typeof fetch

async function fresh(host: string, { writable = true }: { writable?: boolean } = {}) {
  offers.set(host, writable ? WRITABLE : ["chats", "rooms"])
  posted.length = 0
  held.id = undefined
  held.name = ""
  const bots: Profile[] = [
    botProfile(host, {
      id: `${host}-coder`,
      name: "Coder",
      baseUrl: `http://${host}/v1`,
      hermesProfile: "coder",
    }),
    botProfile(host, {
      id: `${host}-writer`,
      name: "Writer",
      baseUrl: `http://${host}/v1`,
      hermesProfile: "writer",
      botId: `${host}-writer`,
    }),
  ]
  await seedSettings({ onboarded: true, legacyChat: true, movedChats: bots.map((bot) => bot.id) })
  await db.profiles.clear()
  await db.profiles.bulkPut(bots)
  await db.conversations.clear()
  await db.messages.clear()
  await db.roomLog.clear()
  await settle()
  return bots
}

/** The blank room at its own address: the room it becomes lives at `/c/<id>`, which the create names. */
const screen = () => (
  <MemoryRouter initialEntries={["/new-room"]}>
    <Path />
    <Routes>
      <Route path="/new-room" element={<NewRoomScreen slot="route" />} />
      <Route path="/c/:id" element={<RoomAt />} />
    </Routes>
  </MemoryRouter>
)
const where = () => find("[data-path]")?.textContent
/** The room the address names, read from the address itself, as the app's own route does. */
function RoomAt() {
  const { id } = useParams()
  return <RoomChat id={id ?? ""} slot="route" />
}

async function pick(bots: Profile[]) {
  await until(async () => Boolean(find('[data-slot="seats-pill"]')), "the seats pill")
  await click(find('[data-slot="seats-pill"]'))
  for (const bot of bots) {
    await until(async () => Boolean(find(`[data-bot="${bot.id}"]`)), "a seat")
    await click(find(`[data-bot="${bot.id}"]`))
  }
  await click(findAll("button").find((one) => one.textContent?.trim() === "Done") ?? null)
}

test("a room started from the blank screen opens on its own name and takes the first message", async () => {
  const bots = await fresh("blank-room.test")
  await mount(screen(), async () => {
    await until(async () => Boolean(find('[data-slot="seats-pill"]')), "the blank room")
    // Nothing is asked of the Host until a message is sent.
    assert.equal(posted.length, 0, "an empty room reaches the Host with nothing")
    await pick(bots)

    await type(composerField(), "Plan the next release.")
    await click(find('button[aria-label="Send"]'))
    await settle()

    await until(async () => posted.length >= 2, "the create and its first message")
    const [create, first] = posted
    const roomId = String(create.body.room_id)
    assert.ok(roomId, "the app minted the room's id")
    assert.equal(
      create.body.name,
      "Coder, Writer",
      "its name is its seats, until the Host says otherwise",
    )
    assert.deepEqual(
      (create.body.members as { handle?: string }[]).map((one) => one.handle),
      ["coder", "writer"],
      "each seat carries the profile it answers under",
    )
    assert.ok(first.path.endsWith(`/rooms/${roomId}/send`), "the message goes into the room just made")
    assert.equal(first.body.text, "Plan the next release.")

    await until(async () => where() === `/c/${roomId}`, "the room's own address")
    const row = await db.conversations.get(roomId)
    assert.equal(row?.title, "Coder, Writer", "the room is a row this device can draw")
  })
})

test("the seats hold the room at two, and the send is refused before that", async () => {
  const bots = await fresh("blank-room-one.test")
  await mount(screen(), async () => {
    await until(async () => Boolean(find('[data-slot="seats-pill"]')), "the blank room")
    await pick(bots.slice(0, 1))
    // One seat is not a room: Send is drawn disabled, and pressing it asks the Host for nothing.
    await type(composerField(), "Not yet.")
    const sendButton = find('button[aria-label="Send"]') as HTMLButtonElement | null
    assert.equal(sendButton?.disabled, true, "no send until two bots are seated")
    await click(sendButton)
    assert.match(
      find('[data-slot="seats-pill"]')?.textContent ?? "",
      /1 of 6/,
      "the pill counts the seat",
    )
    assert.equal(posted.length, 0, "and the Host was never asked")
  })
})

test("a host that cannot write offers no New room", async () => {
  await fresh("blank-room-closed.test", { writable: false })
  await mount(
    <MemoryRouter initialEntries={["/"]}>
      <Path />
      <ConversationList />
    </MemoryRouter>,
    async () => {
      await until(async () => Boolean(find('nav[aria-label="Main"]')), "the sidebar")
      await settle()
      assert.equal(
        find('[data-slot="new-room"]'),
        null,
        "no control for a Host that cannot make a room",
      )
    },
  )
})
