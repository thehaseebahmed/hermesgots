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
async function seed(thread: { id: string; at: number; sessionAt?: number }, patch: Partial<Profile> = {}) {
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

/** The chats one band of the legacy sidebar drew, by the address each one leads to. */
const band = (name: string) =>
  findAll(`[data-band="${name}"] a[href^="/c/"]`).map((row) => row.getAttribute("href"))

/**
 * The legacy layout over the chats a case wants, written straight to the device: that layout has no
 * bot list, so every row of it is a chat here. A chat nothing was said in carries one clock at both
 * its ends, exactly as the New chat press mints one.
 */
async function legacyChats(
  chats: {
    id: string
    at: number
    created?: number
    archived?: boolean
    pinned?: boolean
    pinnedAt?: number
  }[],
) {
  await reset({ legacy: true })
  await db.conversations.bulkPut(
    chats.map(({ id, at, created = at - 1, archived, pinned, pinnedAt }) => ({
      id,
      profileId: bot.id,
      title: id,
      hermesSessionId: `gots-${id}`,
      createdAt: created,
      updatedAt: at,
      changedAt: at,
      ...(archived ? { archived: true } : {}),
      ...(pinned || pinnedAt !== undefined ? { pinned: true } : {}),
      ...(pinnedAt !== undefined ? { pinnedAt } : {}),
    })),
  )
}

test("an archived chat is in no band, an unstarted one is in no band", async () => {
  // The Archived pill is the only place an archived row stands, and the legacy bands hold no pill: a
  // row here would be one nothing could bring back. A chat nothing was said in and no draft holds is
  // no row of any list (ADR 0158), this one included — the rule and its reads are the bot's list's,
  // which is why the sidebar asks that reader rather than growing its own.
  await legacyChats([
    { id: "said", at: 500 },
    // A pin an archived row kept through a merge: out of the pinned band too, since it is no band's.
    { id: "set-aside", at: 900, archived: true, pinnedAt: 800 },
    { id: "unstarted", at: 1_000, created: 1_000 },
  ])
  await mount(screen("/"), async () => {
    await until(async () => band("recents").includes("/c/said"), "the chat that was spoken in")
    // The archived pin first, so a red run names the archive rather than only the chat beside it.
    assert.deepEqual(band("pinned"), [], "an archived pin is no pin in a layout with no pill")
    assert.deepEqual(
      band("recents"),
      ["/c/said"],
      "and a chat nothing was said in is no band's row",
    )
  })
})

test("an unstarted chat holding a draft is still a row of Recents", async () => {
  // The rule drops a chat nothing was said in, not one the reader is in the middle of: a saved draft
  // is what keeps it, and the sidebar reads drafts the same way the bot's list does.
  await legacyChats([{ id: "typing", at: 1_000, created: 1_000 }])
  await db.drafts.put({ id: "c:typing", text: "Three words", at: 1_000 })
  await mount(screen("/"), async () => {
    await until(
      async () => band("recents").includes("/c/typing"),
      "the chat this device is holding words for",
    )
  })
})

test("the pinned band reads the order the pins were made in, not each chat's clock", async () => {
  // A pin's place is when it was made, so the band above Recents is ranked by that: the earlier pin on
  // top even though its chat has said less recently, and a pin written before the app kept a clock
  // reading as the earliest. The unpinned band keeps the list's own rule, newest first.
  await legacyChats([
    { id: "pinned-first", at: 500, pinned: true },
    { id: "pinned-second", at: 900, pinnedAt: 700 },
    { id: "spoken-latest", at: 1_000 },
  ])
  await mount(screen("/"), async () => {
    await until(async () => band("pinned").length === 2, "both pinned chats")
    assert.deepEqual(
      band("pinned"),
      ["/c/pinned-first", "/c/pinned-second"],
      "the pins in the order they were made",
    )
    assert.deepEqual(
      band("recents"),
      ["/c/spoken-latest"],
      "and the unpinned chat by its own clock",
    )
  })
})

test("the legacy layout's sheet offers no Archive, since no pill here could hold the row", async () => {
  // Archive is drawn only where the Archived pill is: on this layout a press would take the row out
  // of every band with no way back, so the sheet offers the pin and no archive.
  await legacyChats([{ id: "no-way-back", at: 500 }])
  await mount(screen("/c/no-way-back"), async () => {
    await until(async () => Boolean(find("[data-chat-settings-open]")), "the chat's bar")
    await click(find("[data-chat-settings-open]"))
    await until(async () => Boolean(find("[data-chat-pin]")), "the sheet")
    assert.equal(missing("[data-chat-archive]"), true, "no Archive, and so no one-way door")
  })
})

test("an archived chat's sheet on the legacy layout still offers the way back", async () => {
  // Unarchive is not the pill's: an archive that arrived by merge is in no band here, and a layout
  // with no pill must still be able to bring the row back.
  await legacyChats([{ id: "set-aside", at: 500, archived: true }])
  await mount(screen("/c/set-aside"), async () => {
    await until(async () => Boolean(find("[data-chat-settings-open]")), "the chat's bar")
    await click(find("[data-chat-settings-open]"))
    await until(async () => Boolean(find("[data-chat-archive]")), "the sheet's way back")
    assert.equal(wordsOf(find("[data-chat-archive]")), "Unarchive", "naming what the press does")
    await click(find("[data-chat-archive]"))
    await until(
      async () => (await db.conversations.get("set-aside"))?.archived === undefined,
      "the mark to clear",
    )
  })
})
