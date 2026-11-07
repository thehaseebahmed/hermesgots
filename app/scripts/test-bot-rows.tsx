import assert from "node:assert/strict"
import test from "node:test"
import { MemoryRouter, Route, Routes } from "react-router"

import { ConversationList } from "@/components/conversation-list"
import { db, mainThreadId } from "@/lib/db"
import { markRead, readMark } from "@/lib/read-marks"
import { ChatPage } from "@/routes/chat"
import {
  botProfile,
  chatScreen,
  click,
  find,
  findAll,
  json,
  mount,
  Path,
  path,
  seedSettings,
  SwitchTo,
  until,
} from "./component-kit.tsx"

const bot = botProfile("bot-rows", { id: "bot-1", name: "Mainly" })
const MAIN = mainThreadId(bot.id)

/**
 * One bot with Main, a thread of its own and a coding session, and nothing else in the device. The
 * thread's own clock is `thread.at`, so a case can put its activity either side of a read mark.
 */
async function seed(thread: { id: string; at: number; sessionAt?: number }) {
  await seedSettings({ developer: true, botThreads: true, activeProfileId: bot.id })
  await db.profiles.clear()
  await db.profiles.put(bot)
  await db.messages.clear()
  await db.conversations.clear()
  await db.conversations.bulkPut([
    {
      id: MAIN,
      profileId: bot.id,
      title: "Main",
      main: true,
      hermesSessionId: "gots-main",
      createdAt: 1,
      updatedAt: 1,
      changedAt: 1,
    },
    {
      id: thread.id,
      profileId: bot.id,
      title: "A thread",
      hermesSessionId: `gots-${thread.id}`,
      createdAt: 2,
      updatedAt: thread.at,
      changedAt: 2,
    },
    {
      id: "row-session",
      profileId: bot.id,
      projectId: "project-1",
      title: "A session",
      hermesSessionId: "gots-row-session",
      createdAt: 3,
      updatedAt: thread.sessionAt ?? 3,
      changedAt: 3,
    },
  ])
  globalThis.fetch = async () => json({})
}

/** The bot's own row: the one the sidebar's bot list draws, by the address it leads to. */
const botRow = () => find(`a[href="/c/${MAIN}"]`)
/** Whether a row is drawn as the one the reader is in, the way its tinting says it. */
const selected = (row: Element | null) => Boolean(row?.className.split(/\s+/).includes("bg-muted"))
/** The row's unread mark, as the list draws it. */
const dotted = (row: Element | null) => Boolean(row?.querySelector("[data-unread]"))

/** The sidebar over a screen, so a case can open a chat by the row that leads to it. */
const screen = (entry: string, also?: { to: string }) => (
  <MemoryRouter initialEntries={[entry]}>
    <Path />
    <ConversationList />
    {also && <SwitchTo to={also.to} />}
    <Routes>
      <Route path="c/:id" element={<ChatPage slot="route" />} />
    </Routes>
  </MemoryRouter>
)

test("a coding session's screen is not its bot's, so the sidebar row stays unselected", async () => {
  await seed({ id: "select-thread", at: 2 })
  await mount(screen("/c/row-session"), async () => {
    await until(async () => Boolean(botRow()), "the bot's row")
    assert.equal(
      selected(botRow()),
      false,
      "a session belongs to Code's list, never to the bot's row",
    )
  })
})

test("the bot's own thread is the row that reads as open", async () => {
  await seed({ id: "select-thread", at: 2 })
  await mount(screen("/c/select-thread"), async () => {
    await until(async () => Boolean(botRow()), "the bot's row")
    assert.equal(selected(botRow()), true, "a thread of the bot's is the bot's own screen")
  })
})

test("a bot with something newer than this device's mark dots its row", async () => {
  await seed({ id: "dot-thread", at: 500 })
  markRead("dot-thread", 100)
  await mount(screen("/"), async () => {
    await until(async () => Boolean(botRow()), "the bot's row")
    assert.equal(dotted(botRow()), true, "a thread read before its last turn is news")
    assert.ok(
      botRow()?.textContent?.includes("New activity"),
      "and the dot says so to a reader who cannot see it",
    )
  })
})

test("a coding session's news never dots its bot's row", async () => {
  await seed({ id: "session-quiet-thread", at: 2, sessionAt: 500 })
  markRead("session-quiet-thread", 900)
  markRead("row-session", 100)
  await mount(screen("/"), async () => {
    await until(async () => Boolean(botRow()), "the bot's row")
    assert.equal(
      dotted(botRow()),
      false,
      "a session's news is Code's row to report: the bot's row cannot lead to it",
    )
  })
})

test("a bot never opened on this device draws no dot, as Code's rows don't", async () => {
  await seed({ id: "unmarked-thread", at: 500 })
  await mount(screen("/"), async () => {
    await until(async () => Boolean(botRow()), "the bot's row")
    assert.equal(dotted(botRow()), false, "a device that never read the thread has no mark to be past")
  })
})

test("a bot read up to its newest turn draws no dot", async () => {
  await seed({ id: "read-thread", at: 500 })
  markRead("read-thread", 900)
  await mount(screen("/"), async () => {
    await until(async () => Boolean(botRow()), "the bot's row")
    assert.equal(dotted(botRow()), false, "activity at or behind the mark is read")
  })
})

test("opening the thread writes its mark, and the row's dot clears", async () => {
  await seed({ id: "clear-thread", at: 500 })
  markRead("clear-thread", 100)
  await mount(screen("/", { to: "/c/clear-thread" }), async () => {
    await until(async () => dotted(botRow()), "the dot before the thread is read")
    await click(find("[data-switch]"))
    await until(async () => path() === "/c/clear-thread", "the thread's own screen")
    await until(async () => !dotted(botRow()), "the dot to clear once the thread renders")
    assert.equal(readMark("clear-thread"), 500, "by the mark the thread's own render wrote")
  })
})

test("a thread's render writes its mark, which is the moment the row measures against", async () => {
  await seed({ id: "mark-thread", at: 777 })
  await mount(chatScreen("mark-thread"), async () => {
    await until(async () => readMark("mark-thread") === 777, "the mark the thread's own render wrote")
  })
})

test("with the switch off the sidebar lists chats, and no bot row is drawn", async () => {
  await seedSettings({ developer: true, botThreads: false, activeProfileId: bot.id })
  await db.profiles.clear()
  await db.profiles.put(bot)
  await db.conversations.clear()
  await db.messages.clear()
  globalThis.fetch = async () => json({})
  await mount(screen("/"), async () => {
    await until(async () => findAll("nav").length > 0, "the sidebar")
    assert.equal(find(`a[href="/c/${MAIN}"]`), null, "no bots layout, no bot row")
  })
})
