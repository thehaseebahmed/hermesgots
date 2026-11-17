/**
 * The flat layout's one screen is the list of a bot's chats: `/b/<bot>` draws them, flat — its pinned
 * ones first and the rest by what was last said — each a row with a chat's icon, its title, its last
 * line, its age and the dot this device's read mark decides, and a reply that waits on the reader
 * marked on its row. The header's title is the way to the bot's settings, the search floats at the
 * foot's left and narrows the rows to what it finds in a title or a line, and one button at the foot's
 * right starts a chat or a room. `scripts/test-chat-list.mjs` holds the rules (the order, the row's
 * shape, the search); this holds the screen they are drawn by.
 *
 * It is the layout the Developer switch turns on (ADR 0162), so every case here seeds the switch; the
 * last one holds the other half of it, where a bot's address is its **Main** and this list is nowhere.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { act } from "react"
import { MemoryRouter, Route, Routes, useNavigate, type InitialEntry } from "react-router"

import { AppRoutes, Home } from "@/App"
import { BotChatsPage, BotChatsPane } from "@/routes/bot-chats"
import { BOT_CHATS } from "@/lib/chat-list"
import {
  db,
  deleteConversation,
  getSettings,
  saveChatFilter,
  saveSettings,
  type Message,
} from "@/lib/db"
import { draftKey, flushDrafts, saveDraft } from "@/lib/drafts"
import { pressBack } from "@/lib/native"
import { markRead } from "@/lib/read-marks"
import {
  Nav,
  Path,
  absent,
  atDepth,
  atWidth,
  botProfile,
  click,
  find,
  findAll,
  findText,
  json,
  laptop,
  missing,
  mount,
  nav,
  path,
  seedSettings,
  settle,
  type,
  until,
  wordsOf,
} from "./component-kit.tsx"

const bot = botProfile("bot-chats", { id: "bot-1", name: "Mainly", hermesProfile: "default" })
const LABEL = "Mainly"
/** The bot's Main, for the one case that reads the app's other layout. */
const MAIN = "main-bot-1"

/**
 * A filter pill, by the word it wears. Named by its group rather than by `header [role="group"] button`,
 * because the bar's own search field is a group too once it holds words, with a clear button in it.
 */
