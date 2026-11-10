/**
 * A bot's screen is the list of its chats: `/b/<bot>` draws them, flat — its pinned ones first and the
 * rest by what was last said — each a row with a chat's icon, its title, its last line, its age and the
 * dot this device's read mark decides, and a reply that waits on the reader marked on its row. The
 * header's title is the way to the bot's settings, the search narrows the rows to what it finds in a
 * title or a line, and the foot starts a chat or a room. `scripts/test-chat-list.mjs` holds the rules
 * (the order, the row's shape, the search); this holds the screen they are drawn by.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { MemoryRouter, Route, Routes } from "react-router"

import { BotChatsPage } from "@/routes/bot-chats"
import { db, type Message } from "@/lib/db"
import { markRead } from "@/lib/read-marks"
import {
  Path,
  absent,
  botProfile,
  click,
  find,
  findAll,
  findText,
  json,
  mount,
  path,
  seedSettings,
  settle,
  type,
  until,
  wordsOf,
} from "./component-kit.tsx"

const bot = botProfile("bot-chats", { id: "bot-1", name: "Mainly", hermesProfile: "default" })

/** What this bot's Host says its plugin offers: a room may be made where the Host advertises it. */
let offers = ["chats", "rooms", "rooms_write"]
/** How many times a Host was asked what its plugin offers, so a case can wait for its answer. */
let infoReads = 0

interface Seed {
  id: string
  title: string
  /** The chat's own clock, and the time of the message unless `said` names one. */
  at: number
  pinned?: boolean
  /** The newest thing said in it, and when; a chat with no `said` has no rows. */
  said?: string
  saidAt?: number
  /** A reply that waits on the reader: a question or an approval it asked. */
  waits?: "clarify" | "approval"
  /** Another message under the newest one, so a case can prove the row reads the tail alone. */
  earlier?: string
}

function message(chat: string, content: string, at: number, patch: Partial<Message> = {}): Message {
  return {
    id: `${chat}-${at}`,
    conversationId: chat,
    role: "assistant",
    content,
    status: "done",
    createdAt: at,
    ...patch,
  }
}

async function seed(
  chats: Seed[],
  { rooms = true, host = bot }: { rooms?: boolean; host?: typeof bot } = {},
) {
  offers = rooms ? ["chats", "rooms", "rooms_write"] : ["chats", "rooms"]
  infoReads = 0
  await seedSettings({ developer: true, activeProfileId: host.id })
  await db.profiles.clear()
  await db.profiles.put(host)
  await db.conversations.clear()
  await db.messages.clear()
  await db.conversations.bulkPut(
    chats.map((one) => ({
      id: one.id,
      profileId: host.id,
      title: one.title,
      pinned: one.pinned,
      hermesSessionId: `gots-${one.id}`,
      createdAt: one.at,
      updatedAt: one.at,
      changedAt: one.at,
    })),
  )
  await db.messages.bulkPut(
    chats.flatMap((one) => {
      const rows = one.earlier ? [message(one.id, one.earlier, one.at)] : []
      if (!one.said) return rows
      const at = one.saidAt ?? one.at
      const waits =
        one.waits === "clarify"
          ? {
              clarify: {
                runId: "run-1",
                clarifyId: "ask-1",
                questions: [{ id: "q1", question: one.said }],
              },
            }
          : one.waits === "approval"
            ? { approval: { runId: "run-1", command: one.said, choices: [] } }
            : {}
      return [...rows, message(one.id, one.said, at, waits)]
    }),
  )
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith("/plugins/gots/info")) {
      infoReads += 1
      return json({ name: "gots", features: offers })
    }
    return json({})
  }) as typeof fetch
}

/** The chats the list draws, in the order it draws them. */
const rowIds = () =>
  findAll('ul a[href^="/c/"]').map((row) => (row.getAttribute("href") ?? "").slice(3))
