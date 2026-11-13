import assert from "node:assert/strict"
import test from "node:test"
import { MemoryRouter, Route, Routes } from "react-router"

import { ConversationList } from "@/components/conversation-list"
import { db, type Profile } from "@/lib/db"
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
async function seed(thread: { id: string; at: number; sessionAt?: number }, patch: Partial<Profile> = {}) {
  await seedSettings({ developer: true, activeProfileId: bot.id })
  await db.profiles.clear()
  await db.profiles.put({ ...bot, ...patch })
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
const stateOf = (row: Element | null) => row?.querySelector('[data-slot="bot-state"]')?.textContent ?? null

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

test("a bot with something newer than this device's mark says how many, and dots its row", async () => {
  await seed({ id: "dot-thread", at: 500 })
  // A second conversation past its own mark: the count is conversations, not messages.
  await db.conversations.put({
    id: "other-thread",
    profileId: bot.id,
    title: "Another thread",
    hermesSessionId: "gots-other-thread",
    createdAt: 4,
    updatedAt: 600,
    changedAt: 4,
  })
  markRead("dot-thread", 100)
  markRead("other-thread", 100)
  await mount(screen("/"), async () => {
    await until(async () => stateOf(botRow()) === "2 unread", "the row to count both of them")
    assert.equal(dotted(botRow()), true, "a thread read before its last turn is news")
    assert.equal(
      find("[data-unread]")?.getAttribute("aria-hidden"),
      "true",
      "and the mark is the dot, so the words carry the state",
    )
  })
})

test("a quiet bot's row says its host is checking in", async () => {
  await seed({ id: "quiet-online", at: 2 }, { hostId: "host-1", seenAt: Date.now() })
  await mount(screen("/"), async () => {
    await until(async () => stateOf(botRow()) === "Online", "the row to say its host is here")
    assert.equal(dotted(botRow()), false, "nothing unread draws no mark")
  })
})

test("a quiet bot's row says Offline once its host goes stale", async () => {
  // Past `ONLINE_MS`, the host's own last answer is what this device reads the bot by.
  await seed({ id: "quiet-stale", at: 2 }, { hostId: "host-1", seenAt: Date.now() - 26 * 60_000 })
  await mount(screen("/"), async () => {
    await until(async () => stateOf(botRow()) === "Offline", "the row to say its host is gone")
    assert.equal(dotted(botRow()), false, "a stale host is not something unread")
  })
})

test("a quiet bot's row says Not seen yet until its host has answered once", async () => {
  // Linked, and nothing heard: the same words Settings' Enabled row uses for the same bot, so the
  // row never falls silent and never calls a bot it cannot place Offline.
  await seed({ id: "quiet-unseen", at: 2 }, { hostId: "host-1" })
  await mount(screen("/"), async () => {
    await until(async () => stateOf(botRow()) === "Not seen yet", "the row to say nothing has answered")
    assert.equal(dotted(botRow()), false, "and nothing unread draws no mark")
  })
})

test("a bot no host registered says it is not linked", async () => {
  // A bot added by hand: no host to check in, so the row says what is missing rather than nothing,
  // in the vocabulary Settings' own `Link a bot` row uses.
  await seed({ id: "quiet-unlinked", at: 2 })
  await mount(screen("/"), async () => {
    await until(async () => stateOf(botRow()) === "Not linked", "the row to say what is missing")
    assert.equal(dotted(botRow()), false, "and nothing unread draws no mark")
  })
})

test("the collapsed rail marks unread on the avatar, where no line says it", async () => {
  // The rail draws no subtitle, so the avatar's corner is the row's only way to say it has news —
  // and it says it to a reader by the words that carry it (ADR 0151).
  await seed({ id: "rail-thread", at: 500 })
  markRead("rail-thread", 100)
  await mount(
    <MemoryRouter initialEntries={["/"]}>
      <ConversationList collapsed />
    </MemoryRouter>,
    async () => {
      await until(async () => dotted(botRow()), "the rail's mark")
      assert.equal(stateOf(botRow()), null, "a rail draws no line under the name")
      assert.ok(botRow()?.textContent?.includes("New activity"), "so the words say it instead")
    },
  )
})

test("a room its roster seats counts toward the bot's unread", async () => {
  await seed(
    { id: "room-thread", at: 2 },
    { hostId: "host-1", seenAt: Date.now(), hermesProfile: "main" },
  )
  // A room is nobody's chat, and it lists in every bot its roster seats rather than in the bot that
  // carried the record here (ADR 0115) — so another bot of the same host carries it. Its row is
  // unread by the same rule a chat's is, and `roomNeeds` is already at the record's own clock, so the
  // list asks the Host for nothing while this case runs.
  const carrier = { ...bot, id: "bot-2", name: "Other", hermesProfile: "other" }
  await db.profiles.put(carrier)
  await db.conversations.put({
    id: "room-1",
    profileId: carrier.id,
    title: "A room",
    hermesSessionId: "room-1",
    room: {
      id: "room-1",
      members: [{ memberId: "m1", profile: "main", handle: "main", displayName: "Mainly" }],
    },
    roomNeeds: { at: 600 },
    createdAt: 5,
    updatedAt: 600,
    changedAt: 600,
  })
  markRead("room-1", 100)
  await mount(screen("/"), async () => {
    await until(async () => stateOf(botRow()) === "1 unread", "the room to count as one conversation")
    assert.equal(dotted(botRow()), true, "with the mark that says so")
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
