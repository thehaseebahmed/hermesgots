/**
 * A chat's archive is Hermes's own: the sheet's Archive asks the bot to set the session's archive
 * flag, and the row is written here at once so the screen does not wait for a merge (ADR 0159).
 *
 * A bot whose plugin advertises `session_archive` is told; a plugin from before it, or a host that
 * answers that its store can't hold the flag (`host: false`), leaves the device's own mark, which is
 * exactly what every device did before the route existed. A room is not this: its archive is the
 * reader's own mark on the room's record (ADR 0157), and no session flag is written for it.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { MemoryRouter, Route, Routes } from "react-router"

import { ChatPage } from "@/routes/chat"
import { setArchived } from "@/lib/chat-marks"
import { db, type Conversation } from "@/lib/db"

import {
  Path,
  botProfile,
  click,
  find,
  findText,
  json,
  missing,
  mount,
  path,
  seedSettings,
  settle,
  until,
} from "./component-kit.tsx"

const CHAT = "c-archive"
const SESSION = "c-session"

/** What the bot's plugin advertises, and whether Hermes's own session took the flag. */
let features: string[] = ["chats"]
let host = true
/** Whether the host refuses the write — Main is the one chat it will not archive (409). */
let refuse = false
/** Every request that reached the archive route, so a case can hold the wire to what it did. */
let posts: { path: string; body?: { archived?: boolean } }[] = []

const botOf = (name: string) => botProfile(name, { id: `bot-${name}`, name: "Archivist" })

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input))
  const body = init?.body ? JSON.parse(String(init.body)) : undefined
  if (url.pathname.endsWith("/plugins/gots/info")) return json({ features })
  if (url.pathname.includes("/plugins/gots/chats/") && url.pathname.endsWith("/archived")) {
    posts.push({ path: url.pathname, body })
    if (refuse)
      return new Response(JSON.stringify({ error: { message: "Main can't be archived." } }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      })
    return json({ object: "gots.chat.archived", archived: body?.archived === true, host })
  }
  return json({})
}) as typeof fetch

const chatRow = (profileId: string, patch: Partial<Conversation> = {}): Conversation =>
  ({
    id: CHAT,
    profileId,
    title: "A chat of the bot's",
    hermesSessionId: SESSION,
    createdAt: 10,
    updatedAt: 11,
    changedAt: 11,
    ...patch,
  }) as Conversation

async function seed(name: string, patch: Partial<Conversation> = {}, advertised: string[] = ["chats"]) {
  const bot = botOf(name)
  features = advertised
  host = true
  refuse = false
  posts = []
  localStorage.clear()
  await seedSettings({ developer: true, activeProfileId: bot.id })
  await db.profiles.clear()
  await db.profiles.put(bot)
  await db.messages.clear()
  await db.conversations.clear()
  await db.conversations.put(chatRow(bot.id, patch))
  return bot
}

const screen = (id = CHAT) => (
  <MemoryRouter initialEntries={[`/c/${id}`]}>
    <Path />
    <Routes>
      <Route path="/c/:id" element={<ChatPage slot="route" />} />
      {/* The step an archive takes: the bot's list, whose address is the bot's own. */}
      <Route path="/b/:botId/sidechats" element={<p data-list />} />
    </Routes>
  </MemoryRouter>
)

const titlePress = () => find("[data-chat-settings-open]")
const sheet = () => findText("[role=dialog]", "Edit chat")
const archiveButton = () => find("[data-chat-archive]")

/** The sheet's Archive, pressed on a chat of the bot's. */
async function pressArchive() {
  await until(async () => Boolean(titlePress()), "the chat's bar")
  await click(titlePress())
  await until(async () => Boolean(sheet()), "the chat's settings")
  await until(async () => Boolean(archiveButton()), "the Archive control")
  await click(archiveButton())
}

test("the sheet's Archive tells Hermes, and the row here lands at once", async () => {
  const bot = await seed("archive-posts", {}, ["chats", "session_archive"])
  await mount(screen(), async () => {
    await pressArchive()
    await until(async () => posts.length === 1, "the route the plugin answers")
    assert.deepEqual(
      posts[0],
      { path: `/api/plugins/gots/chats/${CHAT}/archived`, body: { archived: true } },
      "the chat's own id, and the flag it is being given",
    )
    const row = await db.conversations.get(CHAT)
    assert.equal(row?.archived, true, "and the row written here, without waiting for a merge")
    assert.equal(row?.pinned, undefined, "archiving takes the pin with it, as it always did")
    await until(async () => missing("[role=dialog]"), "the sheet closed with the press")
    await until(async () => path() === `/b/${bot.id}/sidechats`, "the bot's list, the step back")
  })
})

/**
 * The way back is the same write the other way round: a chat opened already archived is unarchived
 * from its sheet, the host is asked to take the flag off and the row here is cleared with it. A row
 * coming back is a reason to stay, so the sheet stands on the conversation it was opened from.
 */
