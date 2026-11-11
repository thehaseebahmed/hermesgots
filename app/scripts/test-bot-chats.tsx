/**
 * A bot's screen is the list of its chats: `/b/<bot>` draws them, flat — its pinned ones first and the
 * rest by what was last said — each a row with a chat's icon, its title, its last line, its age and the
 * dot this device's read mark decides, and a reply that waits on the reader marked on its row. The
 * header's title is the way to the bot's settings, the search floats at the foot's left and narrows
 * the rows to what it finds in a title or a line, and one button at the foot's right starts a chat or
 * a room. `scripts/test-chat-list.mjs` holds the rules (the order, the row's shape, the search); this
 * holds the screen they are drawn by.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { act } from "react"
import { MemoryRouter, Route, Routes } from "react-router"

import { BotChatsPage } from "@/routes/bot-chats"
import { BOT_CHATS } from "@/lib/chat-list"
import { db, deleteConversation, type Message } from "@/lib/db"
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
  missing,
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
  /** The reader's own message, newest of all: a row still says what the bot said above it. */
  mine?: string
  /** The newest reply is still arriving, so the row has a run in flight to draw. */
  streaming?: boolean
  /** The run a routine's delivery is: the marker and the line the record itself carries (G4). */
  routine?: { line: string }
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
      ...(one.routine ? { routine: true, line: one.routine.line } : {}),
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
  rowOf(id)?.querySelector("svg.lucide-timer, svg.lucide-message-circle, svg.lucide-circle-alert")
/** The disc a row's icon stands in, which is where a list picks its tone. */
const discOf = (id: string) => rowOf(id)?.querySelector('[data-slot="row-mark"] span.rounded-full')

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

test("a routine's delivery is a row of its own, with the routine's icon and the record's line", async () => {
  // A run has no message on this device at all: the row's line and time are the record's, which is why
  // a device that never opened the run still draws it (G4).
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
    await until(async () => rowIds().length === 2, "the bot's chats")
    const words = wordsOf(rowOf("routine-job-1-cron_9"))
    assert.ok(words.includes("Morning watch"), "the row names the routine")
    assert.ok(
      words.includes("The tide turns at 06:40"),
      "its line is the delivery's first words, read from the record",
    )
    assert.ok(
      words.length > "Morning watch The tide turns at 06:40".length,
      "and its age comes from the record's own clock",
    )
    assert.ok(
      iconOf("routine-job-1-cron_9")?.classList.contains("lucide-timer"),
      "the row wears the routine's icon",
    )
    assert.ok(
      iconOf("chat")?.classList.contains("lucide-message-circle"),
      "while a chat's row keeps the chat's",
    )
    assert.equal(
      rowOf("routine-job-1-cron_9")?.querySelector("[data-waiting]"),
      null,
      "a run waits on nobody: nothing can be answered in it",
    )
  })
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

test("a row deleted here is not resurrected by a record written ahead of this device's clock", async () => {
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
  await mount(screen(), async () => {
    await until(async () => Boolean(rowOf("routine-job-1-cron_9")), "the run's row")
  })
  await deleteConversation("routine-job-1-cron_9")
  const tombstone = await db.tombstones.get("chat:routine-job-1-cron_9")
  assert.ok(tombstone, "its deletion is named for the other devices")
  assert.ok(
    tombstone!.deletedAt > ahead,
    "and stamped past the record it kills, which is the only clock the merge compares",
  )
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
      1,
      "the drawer alone: no '...' and no list control, and the search has left for the foot",
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
    assert.ok(!made.main, "a plain chat: nothing makes a Main any more (G1)")
  })
  await mount(screen(), async () => {
    await until(async () => Boolean(find("[data-new-menu]")), "the button")
    await click(find("[data-new-menu]"))
    await until(async () => picksOpen(), "the picks")
    await click(newRow("New room"))
    await until(async () => path() === "/new-room", "the room screen")
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
