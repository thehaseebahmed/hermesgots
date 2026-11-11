import assert from "node:assert/strict"
import test from "node:test"
import { MemoryRouter, Route, Routes } from "react-router"

import { ConversationList } from "@/components/conversation-list"
import { db } from "@/lib/db"
import { markRead, readMark } from "@/lib/read-marks"
import { ChatPage } from "@/routes/chat"
import {
  absent,
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
  wordsOf,
} from "./component-kit.tsx"

const bot = botProfile("bot-rows", { id: "bot-1", name: "Mainly" })
const MAIN = "main-bot-1"

/**
 * One bot with Main, a thread of its own and a coding session, and nothing else in the device. The
 * thread's own clock is `thread.at`, so a case can put its activity either side of a read mark.
 */
async function seed(thread: { id: string; at: number; sessionAt?: number }) {
  await seedSettings({ developer: true, activeProfileId: bot.id })
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
const botRow = () => find(`a[href="/b/${bot.id}"]`)
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

test("the bot layout's sidebar has no Routines row, and the legacy one keeps its own", async () => {
  // The bot layout reaches a bot's routines from that bot's list, so a sidebar row there would open
  // a screen the list already offers. The legacy layout has no bot list at all: with the row gone
  // too, the Developer switch would leave its reader with no way to their routines.
  await seed({ id: "routines-thread", at: 2 })
  await mount(screen("/"), async () => {
    await until(async () => Boolean(botRow()), "the bot's row")
    absent('a[href="/routines"]', "the bot layout opens routines from the bot's list")
  })
  await seedSettings({ developer: true, legacyChat: true, activeProfileId: bot.id })
  await mount(screen("/"), async () => {
    await until(async () => Boolean(find('a[href="/routines"]')), "the legacy sidebar's routines row")
    assert.equal(wordsOf(find('a[href="/routines"]')), "Routines", "named as the screen it opens")
  })
})

test("a bot's newest row being a routine's, the sidebar says the line the list says", async () => {
  // A routine's row has no message on this device: its line is the record's. The sidebar reads the
  // newest chat's tail, which a run doesn't have, so without its record's line the row falls back
  // to the routine's name — one thing in the sidebar and another in the list.
  await seedSettings({ developer: true, activeProfileId: bot.id })
  await db.profiles.clear()
  await db.profiles.put(bot)
  await db.messages.clear()
  await db.conversations.clear()
  await db.conversations.bulkPut([
    {
      id: "routine-job-1-cron_9",
      profileId: bot.id,
      title: "Morning watch",
      routine: true,
      line: "The tide turns at 06:40, and the wind is from the west.",
      hermesSessionId: "cron_9",
      createdAt: 1,
      updatedAt: 500,
      changedAt: 1,
    },
    {
      id: "older-chat",
      profileId: bot.id,
      title: "An older chat",
      hermesSessionId: "gots-older-chat",
      createdAt: 2,
      updatedAt: 400,
      changedAt: 2,
    },
  ])
  globalThis.fetch = async () => json({})
  await mount(screen("/"), async () => {
    await until(async () => Boolean(botRow()), "the bot's row")
    assert.ok(
      wordsOf(botRow()).includes("The tide turns at 06:40"),
      "the run's own line, as the bot's list draws it",
    )
  })
})

test("with the switch off the sidebar lists chats, and no bot row is drawn", async () => {
  // The legacy layout is the opt-out now (`legacyChat`), not the bots layout's on-switch (#110).
  await seedSettings({ developer: true, legacyChat: true, activeProfileId: bot.id })
  await db.profiles.clear()
  await db.profiles.put(bot)
  await db.conversations.clear()
  await db.messages.clear()
  globalThis.fetch = async () => json({})
  await mount(screen("/"), async () => {
    await until(async () => findAll("nav").length > 0, "the sidebar")
    // `absent`, not `assert.equal` against null: a DOM element compared to null builds a diff of the
    // whole element, and a run that should have said one sentence instead ate the machine.
    absent(`a[href="/b/${bot.id}"]`, "no bots layout, no bot row")
  })
})

test("a bot turned off in Gots takes its chats out of Recents", async () => {
  const gone = botProfile("bot-gone", { id: "bot-2", name: "Gone", disabled: true })
  await seedSettings({ developer: true, legacyChat: true, activeProfileId: bot.id })
  await db.profiles.clear()
  await db.profiles.bulkPut([bot, gone])
  await db.messages.clear()
  await db.conversations.clear()
  await db.conversations.bulkPut([
    {
      id: "kept",
      profileId: bot.id,
      title: "Kept",
      hermesSessionId: "gots-kept",
      createdAt: 1,
      updatedAt: 2,
      changedAt: 1,
    },
    {
      id: "off",
      profileId: gone.id,
      title: "Turned off",
      hermesSessionId: "gots-off",
      createdAt: 2,
      updatedAt: 3,
      changedAt: 2,
    },
  ])
  globalThis.fetch = async () => json({})
  await mount(screen("/"), async () => {
    await until(async () => Boolean(find('a[href="/c/kept"]')), "the kept chat's row")
    absent('a[href="/c/off"]', "a turned-off bot's row is not in Recents")
  })
})
