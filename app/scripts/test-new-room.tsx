/**
 * Starting a room from the app: the sidebar's footer draws New room where a Host can make one, the
 * sheet takes a name and two to six of that Host's bots, and a create opens the room it made — its row
 * written from the record the Host answered, so the screen it lands on has something to draw
 * (ADR 0122, ADR 0123).
 *
 * A Host's refusal is the sheet's own words, and nothing is written; a Host that cannot make rooms
 * draws no control at all rather than one that can only come back refused.
 *
 * Each test holds its own Host, because a plugin's features are answered once per connection and kept:
 * a device that has been told what one Host offers is not told again in the same run.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { MemoryRouter } from "react-router"

import { ConversationList } from "@/components/conversation-list"
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
  type,
  until,
} from "./component-kit.tsx"

/** What a Host that can make rooms answered about its plugin: the write row is what draws New room. */
const WRITABLE = ["chats", "rooms", "rooms_write"]
/** The name that makes the Host refuse: the roster rule, in the Host's own words. */
const REFUSED = "Refuse me"
const REFUSAL = "members must contain between 2 and 6 entries"

/** Every create the sheet posted, so the id and the seats it carried can be read back. */
const posted: { path: string; body: Record<string, unknown> }[] = []
/** What each Host's plugin advertises, by the host name a test gave it. */
const offers = new Map<string, string[]>()

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input))
  if (url.pathname.endsWith("/plugins/gots/info"))
    return json({ name: "gots", version: "test", features: offers.get(url.host) ?? ["chats"] })
  if (url.pathname.endsWith("/plugins/gots/chats")) return json({ object: "gots.chats", chats: {} })
  if (url.pathname.endsWith("/plugins/gots/rooms") && init?.method === "POST") {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    posted.push({ path: url.pathname, body })
    if (body.name === REFUSED) return json({ error: { message: REFUSAL } }, 400)
    const at = Date.now()
    return json({
      object: "gots.room.record",
      at,
      value: {
        title: body.name,
        createdAt: at,
        updatedAt: at,
        room: { id: body.room_id, members: body.members },
      },
    })
  }
  // Everything else the sidebar polls (live runs, threads) answers empty rather than 404: a failing
  // poll retries, and a screen under test is not what this file is about.
  return json({})
}) as typeof fetch

async function fresh(host: string, { writable = true }: { writable?: boolean } = {}) {
  offers.set(host, writable ? WRITABLE : ["chats", "rooms"])
  posted.length = 0
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

const screen = () => (
  <MemoryRouter initialEntries={["/"]}>
    <Path />
    <ConversationList />
  </MemoryRouter>
)
const where = () => find("[data-path]")?.textContent

/** The field the sheet asks the room's name in. */
const nameField = () => find('input[aria-label="Room name"]')

async function create(name: string, bots: Profile[]) {
  await until(async () => Boolean(find('[data-slot="new-room"]')), "the New room control")
  await click(find('[data-slot="new-room"]'))
  await until(async () => Boolean(nameField()), "the room's name field")
  await type(nameField(), name)
  for (const bot of bots) await click(find(`[data-bot="${bot.id}"]`))
  await click(findAll("button").find((one) => one.textContent?.trim() === "Create") ?? null)
}

test("a room started from the sheet opens on its own screen", async () => {
  const bots = await fresh("new-room.test")
  await mount(screen(), async () => {
    await create("Planning", bots)

    await until(async () => posted.length > 0, "the create to be posted")
    const [{ body }] = posted
    const roomId = String(body.room_id)
    assert.ok(roomId, "the app minted the room's id")
    assert.equal(body.name, "Planning")
    assert.deepEqual(
      (body.members as { handle?: string }[]).map((one) => one.handle),
      ["coder", "writer"],
      "each seat carries the profile it answers under",
    )
    assert.equal(
      (body.members as { memberId?: string }[]).every((one) => typeof one.memberId === "string"),
      true,
      "and an id the app minted",
    )

    await until(async () => where() === `/c/${roomId}`, "the room's own address")
    const row = await db.conversations.get(roomId)
    assert.equal(row?.title, "Planning", "the room is a row this device can draw")
    assert.deepEqual(
      row?.room?.members.map((one) => one.profile),
      ["coder", "writer"],
      "with the roster the Host answered",
    )
  })
})

test("a roster the Host refuses is said in its own words, and nothing is written", async () => {
  const bots = await fresh("refusing.test")
  await mount(screen(), async () => {
    await create(REFUSED, bots)

    await until(async () => (document.body.textContent ?? "").includes(REFUSAL), "the Host's refusal")
    assert.equal(posted.length, 1, "the sheet asked once")
    assert.equal(await db.conversations.count(), 0, "and no room was written")
    assert.equal(where(), "/", "the app stayed where it was")
  })
})

test("a host that cannot write offers no New room", async () => {
  await fresh("closed.test", { writable: false })
  await mount(screen(), async () => {
    await until(async () => Boolean(find('nav[aria-label="Main"]')), "the sidebar")
    await settle()
    assert.equal(find('[data-slot="new-room"]'), null, "no control for a Host that cannot make a room")
  })
})
