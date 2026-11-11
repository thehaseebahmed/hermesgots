/**
 * The memory is this device's own, so a case writes it where the app keeps it — the address of the
 * chat a bot was last in, under the bot's id — and never through the module that reads it.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { Link, MemoryRouter, Route, Routes } from "react-router"

import { db } from "@/lib/db"
import { BotChatsPage } from "@/routes/bot-chats"

import {
  Nav,
  Path,
  botProfile,
  click,
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

/** The chat a bot was last in, as the address named it: what this device keeps for the landing. */
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
 * already — a load of it, or the step back a chat's control leaves — and `listed` is the state the
 * app marks such an entry with.
 */
const screen = ({ from = "/", at, listed }: { from?: string; at?: string; listed?: boolean } = {}) => (
  <MemoryRouter
    initialEntries={[listed ? { pathname: at ?? `/b/${bot.id}`, state: { listed } } : (at ?? from)]}
  >
    <Path />
    <Nav />
    <Link to={`/b/${bot.id}`}>the bot</Link>
    <Routes>
      <Route path="b/:profileId" element={<BotChatsPage />} />
      <Route path="c/:id" element={<p data-chat />} />
      <Route path="new-room" element={<p data-new-room />} />
    </Routes>
  </MemoryRouter>
)

const theBot = () => findText("a", "the bot")

test("a bot this device has never opened draws its list", async () => {
  await seed([
    { id: "a", at: 100 },
    { id: "b", at: 200 },
  ])
  await mount(screen(), async () => {
    await click(theBot())
    await until(async () => rowIds().length === 2, "the bot's chats")
    assert.equal(path(), `/b/${bot.id}`, "and nothing opens from it")
  })
})

test("a bot opens the chat this device last had open there", async () => {
  await seed([
    { id: "a", at: 100 },
    { id: "b", at: 200 },
  ])
  remember(bot.id, "a")
  await mount(screen(), async () => {
    await click(theBot())
    await until(async () => path() === "/c/a", "the chat the bot was left in")
    assert.deepEqual(rowIds(), [], "the list is not what was drawn")
    assert.equal(nav(), "REPLACE:/c/a", "taking the address's entry rather than pushing one")
  })
})

const settled = () => rowIds().length > 0 || path().startsWith("/c/")

test("a memory of another bot's chat draws the list, not a chat it guessed at", async () => {
  await seed([
    { id: "a", at: 100 },
    { id: "b", at: 200 },
    { id: "theirs", at: 300, bot: other.id },
  ])
  remember(bot.id, "theirs")
  await mount(screen(), async () => {
    await click(theBot())
    await until(async () => settled(), "the landing to settle")
    assert.equal(path(), `/b/${bot.id}`, "the list is what a bot with nothing to open draws")
    assert.equal(rowIds().length, 2, "this bot's own chats, drawn to pick from")
  })
})

test("a memory of a chat that has gone draws the list", async () => {
  await seed([
    { id: "a", at: 100 },
    { id: "b", at: 200 },
  ])
  remember(bot.id, "deleted")
  await mount(screen(), async () => {
    await click(theBot())
    await until(async () => settled(), "the landing to settle")
    assert.equal(path(), `/b/${bot.id}`, "the list is what a bot with nothing to open draws")
    assert.equal(rowIds().length, 2, "the bot's chats, drawn to pick from")
  })
})

test("a routine's run is never the chat its bot opens on", async () => {
  await seed([
    { id: "chat", at: 100 },
    { id: "run", at: 300, routine: true },
  ])
  remember(bot.id, "run")
  await mount(screen(), async () => {
    await click(theBot())
    await until(async () => settled(), "the landing to settle")
    assert.equal(path(), `/b/${bot.id}`, "the list, not the run the memory named")
    assert.equal(rowIds().length, 2, "the bot's chat and its run, drawn to pick from")
  })
})

test("a bot with nothing left to open draws its list", async () => {
  await seed([])
  remember(bot.id, "deleted")
  await mount(screen(), async () => {
    await click(theBot())
    await until(async () => Boolean(findText("p", "No chats yet.")), "the empty list")
    assert.equal(path(), `/b/${bot.id}`, "the bot's own address, with nothing to open")
  })
})

test("a list a chat stepped back onto draws itself, not the chat it came from", async () => {
  await seed([
    { id: "a", at: 100 },
    { id: "b", at: 200 },
  ])
  remember(bot.id, "a")
  await mount(screen({ listed: true }), async () => {
    await until(async () => rowIds().length === 2, "the bot's chats")
    assert.equal(path(), `/b/${bot.id}`, "the list the reader stepped back onto")
  })
})

test("a bot's own address draws the list, so a press back never bounces into the chat", async () => {
  await seed([
    { id: "a", at: 100 },
    { id: "b", at: 200 },
  ])
  // A load of the address, or a step back onto it: the browser's own arrival is a pop, as MemoryRouter
  // gives one on the entry it starts at.
  remember(bot.id, "a")
  await mount(screen({ at: `/b/${bot.id}` }), async () => {
    await until(async () => rowIds().length === 2, "the bot's chats")
    assert.equal(path(), `/b/${bot.id}`, "still the list")
  })
})

test("Main is a row of its list like any other, and the landing finds it", async () => {
  await seed([
    { id: MAIN, at: 100 },
    { id: "b", at: 200 },
  ])
  remember(bot.id, MAIN)
  await mount(screen(), async () => {
    await click(theBot())
    await until(async () => path() === `/c/${MAIN}`, "the bot's own chat")
  })
})
