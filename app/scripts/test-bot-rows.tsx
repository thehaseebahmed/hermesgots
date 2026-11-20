import assert from "node:assert/strict"
import test from "node:test"
import { MemoryRouter, Route, Routes } from "react-router"

import { ConversationList } from "@/components/conversation-list"
import { db, type Profile } from "@/lib/db"
import { markRead, readMark } from "@/lib/read-marks"
import { formatRelative } from "@/lib/relative"
import { ChatPage } from "@/routes/chat"
import {
  absent,
  botProfile,
  chatScreen,
  click,
  find,
  findAll,
  findText,
  json,
  missing,
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
 * The device a case starts from: the one bot on it and nothing else — no chat, no draft, no message —
 * with the app's switches as the case wants them and a host that answers nothing.
 */
async function reset({
  patch = {},
  legacy = false,
}: {
  patch?: Partial<Profile>
  legacy?: boolean
} = {}) {
  await seedSettings({
    developer: true,
    ...(legacy ? { legacyChat: true } : {}),
    activeProfileId: bot.id,
  })
  await db.profiles.clear()
  await db.profiles.put({ ...bot, ...patch })
  await db.messages.clear()
  await db.drafts.clear()
  await db.conversations.clear()
  globalThis.fetch = async () => json({})
}

/**
 * One bot with Main, a thread of its own and a coding session, and nothing else in the device. The
 * thread's own clock is `thread.at`, so a case can put its activity either side of a read mark.
 */
async function seed(
  thread: { id: string; at: number; sessionAt?: number },
  patch: Partial<Profile> = {},
) {
  await reset({ patch })
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
}

/** The bot's own row: the one the sidebar's bot list draws, by the address it leads to. */
const botRow = () => find(`a[href="/b/${bot.id}"]`)
/** Whether a row is drawn as the one the reader is in, the way its tinting says it. */
const selected = (row: Element | null) => Boolean(row?.className.split(/\s+/).includes("bg-muted"))
/** The row's unread mark, as the list draws it. */
const dotted = (row: Element | null) => Boolean(row?.querySelector("[data-unread]"))
/** A row's unread mark is the list rows' own dot: one, blue, on the bot's head. */
function assertHeadDot(row: Element | null) {
  const dots = row?.querySelectorAll("[data-unread]") ?? []
  assert.equal(dots.length, 1, "one dot a row")
  assert.ok(dots[0].parentElement?.querySelector("img"), "on the bot's head")
  assert.ok(dots[0].classList.contains("bg-info"), "in the blue an unread chat's row wears")
}
const stateOf = (row: Element | null) =>
  row?.querySelector('[data-slot="bot-state"]')?.textContent ?? null

/** The sidebar over a screen, so a case can open a chat by the row that leads to it. */
const screen = (entry: string, also?: { to: string }) => (
  <MemoryRouter initialEntries={[entry]}>
    <Path />
    <ConversationList />
    {also && <SwitchTo to={also.to} />}
    <Routes>
      <Route path="c/:id" element={<ChatPage slot="route" />} />
      {/* The flat layout's list is the bot's own address, so a chat's way back lands there. */}
      <Route path="b/:profileId" element={<p data-list />} />
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
    assertHeadDot(botRow())
    assert.equal(
      find("[data-unread]")?.getAttribute("aria-hidden"),
      "true",
      "and the mark is the dot, so the words carry the state",
    )
  })
})

test("the sidebar's preview and count skip an unstarted chat", async () => {
  // A chat nothing has been said in is no row of the bot's list (ADR 0158), and the sidebar's line about
  // the bot is read off that list: its age is the newest chat the list draws, and its count is what this
  // device has not read of them. A record the New chat press minted — newer than everything, and empty —
  // is neither, or a bot would say "now" and count a chat nobody has opened.
  const DAY = 86_400_000
  const at = Date.now() - 40 * DAY
  await seed({ id: "said-thread", at })
  const minted = Date.now()
  await db.conversations.put({
    id: "unstarted",
    profileId: bot.id,
    title: "New chat",
    hermesSessionId: "gots-unstarted",
    createdAt: minted,
    updatedAt: minted,
    changedAt: minted,
  })
  markRead("said-thread", at - 1)
  markRead("unstarted", 1)
  await mount(screen("/"), async () => {
    await until(
      async () => stateOf(botRow()) === "1 unread",
      "the row to count the chat that was spoken in, and only it",
    )
    assert.ok(
      wordsOf(botRow()).includes(formatRelative(at, Date.now())),
      "and to be aged by that chat, not by the empty record newer than it",
    )
  })
})

