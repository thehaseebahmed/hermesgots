/**
 * A bot's address is its list: whatever this device last had open there, `/b/<bot>` draws the chats to
 * pick from, and a row pressed in it opens that conversation.
 *
 * A memory of the chat a bot was last in is this device's own, so a case writes it where an older
 * build kept it — the address, under the bot's id — and never through a module the app no longer has.
 * A loader that still honours it is what fails here.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { Link, MemoryRouter, Route, Routes, useNavigate } from "react-router"

import { db } from "@/lib/db"
import { BotChatsPage } from "@/routes/bot-chats"

import {
  Nav,
  Path,
  botProfile,
  click,
  find,
  findAll,
  findText,
  json,
  mount,
  nav,
  path,
  seedSettings,
  until,
} from "./component-kit.tsx"

const bot = botProfile("bot-open", { id: "bot-1", name: "Mainly" })
const other = botProfile("bot-other", { id: "bot-2", name: "Otherly" })
const MAIN = "main-bot-1"

/** The chat a bot was last in, as an older build kept it: what a bot's address used to open. */
const remember = (profileId: string, chat: string) =>
  localStorage.setItem(`gots:last-chat:${profileId}`, chat)

/** The chats a device holds: `at` is the chat's own clock, which is what "newest" is read by. */
async function seed(chats: { id: string; at: number; bot?: string; routine?: boolean }[]) {
  await seedSettings({ developer: true, activeProfileId: bot.id })
  await db.profiles.clear()
  await db.profiles.bulkPut([bot, other])
  await db.conversations.clear()
  await db.messages.clear()
  localStorage.clear()
  await db.conversations.bulkPut(
    chats.map((chat) => ({
      id: chat.id,
      profileId: chat.bot ?? bot.id,
      title: chat.id,
      hermesSessionId: `gots-${chat.id}`,
      createdAt: chat.at - 50,
      updatedAt: chat.at,
      changedAt: chat.at,
      ...(chat.routine ? { routine: true } : {}),
    })),
  )
  globalThis.fetch = async () => json({})
}

/** The chats a bot's list draws, by the address each row leads to. */
const rowIds = () =>
  findAll('ul a[href^="/c/"]').map((row) => (row.getAttribute("href") ?? "").slice(3))

/**
 * Another screen with the bot's way in on it, as the sidebar's row is: tapping it arrives at
 * `/b/<bot>` as a push, which is what a reader's own press is. `at` starts the page on an address
 * already, for a load of it or a step back onto it.
 */
const screen = ({ from = "/", at }: { from?: string; at?: string } = {}) => (
  <MemoryRouter initialEntries={[at ?? from]}>
    <Path />
    <Nav />
    <Link to={`/b/${bot.id}`}>the bot</Link>
    <StepBack />
    <Routes>
      <Route path="b/:profileId" element={<BotChatsPage />} />
      <Route path="c/:id" element={<p data-chat />} />
      <Route path="new-room" element={<p data-new-room />} />
    </Routes>
  </MemoryRouter>
)

/** One step back through the entries a screen pushed, which is what "the list behind it" means. */
function StepBack() {
  const navigate = useNavigate()
  return (
    <button type="button" data-back onClick={() => navigate(-1)}>
      back
    </button>
  )
}

const theBot = () => findText("a", "the bot")

test("a bot's address is its list, whatever this device last had open there", async () => {
  await seed([
    { id: "a", at: 100 },
    { id: "b", at: 200 },
  ])
  remember(bot.id, "a")
  await mount(screen(), async () => {
    await click(theBot())
    await until(async () => rowIds().length === 2, "the bot's chats")
    assert.equal(path(), `/b/${bot.id}`, "the list, not the chat the memory named")
    assert.equal(nav(), `PUSH:/b/${bot.id}`, "the press opened it and never took its place")
  })
})

test("a bot's own chat is never what its address opens on", async () => {
  await seed([
    { id: MAIN, at: 100 },
    { id: "b", at: 200 },
  ])
  remember(bot.id, MAIN)
  await mount(screen(), async () => {
    await click(theBot())
    await until(async () => rowIds().length === 2, "the bot's chats")
    assert.equal(path(), `/b/${bot.id}`, "Main is a row of the list, not where the list leads")
  })
})

test("a routine's run is a row of the list, never what the address opens", async () => {
  await seed([
    { id: "chat", at: 100 },
    { id: "run", at: 300, routine: true },
  ])
  remember(bot.id, "run")
  await mount(screen(), async () => {
    await click(theBot())
    await until(async () => rowIds().length === 2, "the bot's chat and its run")
    assert.equal(path(), `/b/${bot.id}`, "the list, not the run the memory named")
  })
})

test("a memory naming another bot's chat still draws this bot's list", async () => {
  await seed([
    { id: "a", at: 100 },
    { id: "theirs", at: 300, bot: other.id },
  ])
  remember(bot.id, "theirs")
  await mount(screen(), async () => {
    await click(theBot())
    await until(async () => rowIds().length === 1, "this bot's own chat")
    assert.equal(path(), `/b/${bot.id}`, "the list, not a chat that was never this bot's")
  })
})

test("a bot with no chats draws an empty list rather than opening one", async () => {
  await seed([])
  remember(bot.id, "deleted")
  await mount(screen(), async () => {
    await click(theBot())
    await until(async () => Boolean(findText("p", "No chats yet.")), "the empty list")
    assert.equal(path(), `/b/${bot.id}`, "the bot's own address")
  })
})

test("the list is what a load of the address draws, memory or none", async () => {
  await seed([
    { id: "a", at: 100 },
    { id: "b", at: 200 },
  ])
  remember(bot.id, "a")
  await mount(screen({ at: `/b/${bot.id}` }), async () => {
    await until(async () => rowIds().length === 2, "the bot's chats")
    assert.equal(path(), `/b/${bot.id}`, "still the list")
  })
})

test("a chat's row opens it above the list it was picked from", async () => {
  await seed([
    { id: "a", at: 100 },
    { id: "b", at: 200 },
  ])
  await mount(screen({ at: `/b/${bot.id}` }), async () => {
    await until(async () => rowIds().length === 2, "the bot's chats")
    await click(findAll('ul a[href="/c/a"]')[0]!)
    await until(async () => path() === "/c/a", "the chat picked")
    assert.equal(nav(), "PUSH:/c/a", "above the list rather than in its place")
    // The list is still the entry the conversation stands on, which is what a step back reads.
    await click(find("[data-back]"))
    await until(async () => rowIds().length === 2, "the list the chat was picked from")
    assert.equal(path(), `/b/${bot.id}`, "the list still behind it")
  })
})

test("a room's row keeps its own screen above the list", async () => {
  await seed([{ id: "a", at: 100 }])
  // The row is drawn for the bots its roster seats, so the room names the one this device holds.
  await db.profiles.update(bot.id, { hermesProfile: "default" })
  await db.conversations.put({
    id: "room",
    profileId: bot.id,
    title: "Room",
    hermesSessionId: "gots-room",
    createdAt: 50,
    updatedAt: 100,
    changedAt: 100,
    room: { id: "room", members: [{ profile: "default" }] },
  })
  await mount(screen({ at: `/b/${bot.id}` }), async () => {
    await until(async () => rowIds().includes("room"), "the room's row")
    await click(findAll('ul a[href="/c/room"]')[0]!)
    await until(async () => path() === "/c/room", "the room's screen")
    assert.equal(nav(), "PUSH:/c/room", "above the list rather than in its place")
  })
})
