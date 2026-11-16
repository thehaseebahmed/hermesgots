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
  mount,
  seedSettings,
  settle,
  until,
} from "./component-kit.tsx"

const CHAT = "c-archive"
const SESSION = "c-session"

/** What the bot's plugin advertises, and whether Hermes's own session took the flag. */
let features: string[] = ["chats"]
let host = true
/** Every request that reached the archive route, so a case can hold the wire to what it did. */
let posts: { path: string; body?: { archived?: boolean } }[] = []

const botOf = (name: string) => botProfile(name, { id: `bot-${name}`, name: "Archivist" })

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input))
  const body = init?.body ? JSON.parse(String(init.body)) : undefined
  if (url.pathname.endsWith("/plugins/gots/info")) return json({ features })
  if (url.pathname.includes("/plugins/gots/chats/") && url.pathname.endsWith("/archived")) {
    posts.push({ path: url.pathname, body })
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
    <Routes>
      <Route
        path="/c/:id"
        element={
          <>
            <ChatPage slot="route" />
            <Path />
          </>
        }
      />
      <Route path="/" element={<Path />} />
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
  await seed("archive-posts", {}, ["chats", "session_archive"])
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
    await settle()
    await until(async () => archiveButton()?.textContent === "Unarchive", "the way back")
    await click(archiveButton())
    await until(async () => posts.length === 2, "the second write")
    assert.deepEqual(posts[1].body, { archived: false })
    await until(
      async () => (await db.conversations.get(CHAT))?.archived === undefined,
      "unarchived here too",
    )
  })
})

test("a plugin from before session_archive writes the mark on this device alone", async () => {
  await seed("archive-old", {})
  await mount(screen(), async () => {
    await pressArchive()
    await until(async () => (await db.conversations.get(CHAT))?.archived === true, "archived here")
    await settle()
    assert.deepEqual(posts, [], "a host that can't take the flag is not asked for it")
  })
})

test("a host whose store can't hold the flag still leaves the chat archived here", async () => {
  await seed("archive-refused", {}, ["chats", "session_archive"])
  host = false
  await mount(screen(), async () => {
    await pressArchive()
    await until(async () => posts.length === 1, "the ask")
    await until(
      async () => (await db.conversations.get(CHAT))?.archived === true,
      "the device keeps its own mark when the host answers that it took no flag",
    )
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