test("an archived chat is neither the sidebar's preview of its bot nor part of its count", async () => {
  // An archived row is the Archived pill's alone, and a bot's row leads to a list whose All is the
  // rows nobody archived: the row's mark cannot be news its list would never draw, and its clock
  // cannot be the bot's age.
  const DAY = 86_400_000
  const at = Date.now() - 30 * DAY
  await seed({ id: "kept-thread", at })
  await db.conversations.put({
    id: "set-aside",
    profileId: bot.id,
    title: "Set aside",
    hermesSessionId: "gots-set-aside",
    createdAt: at + 1,
    updatedAt: Date.now(),
    changedAt: at + 1,
    archived: true,
  })
  markRead("kept-thread", at - 1)
  markRead("set-aside", 1)
  await mount(screen("/"), async () => {
    await until(
      async () => stateOf(botRow()) === "1 unread",
      "the row to count the chat that was spoken in, and only it",
    )
    assert.ok(
      wordsOf(botRow()).includes(formatRelative(at, Date.now())),
      "and to be aged by that chat, not by the record the reader put away",
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
    await until(
      async () => stateOf(botRow()) === "Not seen yet",
      "the row to say nothing has answered",
    )
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
      assertHeadDot(botRow())
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
    await until(
      async () => stateOf(botRow()) === "1 unread",
      "the room to count as one conversation",
    )
    assert.equal(dotted(botRow()), true, "with the mark that says so")
  })
})

test("an archived room is counted toward no bot's unread", async () => {
  await seed(
    { id: "room-quiet-thread", at: 2 },
    { hostId: "host-1", seenAt: Date.now(), hermesProfile: "main" },
  )
  // A room lists in every bot its roster seats (ADR 0115), and an archived one is the Archived
  // pill's alone in each of them: the mark on it is no news on a bot's row.
  const carrier = { ...bot, id: "bot-2", name: "Other", hermesProfile: "other" }
  await db.profiles.put(carrier)
  await db.conversations.put({
    id: "room-set-aside",
    profileId: carrier.id,
    title: "A room set aside",
    hermesSessionId: "room-set-aside",
    room: {
      id: "room-set-aside",
      members: [{ memberId: "m1", profile: "main", handle: "main", displayName: "Mainly" }],
    },
    roomNeeds: { at: 600 },
    archived: true,
    createdAt: 5,
    updatedAt: 600,
    changedAt: 600,
  })
  markRead("room-set-aside", 100)
  await mount(screen("/"), async () => {
    await until(async () => stateOf(botRow()) === "Online", "a row with nothing unread on it")
    assert.equal(dotted(botRow()), false, "and no mark")
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
    assert.equal(
      dotted(botRow()),
      false,
      "a device that never read the thread has no mark to be past",
    )
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
    await until(
      async () => readMark("mark-thread") === 777,
      "the mark the thread's own render wrote",
    )
  })
})

test("no layout draws Recents, a Rooms section, a routines row or New chat", async () => {
  // The sidebar is the app's screens and its bots (ADR 0161). The Recents list, its bands, the Rooms
  // section only it drew, its routines row and its New chat button left with the layout that held
  // them (ADR 0162), so neither setting can draw one: a chat is started from the list it belongs to,
  // and a room is a row of every list whose roster seats it.
  for (const legacy of [false, true]) {
    await seed({ id: `sidebar-${legacy}`, at: 2 })
    await seedSettings({
      developer: true,
      ...(legacy ? { legacyChat: true } : {}),
      activeProfileId: bot.id,
    })
    await mount(
      <MemoryRouter initialEntries={["/"]}>
        <ConversationList />
      </MemoryRouter>,
      async () => {
        await until(async () => Boolean(botRow()), "the bot's row")
        assert.equal(missing('[aria-labelledby="recents-heading"]'), true, "no Recents list")
        assert.equal(findAll("[data-band]").length, 0, "and no band of one")
        assert.equal(missing('a[href="/routines"]'), true, "no routines row")
        assert.equal(missing('button[aria-label="New chat"]'), true, "and no New chat button")
        assert.equal(missing('[data-slot="new-room"]'), true, "nor a Rooms section's New room")
        assert.equal(findAll("h2").filter((one) => wordsOf(one) === "Rooms").length, 0, "nor Rooms")
      },
    )
  }
})

test("a flat-layout chat is offered Archive, since that layout has the pill too", async () => {
  // Both layouts draw the Archived pill, so neither has a row a press could not bring back: the
  // sheet's Archive and its way back are drawn wherever a chat's sheet is.
  await reset({ legacy: true })
  await db.conversations.put({
    id: "flat-kept",
    profileId: bot.id,
    title: "Kept",
    hermesSessionId: "gots-flat-kept",
    createdAt: 1,
    updatedAt: 2,
    changedAt: 2,
  })
  await mount(screen("/c/flat-kept"), async () => {
    await until(async () => Boolean(find("[data-chat-settings-open]")), "the chat's bar")
    await click(find("[data-chat-settings-open]"))
    await until(async () => Boolean(find("[data-chat-archive]")), "the sheet's archive")
    assert.equal(wordsOf(find("[data-chat-archive]")), "Archive", "naming what the press does")
    await click(find("[data-chat-archive]"))
    await until(
      async () => (await db.conversations.get("flat-kept"))?.archived === true,
      "the mark it wrote",
    )
    // The press leaves the conversation the same way on either layout: the flat layout's list is
    // the bot's own address, so that is where the step back lands.
    await until(
      async () => path() === `/b/${bot.id}`,
      "the bot's own address, the flat layout's list, the step the bar's back control takes",
    )
  })
})