test("a chat opened archived is unarchived from its sheet, and the host takes the flag off", async () => {
  await seed("archive-back", { archived: true }, ["chats", "session_archive"])
  await mount(screen(), async () => {
    await until(async () => Boolean(titlePress()), "the chat's bar")
    await click(titlePress())
    await until(async () => Boolean(sheet()), "the chat's settings")
    await until(async () => archiveButton()?.textContent === "Unarchive", "the way back")
    await click(archiveButton())
    await until(async () => posts.length === 1, "the write the other way")
    assert.deepEqual(posts[0].body, { archived: false })
    await until(
      async () => (await db.conversations.get(CHAT))?.archived === undefined,
      "unarchived here too",
    )
    assert.ok(sheet(), "and the sheet stays open, as it always did")
    assert.equal(path(), `/c/${CHAT}`, "on the chat's own screen")
  })
})

test("a plugin from before session_archive writes the mark on this device alone", async () => {
  const bot = await seed("archive-old", {})
  await mount(screen(), async () => {
    await pressArchive()
    await until(async () => (await db.conversations.get(CHAT))?.archived === true, "archived here")
    assert.deepEqual(posts, [], "a host that can't take the flag is not asked for it")
    await until(async () => path() === `/b/${bot.id}/sidechats`, "the bot's list, the step back")
  })
})

test("a host whose store can't hold the flag still leaves the chat archived here", async () => {
  const bot = await seed("archive-refused", {}, ["chats", "session_archive"])
  host = false
  await mount(screen(), async () => {
    await pressArchive()
    await until(async () => posts.length === 1, "the ask")
    await until(
      async () => (await db.conversations.get(CHAT))?.archived === true,
      "the device keeps its own mark when the host answers that it took no flag",
    )
    await until(async () => path() === `/b/${bot.id}/sidechats`, "the bot's list, the step back")
  })
})

/**
 * A host that refuses the flag (409) is the truth about the row: the mark written here first comes
 * back off it, and the press takes no step — a row that was never put away is no way out of the
 * conversation. The sheet stands on the chat it was opened from, the latch is cleared with the
 * refusal, and the press may be made again.
 */
test("a host that refuses the flag leaves the chat where it was, and the press may be made again", async () => {
  await seed("archive-refused-409", {}, ["chats", "session_archive"])
  refuse = true
  await mount(screen(), async () => {
    await pressArchive()
    await until(async () => posts.length === 1, "the archive was asked for")
    await until(
      async () => (await db.conversations.get(CHAT))?.archived === undefined,
      "the row reverts to unarchived",
    )
    await settle()
    assert.equal(
      path(),
      `/c/${CHAT}`,
      "and the address is unchanged: the step back waits for the mark to stand",
    )
    assert.ok(sheet(), "the sheet stands on the chat it was opened from")
    // The latch cleared with the refusal, so the press may be made again.
    await click(archiveButton())
    await until(async () => posts.length === 2, "a second press is accepted")
    assert.deepEqual(posts[1].body, { archived: true }, "asking the same write again")
    assert.ok(sheet(), "and the sheet still stands")
  })
})

test("a room's archive is still the reader's own mark, and no session flag is written", async () => {
  const room = "room-archive"
  const bot = await seed("archive-room", {}, ["chats", "session_archive"])
  await db.conversations.put({
    id: room,
    profileId: bot.id,
    title: "A room",
    createdAt: 10,
    updatedAt: 11,
    changedAt: 11,
    room: { id: room, members: [{ memberId: "m1", profile: "default", handle: "hermes" }] },
  } as Conversation)
  await setArchived(room, true)
  const row = await db.conversations.get(room)
  assert.equal(row?.archived, true, "the room's own mark")
  assert.equal(typeof row?.roomMarksAt, "number", "stamped with the clock its record travels on")
  await settle()
  assert.deepEqual(posts, [], "a room has no session of its own to archive (ADR 0157)")
})

/**
 * Main is never put away (G2) — but an unarchive is always allowed, and a refusal is undone.
 *
 * The guard refused both directions, so a device that archived Main before the plugin's flag
 * reached it could never bring the row back: it sat under the Archived pill for ever, and a bot
 * whose bar draws it as the chat it is had no way to reach it. And where the host answers 409 —
 * the flag is Main's, the route's answer is the truth — the mark written here first has to come
 * back off the row rather than leave this device saying a chat is put away that no surface put away.
 */
test("Main put away before its flag arrived can be brought back, and a refused archive is undone", async () => {
  await seed("archive-main-back", { main: true, archived: true }, ["chats", "session_archive"])
  await setArchived(CHAT, false)
  assert.equal(
    (await db.conversations.get(CHAT))?.archived,
    undefined,
    "Main comes back out from under the pill",
  )
  assert.deepEqual(
    posts.map((one) => one.body),
    [{ archived: false }],
    "and the host is asked too",
  )

  // The archive of a Main this device has not been told about yet — the flag is projection-only
  // until a device merges it back, so this row carries none: the mark is written here first, the
  // route refuses it, and the mark goes back off.
  await seed("archive-main-refused", {}, ["chats", "session_archive"])
  refuse = true
  await setArchived(CHAT, true)
  assert.deepEqual(
    posts.map((one) => one.body),
    [{ archived: true }],
    "the archive was asked for",
  )
  assert.equal(
    (await db.conversations.get(CHAT))?.archived,
    undefined,
    "and refused, so nothing is archived here either",
  )
})