/** One chat's row, by the chat it leads to. */
const rowOf = (id: string) => find(`ul a[href="/c/${id}"]`)
const dotted = (id: string) => Boolean(rowOf(id)?.querySelector("[data-unread]"))

const screen = (entry = `/b/${bot.id}`) => (
  <MemoryRouter initialEntries={[entry]}>
    <Path />
    <Routes>
      <Route path="b/:profileId" element={<BotChatsPage />} />
      <Route path="c/:id" element={<p data-chat />} />
      <Route path="new-room" element={<p data-new-room />} />
    </Routes>
  </MemoryRouter>
)

test("a bot's screen lists the chats it holds, its pinned one first and then by what was last said", async () => {
  await seed([
    { id: "quiet", title: "An old chat", at: 100 },
    { id: "busy", title: "The newest chat", at: 300 },
    { id: "pinned", title: "Held on top", at: 50, pinned: true },
    { id: "middle", title: "In between", at: 200 },
  ])
  await mount(screen(), async () => {
    await until(async () => rowIds().length === 4, "the bot's chats")
    assert.deepEqual(
      rowIds(),
      ["pinned", "busy", "middle", "quiet"],
      "one flat band: the pin first, then the newest, with no day heading or status group between",
    )
    absent("ul h2", "no heading stands inside the band")
  })
})

test("a row says what was last said, when, and nothing of the rows above it", async () => {
  const at = Date.now() - 60_000
  await seed([
    {
      id: "said",
      title: "Trip",
      at,
      earlier: "An older thing",
      said: "Booked the flights",
      saidAt: at,
    },
  ])
  await mount(screen(), async () => {
    await until(async () => Boolean(rowOf("said")), "the chat's row")
    const words = wordsOf(rowOf("said"))
    assert.ok(words.includes("Trip"), "the chat's title")
    assert.ok(words.includes("Booked the flights"), "the newest message as its line")
    assert.ok(!words.includes("An older thing"), "and not one above it")
    assert.ok(words.length > "Trip Booked the flights".length, "the row carries an age as well")
  })
})

test("a reply that waits on the reader marks its row, and keeps its line", async () => {
  await seed([
    { id: "asking", title: "Needs me", at: 200, said: "Shall I book it?", waits: "clarify" },
    { id: "approving", title: "Approval", at: 150, said: "Run the command", waits: "approval" },
    { id: "quiet", title: "Done", at: 100, said: "All finished" },
  ])
  await mount(screen(), async () => {
    await until(async () => rowIds().length === 3, "the bot's chats")
    assert.ok(rowOf("asking")?.querySelector("[data-waiting]"), "a question marks its row")
    assert.ok(rowOf("approving")?.querySelector("[data-waiting]"), "and so does an approval")
    assert.equal(
      rowOf("quiet")?.querySelector("[data-waiting]"),
      null,
      "a finished chat is not marked",
    )
    assert.ok(
      wordsOf(rowOf("asking")).includes("Shall I book it?"),
      "the mark stands beside the line rather than in its place",
    )
  })
})

test("the dot is this device's read mark, not the host's word", async () => {
  await seed([
    { id: "news", title: "News", at: 500, said: "Something new" },
    { id: "read", title: "Read", at: 500, said: "Something read" },
  ])
  markRead("read", 900)
  await mount(screen(), async () => {
    await until(async () => rowIds().length === 2, "the bot's chats")
    assert.equal(dotted("news"), false, "a chat this device never opened has no mark to be past")
    assert.equal(dotted("read"), false, "and one read after its last message shows no dot")
  })
  markRead("news", 100)
  await mount(screen(), async () => {
    await until(async () => rowIds().length === 2, "the bot's chats")
    assert.equal(dotted("news"), true, "a chat with something newer than the mark dots")
    assert.ok(
      wordsOf(rowOf("news")).includes("New activity"),
      "and says so to a reader who cannot see it",
    )
  })
})