const filterPill = (label: string) =>
  findAll('[role="group"][aria-label="Filter chats"] button').find(
    (one) => (one.textContent ?? "").trim() === label,
  ) ?? null

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
  /** The reader's own message, newest of all: a row still says what the bot said above it. */
  mine?: string
  /** The newest reply is still arriving, so the row has a run in flight to draw. */
  streaming?: boolean
  /** Archived by the reader: the row every pill but Archived leaves out. */
  archived?: boolean
  /** The run a routine's delivery is: the marker and the line the record itself carries. */
  routine?: { line: string }
  /** The room this row is: the Host's record, with this bot seated in it. */
  room?: boolean
  /** The bot's own Main thread, which is never hidden however little has been said in it. */
  main?: boolean
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
  // This is the flat layout's screen: the Developer switch is what draws it (ADR 0162).
  await seedSettings({ developer: true, legacyChat: true, activeProfileId: host.id })
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
      ...(one.archived ? { archived: true } : {}),
      hermesSessionId: `gots-${one.id}`,
      createdAt: one.at,
      updatedAt: one.at,
      changedAt: one.at,
      ...(one.routine ? { routine: true, line: one.routine.line } : {}),
      ...(one.main ? { main: true } : {}),
      ...(one.room
        ? {
            room: {
              id: `room-${one.id}`,
              members: [{ profile: "default", displayName: "Mainly" }],
            },
          }
        : {}),
    })),
  )
  await db.messages.bulkPut(
    chats.flatMap((one) => {
      const rows = one.earlier ? [message(one.id, one.earlier, one.at)] : []
      const said = !one.said
        ? rows
        : (() => {
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
            return [
              ...rows,
              message(one.id, one.said, at, {
                ...waits,
                ...(one.streaming ? { status: "streaming" } : {}),
              }),
            ]
          })()
      // The reader's own message is the newest row of all: a row that read it would say their words.
      return one.mine ? [...said, message(one.id, one.mine, one.at + 1000, { role: "user" })] : said
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
/** The picture a row wears where its title starts: its own icon, never the bot's face. */
const iconOf = (id: string) =>
  rowOf(id)?.querySelector(
    "svg.lucide-rotate-ccw-clock, svg.lucide-message-circle, svg.lucide-circle-alert",
  )
/** The disc a row's icon stands in, which is where a list picks its tone. */
const discOf = (id: string) => rowOf(id)?.querySelector('[data-slot="row-mark"] span.rounded-full')

const screen = (entry: InitialEntry = `/b/${bot.id}`) => (
  <MemoryRouter initialEntries={[entry]}>
    <Path />
    <Nav />
    <Routes>
      <Route path="b/:profileId" element={<BotChatsPage />} />
      <Route path="c/:id" element={<p data-chat />} />
      <Route path="new-room" element={<p data-new-room />} />
    </Routes>
  </MemoryRouter>
)

/**
 * The same addresses with one step back on the page: a chat stands above the list, and the step behind
 * it draws that list again — the move a reader makes when they open a chat and leave it without a word.
 */
const steppedScreen = () => (
  <MemoryRouter initialEntries={[`/b/${bot.id}`]}>
    <Path />
    <Nav />
    <StepBack />
    <Routes>
      <Route path="b/:profileId" element={<BotChatsPage />} />
      <Route path="c/:id" element={<p data-chat />} />
    </Routes>
  </MemoryRouter>
)

/** One step back through the entries a screen pushed, which is what "the list behind it" means. */
function StepBack() {
  const navigate = useNavigate()
  return (
    <button type="button" data-step-back onClick={() => navigate(-1)}>
      back
    </button>
  )
}

test("with the switch off a bot's address lands on its Main, and this list is nowhere", async () => {
  // The app's own route table: the switch is off, the bot's Main is a record this device holds, and
  // the address is a doorway onto it (ADR 0161) rather than onto this list.
  await seed([{ id: MAIN, title: "Main", at: 10, main: true }])
  await seedSettings({ developer: true, activeProfileId: bot.id })
  await mount(
    <MemoryRouter initialEntries={[`/b/${bot.id}`]}>
      <Path />
      <Nav />
      <AppRoutes />
    </MemoryRouter>,
    async () => {
      await until(async () => path() === `/c/${MAIN}`, "the bot's Main")
      await until(async () => Boolean(findText('[data-slot="header-title"]', "Main")), "Main's bar")
      assert.equal(
        findAll('[role="group"][aria-label="Filter chats"] button').length,
        0,
        "and no list of the bot's chats was drawn in its place",
      )
    },
  )
})

test("Home is the active bot's screen: `/` sends the reader to its list", async () => {
  // A bot with nothing to open, so the address `/` lands on is the list itself: the door, seen without
  // another screen answering for it.
  await seed([])
  await mount(
    <MemoryRouter initialEntries={["/"]}>
      <Path />
      <Nav />
      <Routes>
        <Route index element={<Home />} />
        <Route path="b/:profileId" element={<BotChatsPage />} />
      </Routes>
    </MemoryRouter>,
    async () => {
      await until(async () => path() === `/b/${bot.id}`, "the active bot's address")
      await until(async () => Boolean(findText('[data-slot="header-title"]', LABEL)), "its list")
      assert.equal(rowIds().length, 0, "the list a bot with no chats draws")
      assert.equal(
        nav(),
        `REPLACE:/b/${bot.id}`,
        "and `/` is replaced by it rather than left behind the reader",
      )
    },
  )
})

test("a bot's screen lists the chats it holds, its pinned one first and then by what was last said", async () => {
  // Every one of them has been said in: a chat nothing was said in is no row of the list at all
  // (ADR 0158), which is the case after this one.
  await seed([
    { id: "quiet", title: "An old chat", at: 100, said: "The first word" },
    { id: "busy", title: "The newest chat", at: 300, said: "The last word" },
    { id: "pinned", title: "Held on top", at: 50, pinned: true, said: "Held here" },
    { id: "middle", title: "In between", at: 200, said: "In the middle" },
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

test("a row says what the bot last said, and the reader's own words only while it has not answered", async () => {
  const at = Date.now() - 60_000
  await seed([
    {
      id: "asked",
      title: "Trip",
      at,
      said: "Booked the flights",
      saidAt: at - 5_000,
      mine: "and the hotel?",
    },
  ])
  await mount(screen(), async () => {
    await until(async () => Boolean(rowOf("asked")), "the chat's row")
    const words = wordsOf(rowOf("asked"))
    assert.ok(words.includes("Booked the flights"), "the row says the last thing received")
    assert.ok(!words.includes("and the hotel?"), "not the reader's message under it")
  })
  // A chat the bot has never answered has only the reader's words to say.
  await seed([{ id: "only", title: "New chat", at, mine: "are you there?" }])
  await mount(screen(), async () => {
    await until(async () => Boolean(rowOf("only")), "the chat's row")
    assert.ok(
      wordsOf(rowOf("only")).includes("are you there?"),
      "and says them while nothing came back",
    )
  })
})

test("a chat's icon is grey at rest, a spinner while a run is in flight, and yellow only on a wait", async () => {
  await seed([
    { id: "rest", title: "At rest", at: 300, said: "All done." },
    { id: "busy", title: "Working", at: 200, said: "Writing the answer…", streaming: true },
    { id: "waiting", title: "Waiting", at: 100, said: "Shall I go on?", waits: "clarify" },
  ])
  await mount(screen(), async () => {
    await until(async () => rowIds().length === 3, "the bot's chats")
    // Grey is the app's colour for nothing to say: a bullet has no business being green here.
    assert.ok(
      rowOf("rest")?.querySelector("svg.lucide-message-circle"),
      "a chat at rest wears its own icon",
    )
    assert.ok(discOf("rest")?.className.includes("bg-muted"), "on the muted disc")
    assert.ok(!discOf("rest")?.className.includes("bg-primary"), "and never the green one")
    // A run in flight is the one row that shows it is working.
    assert.ok(
      rowOf("busy")?.querySelector('[data-slot="spinner"]'),
      "a reply still arriving draws the spinner",
    )
    assert.ok(discOf("busy")?.className.includes("bg-muted"), "in the same grey as a row at rest")
    // Yellow is spent on what wants the reader, and on nothing else.
    assert.ok(
      rowOf("waiting")?.querySelector("svg.lucide-circle-alert"),
      "the wait takes the alert icon",
    )
    assert.ok(discOf("waiting")?.className.includes("bg-warning/15"), "on the warning disc")
  })
})

test("a waiting row is drawn the way Code draws a waiting session", async () => {
  await seed([
    { id: "asking", title: "Needs me", at: 200, said: "Shall I book it?", waits: "clarify" },
    { id: "approving", title: "Approval", at: 150, said: "Run the command", waits: "approval" },
    { id: "quiet", title: "Done", at: 100, said: "All finished" },
  ])
  await mount(screen(), async () => {
    await until(async () => rowIds().length === 3, "the bot's chats")
    // The alert icon and the warning tone are Code's own two marks of a session that waits.
    assert.ok(
      rowOf("asking")?.querySelector("svg.lucide-circle-alert"),
      "a question wears the alert icon",
    )
    assert.ok(
      rowOf("approving")?.querySelector("svg.lucide-circle-alert"),
      "and so does an approval",
    )
    assert.ok(discOf("asking")?.className.includes("text-warning"), "in the warning tone")
    assert.equal(
      rowOf("asking")?.querySelector("[data-waiting]"),
      null,
      "and no badge beside the title says it twice",
    )
    assert.ok(
      wordsOf(rowOf("asking")).includes("Awaiting your answer"),
      "the reason stands where the line stands, in Code's words",
    )
    assert.ok(
      wordsOf(rowOf("approving")).includes("Approve Run the command"),
      "and an approval names the command it wants to run",
    )
    assert.ok(
      rowOf("quiet")?.querySelector("svg.lucide-message-circle"),
      "a chat at rest keeps the chat icon",
    )
    assert.ok(!discOf("quiet")?.className.includes("text-warning"), "and no warning tone")
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

test("a routine's delivery is no row of the list: it is the marker its bot's Main draws", async () => {
  const at = Date.now() - 120_000
  await seed([
    {
      id: "routine-job-1-cron_9",
      title: "Morning watch",
      at,
      routine: { line: "The tide turns at 06:40, and the wind is from the west." },
    },
    { id: "chat", title: "A chat", at: at + 1_000, said: "Nothing else came in" },
  ])
  await mount(screen(), async () => {
    await until(async () => rowIds().length === 1, "the bot's chats")
    assert.deepEqual(rowIds(), ["chat"], "the run's record draws no row")
  })
})

test("the list answers the press with the step behind it, and leaves the app its own", async () => {
  await seed([{ id: "quiet", title: "An old chat", at: 100, said: "Something said" }])
  const stepped = atDepth(1)
  try {
    await mount(screen(), async () => {
      await until(async () => rowIds().length === 1, "the bot's chats")
      assert.equal(pressBack(), "screen", "a list something opened answers the press")
      assert.deepEqual(stepped.backs, [1], "with the one step back to whatever opened it")
    })
  } finally {
    stepped.restore()
  }
  const entry = atDepth(0)
  try {
    await mount(screen(), async () => {
      await until(async () => rowIds().length === 1, "the bot's chats")
      assert.equal(pressBack(), "app", "and at the app's first entry the press is the app's")
      assert.deepEqual(entry.backs, [], "with nothing behind it to step to")
    })
  } finally {
    entry.restore()
  }
})

test("the list holds every chat the bot has, so a pin and a chat past the bound are both reachable", async () => {
  // One more chat than a list reads a tail for. The bound is on the reads a row costs — its newest
  // message — and never on which of the bot's chats the list holds: a chat older than the bound is
  // still a row, and the pin on the oldest of them puts it where its pin says.
  const many: Seed[] = [
    { id: "pinned-old", title: "Held on top", at: 1, pinned: true, said: "Still here" },
    ...Array.from({ length: BOT_CHATS + 1 }, (_, index) => ({
      id: `chat-${index}`,
      title: `Chat ${index}`,
      at: 1_000 + index * 10,
      said: `Said ${index}`,
    })),
  ]
  await seed(many)
  await mount(screen(), async () => {
    await until(async () => rowIds().length === many.length, "every chat the bot has")
    assert.equal(
      rowIds()[0],
      "pinned-old",
      "the pin lifts it above every chat newer than the bound",
    )
    assert.ok(
      wordsOf(rowOf("pinned-old")).includes("Still here"),
      "and a pinned chat keeps the line its own tail gives it",
    )
    assert.ok(rowIds().includes("chat-0"), "the oldest chat past the bound is a row of the list")
    await click(rowOf("chat-0"))
    await until(async () => path() === "/c/chat-0", "the chat a row past the bound opens")
  })
})

test("a record deleted here is not resurrected by one written ahead of this device's clock", async () => {
  // A delivery's record is stamped by the host's clock, which can run ahead of this device's. The
  // merge keeps only the strictly newer record, so a tombstone stamped from the device's own clock
  // would lose to the row it kills and the row would come back on the next merge.
  const ahead = Date.now() + 60 * 60_000
  await seed([
    {
      id: "routine-job-1-cron_9",
      title: "Morning watch",
      at: ahead,
      routine: { line: "The tide turns at 06:40." },
    },
  ])
  await deleteConversation("routine-job-1-cron_9")
  const tombstone = await db.tombstones.get("chat:routine-job-1-cron_9")
  assert.ok(tombstone, "its deletion is named for the other devices")
  assert.ok(
    tombstone!.deletedAt > ahead,
    "and stamped past the record it kills, which is the only clock the merge compares",
  )
})

test("the header's title is the bot's own name, and it is the way to its settings", async () => {
  await seed([{ id: "a", title: "A chat", at: 100, said: "Hello" }])
  await mount(screen(), async () => {
    await until(
      async () => Boolean(find('a[href="/settings/bots/bot-1"]')),
      "the bot's settings link",
    )
    const title = find('a[href="/settings/bots/bot-1"]')
    assert.ok(title, "the title leads to Bot settings")
    assert.equal(wordsOf(title), LABEL, "and it is the name the bot has")
    assert.equal(find("h1")?.textContent, LABEL, "the heading the screen is known by")
    assert.equal(
      findAll('[data-slot="header-row"] button').length,
      1,
      "the drawer alone in the bar's row: no '...' and no list control, and the search has left for the foot",
    )
    absent("header [data-search-toggle]", "nothing of the search is in the header")
    assert.equal(
      findAll('header a[aria-label="Routines"]').length,
      1,
      "and the routine control stands apart from the drawer and the search",
    )
    const routines = find('header a[aria-label="Routines"]')
    assert.equal(
      routines?.getAttribute("role"),
      null,
      "a link to a screen announced as the link it is, not as a button",
    )
    assert.ok((routines?.className ?? "").includes("size-11"), "and still a full touch target")
    // The list's bar is the app's bar in its pinned form (ADR 0140) — the same row, slots and controls
    // the chat's header draws, so a change to one row is a change to both screens.
    const header = find("header")
    assert.ok(header?.className.includes("sticky"), "pinned in the list's scroll, not floating")
    assert.ok(header?.querySelector('[data-slot="header-row"]'), "the bar's own row")
    assert.ok(header?.querySelector('[data-slot="header-middle"]'), "the title's slot in it")
    assert.ok(
      (routines?.className ?? "").includes("bg-background/80"),
      "and the routine control a frosted outline circle, like the chat's back and its options",
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
      toggle?.closest("header"),
      null,
      "the search is at the foot of the list, not in its header",
    )
    assert.ok(
      find('[data-slot="list-foot"]')?.contains(toggle ?? null),
      "on the bar the list's floating controls stand on",
    )
    assert.ok(
      ((find("ul")?.compareDocumentPosition(toggle ?? null) ?? 0) &
        Node.DOCUMENT_POSITION_FOLLOWING) !==
        0,
      "with the rows above it",
    )
    assert.ok(!find("#chats-search"), "the field is away until it is asked for")
    await click(toggle)
    await until(async () => Boolean(find("#chats-search")), "the field it opens")
    assert.ok(
      find('[data-slot="list-foot"]')?.contains(find("#chats-search") ?? null),
      "the circle becomes the field in the foot's own row, so nothing above the foot moves",
    )
    assert.ok(
      !find("[data-search-toggle]"),
      "the circle is gone: the field is what it became, not a second control beside it",
    )
    const close = find("[data-search-close]")
    assert.ok(close, "and the button beside it is the way out")
    assert.equal(close?.getAttribute("aria-label"), "Close search", "named for what it closes")
    assert.ok(
      (close?.className ?? "").includes("bg-muted"),
      "muted, so the screen's one accent is not spent on a way out",
    )
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

test("emptying the search leaves the field where it is, and only Escape or the X close it", async () => {
  // A field that closes itself the moment it is empty takes the focus and the keyboard with it, so
  // backspacing the last character — or the field's own clear control — throws the reader out of a
  // search they were still in.
  await seed([
    { id: "trip", title: "Trip to Lisbon", at: 300, said: "Booked the flights" },
    { id: "dinner", title: "Dinner", at: 200, said: "We said eight" },
  ])
  await mount(screen(), async () => {
    // The field itself, read once per look: a found element handed to `assert`'s equality is one the
    // reporter inspects, which the tier's own guard refuses.
    const field = () => find("#chats-search") as HTMLInputElement | null
    await until(async () => rowIds().length === 2, "the bot's chats")
    await click(find("[data-search-toggle]"))
    await type(field(), "lisbon")
    await until(async () => rowIds().length === 1, "the row the search keeps")
    await type(field(), "")
    assert.ok(field(), "backspacing the last character leaves the field open")
    await until(async () => rowIds().length === 2, "and the list it narrowed")

    await type(field(), "dinner")
    await until(async () => rowIds().length === 1, "the row it narrows to again")
    await click(find('[aria-label="Clear search"]'))
    const cleared = field()
    assert.ok(cleared, "the clear control empties the field rather than closing it")
    assert.equal(cleared?.value, "", "and the field is empty")
    await until(async () => rowIds().length === 2, "with the whole list back")

    await press(field(), "Escape")
    absent("#chats-search", "Escape is one of the two ways it closes")

    await click(find("[data-search-toggle]"))
    await until(async () => Boolean(field()), "the circle opens it again")
    await click(find("[data-search-close]"))
    await until(async () => !field(), "and the muted X beside it is the other way it closes")
    assert.ok(find("[data-search-toggle]"), "the circle is back, where the reader left it")
  })
})

/** A key pressed in the field, as the field's own handler reads it. */
async function press(field: Element | null, key: string) {
  assert.ok(field, "the field is on screen")
  await act(async () => {
    field.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }))
  })
  await settle()
}

test("the foot's New rises two picks above it, and the button turns to a Close", async () => {
  await seed([{ id: "a", title: "A chat", at: 100, said: "Hello" }])
  await mount(screen(), async () => {
    const fab = find("[data-new-menu]")
    assert.ok(fab, "the control is at the foot, where the thumb is")
    assert.equal(fab?.closest("header"), null, "and not in the header")
    assert.equal(fab?.getAttribute("aria-label"), "New", "named for what it starts")
    assert.ok(
      (fab?.className ?? "").includes("rounded-full"),
      "round, and a full touch target: it is the screen's one accent",
    )
    // The picks stand above the button, so they are built in the foot's own bar and inert until asked
    // for: a closed cluster is not a control a tap can reach (ADR 0141).
    assert.equal(picksOpen(), false, "nothing is up until it is asked for")
    assert.equal(
      find("[data-picks]")?.hasAttribute("inert"),
      true,
      "and inert while closed: a cluster kept in the tree is not one a tab or a tap can reach",
    )
    assert.equal(fab?.getAttribute("aria-expanded"), "false", "and the button says so")
    await click(fab)
    await until(async () => picksOpen(), "the picks it raises")
    assert.ok(newRow("New chat"), "New chat is one of them")
    assert.ok(newRow("New room"), "and New room the other, where the Host makes one")
    assert.ok(
      find('[data-slot="list-foot"]')?.contains(newRow("New chat") ?? null),
      "both on the foot's own bar, not in a pop-up over the list",
    )
    assert.ok(!find("[data-popup-form]"), "the app's pop-up is gone from this screen")
    assert.equal(fab?.getAttribute("aria-label"), "Close", "the button now says how to shut them")
    assert.equal(fab?.getAttribute("aria-expanded"), "true", "and that they are up")
    await settle()
    assert.equal(
      findAll("[data-new-menu]").length,
      1,
      "one button, not a foot of three: the actions are the picks above it",
    )
    await click(fab)
    await until(async () => !picksOpen(), "the button that raised them also shuts them")
    assert.equal(fab?.getAttribute("aria-label"), "New", "and it is the plus again")
  })
})

test("the picks' New chat makes a chat of this bot's, and their New room opens the room screen", async () => {
  await seed([{ id: "a", title: "A chat", at: 100, said: "Hello" }])
  await mount(screen(), async () => {
    await until(async () => Boolean(find("[data-new-menu]")), "the button")
    await click(find("[data-new-menu]"))
    await until(async () => picksOpen(), "the picks")
    await click(newRow("New chat"))
    await until(async () => path() !== `/b/${bot.id}`, "the address of the chat it made")
    const made = (await db.conversations.toArray()).find((one) => one.id === path().slice(3))
    assert.ok(made, "the chat is the bot's, written before the address moved")
    assert.equal(made.profileId, bot.id, "a chat of this bot's")
    assert.ok(!made.main, "a plain chat: nothing makes a Main any more")
  })
  await mount(screen(), async () => {
    await until(async () => Boolean(find("[data-new-menu]")), "the button")
    await click(find("[data-new-menu]"))
    await until(async () => picksOpen(), "the picks")
    await click(newRow("New room"))
    await until(async () => path() === "/new-room", "the room screen")
  })
})

test("a pick in a bot's list opens its chat above the list", async () => {
  // The list the pick leaves behind is the session history's, which a screen drawn without one cannot
  // walk: `scripts/test-bot-open` walks the step back onto that list, and this holds the move the row
  // makes — the chat pushed over the list, so that history has the list to return to.
  await seed([
    { id: "a", title: "A chat", at: 100, said: "Hello" },
    { id: "b", title: "Another", at: 200, said: "Hi" },
  ])
  await mount(screen(), async () => {
    await until(async () => rowIds().length === 2, "the bot's chats")
    await click(rowOf("b"))
    await until(async () => path() === "/c/b", "the chat it picked")
    assert.equal(nav(), "PUSH:/c/b", "the chat stands above the list rather than in its place")
  })
  await mount(screen(), async () => {
    await until(async () => rowIds().length === 2, "the bot's chats")
    await click(find("[data-new-menu]"))
    await until(async () => picksOpen(), "the picks")
    await click(newRow("New chat"))
    await until(async () => path() !== `/b/${bot.id}`, "the chat it made")
    assert.ok(nav().startsWith("PUSH:/c/"), "and the foot's New chat takes the same move")
  })
})

test("a chat opened and left behind is no row of the list it steps back to, and one holding a draft is", async () => {
  // The New chat press mints a record whose two clocks are level, and nothing is said in it: the list
  // the reader steps back to draws no row for it (ADR 0158). Main is never hidden, empty or not, and a
  // chat holding words typed and not sent is a row until the words go.
  await seed([
    { id: "main", title: "Main", at: 100, main: true },
    { id: "said", title: "A chat", at: 300, said: "Hello" },
  ])
  await mount(steppedScreen(), async () => {
    await until(async () => rowIds().length === 2, "the bot's chats")
    assert.deepEqual(rowIds(), ["said", "main"], "Main is a row though nothing has been said in it")

    await click(find("[data-new-menu]"))
    await until(async () => picksOpen(), "the picks")
    await click(newRow("New chat"))
    await until(async () => path() !== `/b/${bot.id}`, "the chat it made")
    const made = path().slice(3)
    await click(find("[data-step-back]"))
    await until(async () => path() === `/b/${bot.id}`, "the list it steps back to")
    await until(async () => rowIds().length === 2, "the list as the reader left it")
    assert.deepEqual(rowIds(), ["said", "main"], "a chat left without a word is no row of it")

    // Three words typed in it and not sent make it one, and the list is woken by the draft landing: the
    // read that draws the list is over `db.drafts`, so no screen has to be opened again for the row.
    saveDraft(draftKey(made), "three words")
    await flushDrafts()
    await until(async () => rowIds().includes(made), "the row its draft brings back")
  })
})

test("a list a chat opens marks no row, where a list beside a chat marks the one it draws", async () => {
  await seed([
    { id: "a", title: "A chat", at: 100, said: "Hello" },
    { id: "b", title: "Another", at: 200, said: "Hi" },
  ])
  // A list drawn with nothing beside it marks no row: the mark says "this is the one drawn here", and
  // none is.
  await mount(screen({ pathname: `/b/${bot.id}`, state: { open: "a" } }), async () => {
    await until(async () => rowIds().length === 2, "the bot's chats")
    assert.equal(
      findAll("ul a[aria-current]").length,
      0,
      "no row of the list a chat opened is marked as the one open",
    )
  })
})

test("a Host that cannot make a room offers no row for one", async () => {
  // A Host of its own, so the answer about rooms is that Host's and no other case's remembered one.
  const plain = botProfile("bot-chats-no-rooms", {
    id: "bot-1",
    name: "Mainly",
    hermesProfile: "default",
  })
  await seed([{ id: "a", title: "A chat", at: 100, said: "Hello" }], { rooms: false, host: plain })
  await mount(screen(`/b/${plain.id}`), async () => {
    await until(async () => Boolean(find("[data-new-menu]")), "the button")
    // The answer about its plugin is what the menu waits on, so the absence is read after it.
    await until(async () => infoReads > 0, "the Host's answer about its plugin")
    await settle()
    await click(find("[data-new-menu]"))
    await until(async () => picksOpen(), "the picks")
    assert.ok(newRow("New chat"), "one pick is still a pick")
    assert.ok(
      missing('button[aria-label="New room"]'),
      "no New room where the Host would only refuse it — the control never moved here to fail",
    )
  })
})

test("the foot holds one surface at a time: the search takes the picks' place, and closing it clears the query", async () => {
  await seed([
    { id: "trip", title: "Trip to Lisbon", at: 300, said: "Booked the flights" },
    { id: "dinner", title: "Dinner", at: 200, said: "We said eight" },
  ])
  await mount(screen(), async () => {
    await until(async () => rowIds().length === 2, "the bot's chats")

    // A reader on a keyboard reaches the search circle while the picks are up; the foot cannot then
    // show both a field and a cluster over one button that says two different things.
    await click(find("[data-new-menu]"))
    await until(async () => picksOpen(), "the picks")
    await click(find("[data-search-toggle]"))
    await until(async () => Boolean(find("#chats-search")), "the field")
    assert.equal(picksOpen(), false, "and the picks are put away for it")
    assert.equal(
      find("[data-new-menu]")?.getAttribute("aria-label"),
      "Close search",
      "so the button says what it actually closes",
    )

    // The query goes with the field: a reopened search starts empty and the list it narrowed is whole
    // again, rather than a list filtered by words the reader can no longer see.
    await type(find("#chats-search"), "lisbon")
    await until(async () => rowIds().length === 1, "the row it keeps")
    await click(find("[data-search-close]"))
    await until(async () => !find("#chats-search"), "the field put away")
    await click(find("[data-search-toggle]"))
    await until(async () => Boolean(find("#chats-search")), "the field again")
    assert.equal(
      (find("#chats-search") as HTMLInputElement).value,
      "",
      "empty, because the closed field took its query with it",
    )
    assert.equal(rowIds().length, 2, "and the list it narrowed is whole again")
  })
})

/** A pick the foot offers, by the name it carries exactly — the button itself is `New`. */
function newRow(label: string) {
  return find(`button[aria-label="${label}"]`)
}

/**
 * Whether the picks stand above the button. They are built with the foot and kept inert while closed,
 * so what says they are up is the group's own state, not their presence in the tree — and a group
 * that says it is up while still inert is a group a tap cannot reach.
 */
function picksOpen() {
  const picks = find("[data-picks]")
  return picks?.getAttribute("aria-hidden") === "false" && !picks.hasAttribute("inert")
}

test("the pills narrow the rows to the kind each names, and say what their emptiness is", async () => {
  // One room, one unread chat, one read chat: the three kinds the pills name, and the dot's own answer
  // for Unread — a row this device never opened has no mark to be newer than.
  await seed([
    { id: "trip", title: "Trip to Lisbon", at: 300, said: "Booked the flights" },
    { id: "dinner", title: "Dinner", at: 200, said: "We said eight" },
    { id: "planning", title: "Planning", at: 150, said: "All aboard", room: true },
  ])
  markRead("trip", 100)
  markRead("dinner", 250)
  await mount(screen(), async () => {
    await until(async () => rowIds().length === 3, "the list")
    const pills = () => findAll('[role="group"][aria-label="Filter chats"] button')
    assert.deepEqual(
      pills().map((one) => (one.textContent ?? "").trim()),
      ["All", "Unread", "Archived", "Chats", "Rooms"],
      "the five pills, in the rule's own order, Archived straight after Unread",
    )
    assert.equal(
      filterPill("All")?.getAttribute("aria-pressed"),
      "true",
      "All is what the list opens on",
    )

    await click(filterPill("Unread"))
    assert.deepEqual(rowIds(), ["trip"], "Unread keeps the rows that wear this device's dot")
    await click(filterPill("Chats"))
    assert.deepEqual(
      rowIds(),
      ["trip", "dinner"],
      "Chats is a row that is not a room",
    )
    await click(filterPill("Rooms"))
    assert.deepEqual(rowIds(), ["planning"], "Rooms is the room's own row")
    await click(filterPill("Archived"))
    assert.deepEqual(rowIds(), [], "nothing here has been put away")
    assert.ok(
      findText("p", "No archived chats."),
      "so the pill says what its emptiness is, in its own words",
    )

    // A search inside a pill that holds rows is the search's emptiness, not the pill's.
    await click(filterPill("Rooms"))
    await click(find("[data-search-toggle]"))
    await until(async () => Boolean(find("#chats-search")), "the foot's field")
    await type(find("#chats-search"), "lisbon")
    assert.deepEqual(rowIds(), [], "the pill keeps the room, and the words find nothing in it")
    assert.ok(findText("p", "No chats match."), "which is the search's sentence")
  })
})

test("an archived chat is out of every pill but Archived, and All's search never finds it", async () => {
  const at = Date.now() - 90_000
  await seed([
    { id: "live", title: "Trip to Lisbon", at, said: "Booked the flights" },
    {
      id: "packed",
      title: "Packing list",
      at: at - 60_000,
      said: "Two pairs of shoes",
      archived: true,
    },
  ])
  await mount(screen(), async () => {
    // The list opens on All, and the archived chat is no row of it.
    await until(async () => rowIds().length === 1, "the list, less what the reader set aside")
    assert.deepEqual(rowIds(), ["live"], "All keeps no archived row")
    await click(filterPill("Unread"))
    assert.deepEqual(rowIds(), [], "nor does Unread")
    await click(filterPill("Chats"))
    assert.deepEqual(rowIds(), ["live"], "nor Chats")
    await click(filterPill("Archived"))
    await until(async () => rowIds().length === 1, "the row the pill keeps")
    assert.deepEqual(rowIds(), ["packed"], "Archived is the one pill that draws it")
    const words = wordsOf(rowOf("packed"))
    assert.ok(words.includes("Packing list"), "with the chat's title")
    assert.ok(words.includes("Two pairs of shoes"), "what was last said in it, read from its tail")
    assert.ok(words.length > "Packing list Two pairs of shoes".length, "and its age")

    // The search narrows the pill it stands in, so a search over All cannot reach the archived row —
    // while the pill that holds it still searches its own.
    await click(filterPill("All"))
    await click(find("[data-search-toggle]"))
    await until(async () => Boolean(find("#chats-search")), "the foot's field")
    await type(find("#chats-search"), "packing")
    assert.deepEqual(rowIds(), [], "the words name a chat All does not hold")
    assert.ok(findText("p", "No chats match."), "which is the search's emptiness, not a pill's")
    await click(filterPill("Archived"))
    await until(async () => rowIds().length === 1, "the row its own search finds")
    assert.deepEqual(rowIds(), ["packed"], "and the Archived pill finds it under the same words")
  })
})

test("a chat nothing was said in, archived, is still the Archived pill's row", async () => {
  // Archiving is an act the reader took, and the pill is the only way back to the row it kept: a chat
  // the New chat press minted and the reader put away before saying anything is exactly the state the
  // sheet writes, and nothing else would draw it.
  await seed([{ id: "put-away", title: "Set aside", at: 100, archived: true }])
  await mount(screen(), async () => {
    await until(async () => Boolean(findText("p", "No chats yet.")), "All's own sentence")
    assert.deepEqual(rowIds(), [], "out of All, which is the rows nobody archived")
    await click(filterPill("Archived"))
    await until(async () => rowIds().length === 1, "the row the reader put away")
    assert.deepEqual(rowIds(), ["put-away"], "drawn by the one pill that holds it")
  })
})

test("a bot whose every chat is archived says All's own emptiness", async () => {
  // A pill that keeps nothing says its own sentence; Archived is the pill that holds these, and All
  // says what it says of any bot with nothing to draw rather than a second emptiness of its own.
  await seed([{ id: "only", title: "Put away", at: 100, said: "Nothing to show", archived: true }])
  await mount(screen(), async () => {
    await until(async () => Boolean(findText("p", "No chats yet.")), "All's own sentence")
    assert.deepEqual(rowIds(), [], "with no row under it")
    await click(filterPill("Archived"))
    await until(async () => rowIds().length === 1, "the row Archived keeps")
  })
})

test("an archived chat past the bound still says what was last said in it", async () => {
  // The pill draws the archived row's line and its age, so its tail is read wherever its clock puts
  // it: the bound is on what a list costs to draw, and this row is on it. The read starts when the
  // pill is pressed — no other pill draws these rows — so the line lands with the pill's answer.
  const many: Seed[] = [
    {
      id: "archived-old",
      title: "Set aside",
      at: 1,
      said: "The last word in it",
      archived: true,
    },
    ...Array.from({ length: BOT_CHATS + 1 }, (_, index) => ({
      id: `chat-${index}`,
      title: `Chat ${index}`,
      at: 1_000 + index * 10,
      said: `Said ${index}`,
    })),
  ]
  await seed(many)
  await mount(screen(), async () => {
    await until(async () => rowIds().length === BOT_CHATS + 1, "every chat nobody archived")
    assert.ok(!rowIds().includes("archived-old"), "the archived chat is out of All")
    await click(filterPill("Archived"))
    await until(
      async () => wordsOf(rowOf("archived-old")).includes("The last word in it"),
      "its line, read though its clock put it past the bound",
    )
  })
})

/**
 * The list as the shell draws it at the laptop width, where the screen is the pane's list: the page
 * itself answers "No chat open" there, and the list beside the chat is the same component.
 */
const listPane = () => (
  <MemoryRouter initialEntries={[`/b/${bot.id}`]}>
    <Nav />
    <BotChatsPane pane={{ profileId: bot.id, open: true }} />
  </MemoryRouter>
)

test(
  "from the laptop width the search stands in the bar, above the pills, and the foot has no circle",
  laptop(async () => {
    await seed([
      { id: "a", title: "A chat", at: 100, said: "Hello there" },
      { id: "b", title: "Another", at: 90, said: "Other words" },
    ])
    await mount(listPane(), async () => {
      await until(async () => rowIds().length === 2, "the list")
      assert.equal(missing("[data-search-toggle]"), true, "the foot's circle is gone")
      const field = find("header #chats-search")
      const pills = find('header [role="group"][aria-label="Filter chats"]')
      const rows = find("ul")
      assert.ok(field && pills && rows, "the field, the pills and the rows are all on screen")
      assert.ok(
        field!.compareDocumentPosition(pills!) & Node.DOCUMENT_POSITION_FOLLOWING,
        "the field stands above the pills",
      )
      assert.ok(
        pills!.compareDocumentPosition(rows!) & Node.DOCUMENT_POSITION_FOLLOWING,
        "and the pills above the rows",
      )
      assert.equal(findAll("#chats-search").length, 1, "one field, never two")
      await type(field, "another")
      assert.deepEqual(rowIds(), ["b"], "and it narrows the rows where it stands")
    })
  }),
)

test(
  "below the laptop width the search is still the foot's, and the bar holds no field",
  atWidth(1024, async () => {
    await seed([{ id: "a", title: "A chat", at: 100, said: "Hello there" }])
    await mount(screen(), async () => {
      await until(async () => rowIds().length === 1, "the list")
      assert.equal(missing("[data-search-toggle]"), false, "the circle is in the foot")
      assert.equal(missing("header #chats-search"), true, "and the bar holds no field")
    })
  }),
)

test("the filter a device kept is the one its list opens on", async () => {
  await seed([
    { id: "trip", title: "Trip to Lisbon", at: 300, said: "Booked the flights" },
    { id: "planning", title: "Planning", at: 150, said: "All aboard", room: true },
  ])
  // A device that has never chosen: the ground the first visit stands on. The switch stays on, since
  // this is the flat layout's list.
  await seedSettings({ developer: true, legacyChat: true, activeProfileId: bot.id })
  await mount(screen(), async () => {
    await until(async () => rowIds().length === 2, "the list")
    assert.equal(
      filterPill("All")?.getAttribute("aria-pressed"),
      "true",
      "a device that never chose opens on All",
    )
    await click(filterPill("Rooms"))
    assert.deepEqual(rowIds(), ["planning"], "the press narrows the rows")
    assert.equal(
      (await getSettings()).chatFilters?.[bot.id],
      "rooms",
      "and is what this device keeps for this bot",
    )
  })
  // The next visit is the pill it left, not the ground.
  await mount(screen(), async () => {
    await until(async () => rowIds().length === 1, "the list opened on the pill this device kept")
    assert.deepEqual(rowIds(), ["planning"], "the rows it keeps")
    assert.equal(filterPill("Rooms")?.getAttribute("aria-pressed"), "true", "with Rooms pressed")
    assert.equal(
      (await getSettings()).chatFilters?.[bot.id],
      "rooms",
      "and a fresh read answers the pill this device set",
    )
  })
})

test("a pill pressed on one bot leaves every other bot's list on its own", async () => {
  const other = botProfile("bot-chats-other", {
    id: "bot-2",
    name: "Otherly",
    hermesProfile: "other",
  })
  await seed([
    { id: "trip", title: "Trip to Lisbon", at: 300, said: "Booked the flights" },
    { id: "planning", title: "Planning", at: 150, said: "All aboard", room: true },
  ])
  // A second bot, with a chat and a room of its own, that has never chosen a pill of its own: a
  // device-wide key could not tell it from the first.
  await db.profiles.put(other)
  await db.conversations.bulkPut([
    {
      id: "other-chat",
      profileId: other.id,
      title: "Other chat",
      // Said in, so it is a row of that bot's list: a chat nothing was said in is no row (ADR 0158).
      createdAt: 200,
      updatedAt: 210,
      changedAt: 200,
    },
    {
      id: "other-room",
      profileId: other.id,
      title: "Other room",
      createdAt: 120,
      updatedAt: 120,
      changedAt: 120,
      room: { id: "room-other", members: [{ profile: "other", displayName: "Otherly" }] },
    },
  ])
  await mount(screen(), async () => {
    await until(async () => rowIds().length === 2, "the first bot's list")
    await click(filterPill("Rooms"))
    assert.deepEqual(rowIds(), ["planning"], "the press narrows the bot it was made in")
  })
  await mount(screen(`/b/${other.id}`), async () => {
    await until(async () => rowIds().length > 0, "the second bot's rows")
    assert.equal(
      filterPill("All")?.getAttribute("aria-pressed"),
      "true",
      "a bot that never chose opens on All, not on the pill another bot kept",
    )
    assert.deepEqual(rowIds().sort(), ["other-chat", "other-room"], "and lists every row it holds")
  })
  // And the pill the first bot kept is still its own, with nothing on it taken by the second.
  await mount(screen(), async () => {
    await until(async () => rowIds().length === 1, "the first bot's list, on its own pill")
    assert.deepEqual(rowIds(), ["planning"], "the rows the first bot kept")
  })
})

test("a pill saved beside another write of the settings row survives it", async () => {
  await seed([{ id: "planning", title: "Planning", at: 150, room: true }])
  // The row is put whole, so a save that read it before the pill landed would restore the map it saw:
  // the pill's own write and the row's are both transactions, and the later one keeps both fields.
  let lost = 0
  for (let i = 0; i < 20; i += 1) {
    await Promise.all([saveChatFilter(bot.id, "rooms"), saveSettings({ appearanceAt: i + 1 })])
    if ((await getSettings()).chatFilters?.[bot.id] !== "rooms") lost += 1
  }
  assert.equal(lost, 0, "no pill is lost to a save of the switches beside it")
})