test("the header's title is the bot's name, and it is the way to its settings", async () => {
  await seed([{ id: "a", title: "A chat", at: 100, said: "Hello" }])
  await mount(screen(), async () => {
    await until(
      async () => Boolean(find('a[href="/settings/bots/bot-1"]')),
      "the bot's settings link",
    )
    const title = find('a[href="/settings/bots/bot-1"]')
    assert.ok(title, "the title leads to Bot settings")
    assert.equal(wordsOf(title), "Mainly", "and it is the bot's own name")
    assert.equal(find("h1")?.textContent, "Mainly", "the heading the screen is known by")
    assert.equal(
      findAll("header button").length,
      2,
      "the drawer and the search: no '...' and no list control",
    )
  })
})

test("the search narrows the rows to the chats whose title or line it finds", async () => {
  await seed([
    { id: "trip", title: "Trip to Lisbon", at: 300, said: "Booked the flights" },
    { id: "dinner", title: "Dinner", at: 200, said: "We said eight" },
  ])
  await mount(screen(), async () => {
    await until(async () => rowIds().length === 2, "the bot's chats")
    const toggle = find("[data-search-toggle]")
    assert.equal(
      toggle?.getAttribute("aria-expanded"),
      "false",
      "the field is away until it is asked for",
    )
    await click(toggle)
    assert.equal(toggle?.getAttribute("aria-expanded"), "true", "and says so once it is out")
    assert.equal(toggle?.getAttribute("aria-controls"), "chats-search", "naming the field it opens")
    assert.ok(find("#chats-search"), "the field itself")
    await type(find("#chats-search"), "said eight")
    await until(async () => rowIds().length === 1, "the row the line keeps")
    assert.deepEqual(rowIds(), ["dinner"], "a line is searched as well as a title")
    await type(find("#chats-search"), "lisbon")
    await until(async () => rowIds().length === 1, "the row the title keeps")
    assert.deepEqual(rowIds(), ["trip"], "and a title narrows it too")
    await type(find("#chats-search"), "zebra")
    await until(async () => Boolean(findText("p", "No chats match.")), "the empty answer")
    assert.deepEqual(rowIds(), [], "nothing matches what is not there")
  })
})

test("the foot starts a chat of this bot's, and a room where the Host makes one", async () => {
  await seed([{ id: "a", title: "A chat", at: 100, said: "Hello" }])
  await mount(screen(), async () => {
    await until(async () => Boolean(control("New room")), "New room beside New chat")
    await click(control("New chat"))
    await until(async () => path() !== `/b/${bot.id}`, "the address of the chat it made")
    const made = (await db.conversations.toArray()).find((one) => one.id === path().slice(3))
    assert.ok(made, "the chat is the bot's, written before the address moved")
    assert.equal(made.profileId, bot.id, "a chat of this bot's")
    assert.ok(!made.main, "a plain chat: nothing makes a Main any more (G1)")
  })
  await mount(screen(), async () => {
    await until(async () => Boolean(control("New room")), "the foot")
    await click(control("New room"))
    await until(async () => path() === "/new-room", "the room screen")
  })
})

test("a Host that cannot make a room offers no control for one", async () => {
  // A Host of its own, so the answer about rooms is that Host's and no other case's remembered one.
  const plain = botProfile("bot-chats-no-rooms", {
    id: "bot-1",
    name: "Mainly",
    hermesProfile: "default",
  })
  await seed([{ id: "a", title: "A chat", at: 100, said: "Hello" }], { rooms: false, host: plain })
  await mount(screen(`/b/${plain.id}`), async () => {
    await until(async () => Boolean(control("New chat")), "the foot")
    // The answer about its plugin is what the control waits on, so the absence is read after it.
    await until(async () => infoReads > 0, "the Host's answer about its plugin")
    await settle()
    assert.ok(
      control("New room") === null,
      "no New room where the Host would only refuse it — the control never moved here to fail",
    )
  })
})

/** A control by the words it shows, as the foot's two buttons are read. */
function control(label: string) {
  return findAll("button, a").find((one) => wordsOf(one) === label) ?? null
}
